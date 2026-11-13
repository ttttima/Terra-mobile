// Terra's "main process" on the phone: what main.ts does on the desktop
// (tabs, navigation, the question bar, menus, permissions, passwords,
// settings), running in the UI page itself. The Android app (host.ts)
// only hosts the web pages and does what needs the system; this decides.
//
// The UI talks to it through the same window.browser / window.terra API as
// on the desktop (api.ts), so the shared UI modules work unchanged.
import {
  DEFAULT_SETTINGS,
  GLASS_COLORS,
  SEARCH_ENGINES,
  THEMES,
  activeTint,
  mixHex,
  themeBackground,
  type BrowserState,
  type DefaultBrowserState,
  type DownloadAction,
  type DownloadInfo,
  type GlassColors,
  type Notice,
  type PageSecurity,
  type PanelPage,
  type PermissionDecision,
  type SavedLogin,
  type SearchEngine,
  type Settings,
  type Suggestion,
  type TabInfo,
  type TabsState,
  type Theme,
  TINT_AMOUNT,
} from '../shared';
import { localSuggestions, remoteSuggestUrl } from '../suggest-local';
import * as data from './data';
import { call, inApp, onHost, post } from './host';

// ---------------------------------------------------------------- to the UI

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Listener[]>();

/** The UI listens here (api.ts), like ipcRenderer.on on the desktop. */
export function onBrain(channel: string, listener: Listener) {
  listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
}

/** Like webContents.send: delivered after the current task, in order. */
function sendToUi(channel: string, payload: unknown) {
  queueMicrotask(() => {
    for (const listener of listeners.get(channel) ?? []) listener(payload);
  });
}

// ---------------------------------------------------------------- settings

/** The phone's defaults: swiping the address bar through tabs is on. */
const PHONE_DEFAULTS: Settings = { ...DEFAULT_SETTINGS, scrollTabs: true };
let settings: Settings = { ...PHONE_DEFAULTS };

/** Never trust values from disk or the UI. */
function sanitizeSettings(value: Partial<Settings>): Settings {
  const engine = value.searchEngine;
  const homePageText =
    typeof value.homePage === 'string' ? value.homePage.trim() : '';
  const homePage = homePageText ? toUrl(homePageText, false) : '';
  const color = (text: unknown) =>
    typeof text === 'string' && /^#[0-9a-f]{6}$/i.test(text)
      ? text.toLowerCase()
      : null;
  return {
    ...PHONE_DEFAULTS,
    searchEngine:
      typeof engine === 'string' && engine in SEARCH_ENGINES
        ? (engine as SearchEngine)
        : PHONE_DEFAULTS.searchEngine,
    homePage: homePage ?? '',
    showDividers: value.showDividers !== false,
    smoothDividers: value.smoothDividers === true,
    forceDark: value.forceDark === true,
    scrollTabs: value.scrollTabs !== false,
    theme: THEMES.includes(value.theme as Theme)
      ? (value.theme as Theme)
      : PHONE_DEFAULTS.theme,
    accentColor: color(value.accentColor) ?? PHONE_DEFAULTS.accentColor,
    liquidGlass: value.liquidGlass === true,
    // "Behind the window" shows the desktop: there is none on a phone.
    glassColors:
      GLASS_COLORS.includes(value.glassColors as GlassColors) &&
      value.glassColors !== 'behind'
        ? (value.glassColors as GlassColors)
        : 'accent',
    backgroundTint:
      value.backgroundTint === 'accent'
        ? 'accent'
        : (color(value.backgroundTint) ?? ''),
    startup: value.startup === 'newTab' ? 'newTab' : 'restore',
    searchSuggestions: value.searchSuggestions === true,
    blockAds: value.blockAds !== false,
    offerPasswords: value.offerPasswords !== false,
    clearOnExit: value.clearOnExit === true,
    autoUpdate: value.autoUpdate !== false,
  };
}

function loadSettings() {
  const saved = data.readJson('settings.json');
  settings = sanitizeSettings({
    ...PHONE_DEFAULTS,
    ...(saved && typeof saved === 'object' ? saved : {}),
  });
}

function saveSettings() {
  data.saveSoon('settings.json', () => settings);
}

/** --panel for each color mode (index.css), for the app's own background. */
const THEME_PANELS: Record<Theme, string> = {
  dark: '#191c23',
  light: '#ffffff',
  oled: '#000000',
};

/** What the Android app needs to know about the settings. */
function sendConfig() {
  const tint = activeTint(settings);
  const panel = tint
    ? mixHex(THEME_PANELS[settings.theme], tint, TINT_AMOUNT[settings.theme])
    : THEME_PANELS[settings.theme];
  post('config', {
    theme: settings.theme,
    panel,
    background: themeBackground(settings),
    forceDark: settings.forceDark,
    blockAds: settings.blockAds,
    allowAds: data.adsAllowedOrigins(),
    pageColors: pageColorsWanted(),
    pageEdges: settings.showDividers && settings.smoothDividers,
  });
}

function sendSettings() {
  sendToUi('browser:settings', settings);
}

export function updateSettings(changes: Partial<Settings>) {
  const wasDark = darkPages();
  settings = sanitizeSettings({ ...settings, ...changes });
  saveSettings();
  sendSettings();
  sendConfig();
  if ('searchEngine' in changes) sendState();
  if (darkPages() !== wasDark) remakePages();
}

/** Web pages see a dark color scheme (Terra's color mode, or forced). */
const darkPages = () => settings.forceDark || settings.theme !== 'light';

/**
 * Android fixes a page's color scheme when its view is made, so after the
 * color mode changes the open pages are made again (the open tab reloads
 * now, the others when they're next opened).
 */
function remakePages() {
  for (const tab of tabs) {
    if (!tab.live) continue;
    tab.lazyUrl = shownUrl(tab) || null;
    tab.live = false;
    tab.loading = false;
    post('tab.close', { id: tab.id });
    if (!tab.lazyUrl) tab.isNewTab = true;
  }
  shownPage = undefined;
  const active = activeTab();
  if (active?.lazyUrl) load(active, active.lazyUrl);
  updatePage();
  sendTabs();
  sendState();
}

const pageColorsWanted = () =>
  settings.liquidGlass &&
  settings.glassColors === 'page' &&
  settings.theme !== 'oled';

// ---------------------------------------------------------------- addresses

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

/**
 * Turns whatever the user typed into a URL to load. Text that isn't a URL
 * becomes a search, unless allowSearch is false.
 */
function toUrl(input: string, allowSearch = true): string | null {
  const value = input.trim();
  if (!value) return null;
  let candidate: string;
  if (isWebUrl(value)) {
    candidate = value;
  } else if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(value)) {
    candidate = `http://${value}`;
  } else if (/^[^\s.]+\.[^\s]+$/.test(value)) {
    candidate = `https://${value}`;
  } else {
    return allowSearch ? searchUrl(value) : null;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    // Not a valid URL (e.g. "https://"): search for it instead.
  }
  return allowSearch ? searchUrl(value) : null;
}

function searchUrl(text: string) {
  return SEARCH_ENGINES[settings.searchEngine].url + encodeURIComponent(text);
}

function securityOf(url: string): PageSecurity {
  if (/^https:/i.test(url)) return 'secure';
  if (/^http:/i.test(url)) return 'insecure';
  return 'none';
}

/** "example.com" for "https://www.example.com". */
function hostLabel(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- tabs

interface Tab {
  id: number;
  title: string;
  url: string;
  favicon: string | null;
  /** True until the first website loads: the clean search page shows. */
  isNewTab: boolean;
  historyId: string | null;
  pinned: boolean;
  audible: boolean;
  muted: boolean;
  isPrivate: boolean;
  /** Not loaded yet (restored, or put to sleep to save memory). */
  lazyUrl: string | null;
  /** The app has a web page for it. */
  live: boolean;
  loading: boolean;
  progress: number;
  canGoBack: boolean;
  canGoForward: boolean;
  /** "Desktop site": asks websites for their computer layout. */
  desktop: boolean;
  /** The tab a link or popup opened it from: Back returns there. */
  openerId: number | null;
  lastUsed: number;
}

/** The phone's state for the address bar: the desktop's plus a bit. */
export interface PhoneState extends BrowserState {
  desktop: boolean;
  progress: number;
}

const MAX_CLOSED_TABS = 25;
/** Web pages kept in memory besides the open one; older ones sleep. */
const MAX_LIVE_TABS = 6;

let tabs: Tab[] = [];
let activeTabId: number | null = null;
let nextTabId = 1;
let closedTabUrls: string[] = [];
let settingsOpen = false;
let htmlFullScreen = false;
const privateDecisions = new Map<string, PermissionDecision>();

const findTab = (id: number) => tabs.find((tab) => tab.id === id);
const activeTab = () =>
  activeTabId === null ? null : (findTab(activeTabId) ?? null);

function shownUrl(tab: Tab) {
  if (tab.isNewTab) return '';
  if (tab.lazyUrl) return tab.lazyUrl;
  return tab.url;
}

function tabTitle(tab: Tab) {
  if (tab.isNewTab) return tab.isPrivate ? 'Private tab' : 'New tab';
  if (tab.title) return tab.title;
  return hostLabel(shownUrl(tab)) || 'New tab';
}

function sendTabs() {
  const payload: TabsState = {
    tabs: tabs.map(
      (tab): TabInfo => ({
        id: tab.id,
        title: tabTitle(tab),
        url: shownUrl(tab),
        favicon: tab.favicon,
        loading: tab.loading,
        isNewTab: tab.isNewTab,
        pinned: tab.pinned,
        audible: tab.audible,
        muted: tab.muted,
        isPrivate: tab.isPrivate,
      }),
    ),
    activeTabId,
    sidebarCollapsed: false,
    fullScreen: htmlFullScreen,
    settingsOpen,
  };
  sendToUi('browser:tabs', payload);
  persistSession();
}

/** Remembers the open tabs (not private ones) for the next start. */
function persistSession() {
  const saved = tabs.filter((tab) => !tab.isPrivate && !tab.isNewTab);
  const active = saved.findIndex((tab) => tab.id === activeTabId);
  data.saveSession({
    tabs: saved
      .map((tab) => ({
        url: shownUrl(tab),
        title: tabTitle(tab),
        pinned: tab.pinned,
      }))
      .filter((tab) => isWebUrl(tab.url)),
    active: Math.max(0, active),
  });
}

function sendState() {
  const tab = activeTab();
  if (!tab) return;
  const url = shownUrl(tab);
  const state: PhoneState = {
    url,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    loading: tab.loading,
    zoom: 100,
    security: securityOf(url),
    bookmarked: data.isBookmarked(url),
    isPrivate: tab.isPrivate,
    desktop: tab.desktop,
    progress: tab.progress,
  };
  sendToUi('browser:state', state);
}

/**
 * Whether the active tab's web page shows: not on the new tab page (our
 * UI draws that), in settings, or before a sleeping tab has loaded.
 */
function pageShouldShow(tab: Tab | null): tab is Tab {
  return !!tab && tab.live && !tab.isNewTab && !tab.lazyUrl && !settingsOpen;
}

let shownPage: number | null | undefined;

function updatePage() {
  const tab = activeTab();
  const id = pageShouldShow(tab) ? tab.id : null;
  sendToUi('terra:page-visible', id !== null);
  if (id === shownPage) return;
  shownPage = id;
  post('tab.show', { id });
}

/** Loads an address in a tab, making its web page if it has none yet. */
function load(tab: Tab, url: string) {
  tab.live = true;
  tab.lazyUrl = null;
  tab.lastUsed = Date.now();
  tab.loading = true;
  post('tab.load', {
    id: tab.id,
    url,
    private: tab.isPrivate,
    desktop: tab.desktop,
  });
}

/** Opens a tab. With no URL it shows the clean search page. */
function createTab(
  url: string | null,
  options: {
    activate?: boolean;
    nextToActive?: boolean;
    atTop?: boolean;
    isPrivate?: boolean;
    pinned?: boolean;
    lazyTitle?: string;
    id?: number;
    openerId?: number | null;
    /** Goes right after this tab (a popup after the page that opened it). */
    afterId?: number;
  } = {},
) {
  const { activate = true, nextToActive = false } = options;
  const tab: Tab = {
    id: options.id ?? nextTabId++,
    title: options.lazyTitle ?? '',
    url: url ?? '',
    favicon: null,
    isNewTab: !url && options.id === undefined,
    historyId: null,
    pinned: options.pinned === true,
    audible: false,
    muted: false,
    isPrivate: options.isPrivate === true,
    lazyUrl: options.lazyTitle !== undefined ? url : null,
    live: options.id !== undefined,
    loading: options.id !== undefined,
    progress: 0,
    canGoBack: false,
    canGoForward: false,
    desktop: false,
    openerId: options.openerId ?? null,
    lastUsed: Date.now(),
  };
  const activeIndex = tabs.findIndex(
    (t) => t.id === (options.afterId ?? activeTabId),
  );
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  if (tab.pinned || options.atTop) {
    tabs.splice(pinnedCount, 0, tab);
  } else if ((nextToActive || options.afterId) && activeIndex !== -1) {
    tabs.splice(Math.max(pinnedCount, activeIndex + 1), 0, tab);
  } else {
    tabs.push(tab);
  }
  if (url && !tab.lazyUrl && !tab.live) {
    load(tab, url);
  }
  if (activate) activateTab(tab.id);
  else sendTabs();
  return tab;
}

/**
 * Puts the least recently used pages to sleep so the phone keeps up: all
 * but the newest `keep` (none when Android is short of memory).
 */
function sleepOldTabs(keep = MAX_LIVE_TABS) {
  const awake = tabs
    .filter((t) => t.live && t.id !== activeTabId && !t.audible)
    .sort((a, b) => b.lastUsed - a.lastUsed);
  for (const tab of awake.slice(keep)) {
    tab.lazyUrl = shownUrl(tab) || null;
    tab.live = false;
    tab.loading = false;
    post('tab.close', { id: tab.id });
    if (!tab.lazyUrl) tab.isNewTab = true;
  }
}

function activateTab(id: number) {
  const tab = findTab(id);
  if (!tab) return;
  if (activeTabId !== id) sendToUi('terra:find-close', null);
  activeTabId = id;
  settingsOpen = false;
  tab.lastUsed = Date.now();
  if (tab.lazyUrl) load(tab, tab.lazyUrl);
  sleepOldTabs();
  sendNotice();
  updatePage();
  sendTabs();
  sendState();
  if (tab.isNewTab) focusAddressBar();
}

export function closeTab(id: number) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return;
  const [tab] = tabs.splice(index, 1);
  dropNotices(tab.id);
  const url = shownUrl(tab);
  if (isWebUrl(url) && !tab.isPrivate) {
    closedTabUrls.push(url);
    closedTabUrls = closedTabUrls.slice(-MAX_CLOSED_TABS);
  }
  if (tab.live) post('tab.close', { id });
  if (tab.isPrivate && !tabs.some((t) => t.isPrivate)) {
    post('private.clear');
    privateDecisions.clear();
  }
  if (shownPage === id) shownPage = undefined;

  if (tabs.length === 0) {
    // A phone browser never closes itself: start over with a new tab.
    activeTabId = null;
    createTab(settings.homePage || null);
    return;
  }
  if (activeTabId === id) {
    const opener = tab.openerId !== null ? findTab(tab.openerId) : undefined;
    activateTab(opener?.id ?? tabs[Math.min(index, tabs.length - 1)].id);
  } else {
    sendTabs();
  }
}

function moveTab(id: number, toIndex: number) {
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from === -1) return;
  const [tab] = tabs.splice(from, 1);
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  const [min, max] = tab.pinned ? [0, pinnedCount] : [pinnedCount, tabs.length];
  const target = Math.max(
    min,
    Math.min(max, from < toIndex ? toIndex - 1 : toIndex),
  );
  tabs.splice(target, 0, tab);
  sendTabs();
}

function togglePin(id: number) {
  const tab = findTab(id);
  if (!tab) return;
  tabs.splice(tabs.indexOf(tab), 1);
  tab.pinned = !tab.pinned;
  const pinnedCount = tabs.filter((t) => t.pinned).length;
  tabs.splice(pinnedCount, 0, tab);
  sendTabs();
}

function toggleMute(id: number) {
  const tab = findTab(id);
  if (!tab) return;
  tab.muted = !tab.muted;
  if (tab.live) post('tab.mute', { id, on: tab.muted });
  sendTabs();
}

function duplicateTab(id: number) {
  const tab = findTab(id);
  const url = tab ? shownUrl(tab) : '';
  if (!tab || !url) return;
  createTab(url, { nextToActive: true, isPrivate: tab.isPrivate });
}

export function newTab() {
  createTab(settings.homePage || null);
  focusAddressBar();
}

export function newPrivateTab() {
  createTab(null, { isPrivate: true });
  focusAddressBar();
}

function reopenClosedTab() {
  const url = closedTabUrls.pop();
  if (url) createTab(url);
}

/** The new tab page that swiping past the first tab opened. */
let scrolledNewTabId: number | null = null;

/**
 * "Swipe through tabs": one swipe along the address bar (-1 back, 1 on).
 * Past the first tab a fresh new tab page opens at the top; swiping on
 * without using it tidies it away again, like the desktop's wheel.
 */
function scrollTabs(step: number) {
  const index = tabs.findIndex((t) => t.id === activeTabId);
  const current = tabs[index];
  if (!current) return;
  if (step < 0 && index === 0) {
    if (current.isNewTab) return;
    const tab = createTab(null, { atTop: true });
    scrolledNewTabId = tab.id;
    return;
  }
  const next = tabs[index + step];
  if (!next) return;
  activateTab(next.id);
  if (current.id === scrolledNewTabId) {
    scrolledNewTabId = null;
    if (current.isNewTab) closeTab(current.id);
  }
}

/** While starting: no keyboard popping up before anyone asked. */
let starting = false;

function focusAddressBar() {
  if (starting) return;
  sendToUi('browser:focus-address', null);
}

// ---------------------------------------------------------------- actions

export function navigate(input: string) {
  const url = toUrl(input);
  if (!url) return;
  const tab = activeTab();
  if (!tab) {
    createTab(url);
    return;
  }
  settingsOpen = false;
  load(tab, url);
  if (tab.isNewTab) {
    tab.isNewTab = false;
    tab.url = url;
  }
  updatePage();
  sendTabs();
  sendState();
}

function goBack() {
  const tab = activeTab();
  if (tab?.canGoBack) post('tab.back', { id: tab.id });
}

function goForward() {
  const tab = activeTab();
  if (tab?.canGoForward) post('tab.forward', { id: tab.id });
}

function reload() {
  const tab = activeTab();
  if (!tab || tab.isNewTab) return;
  if (!tab.live) load(tab, shownUrl(tab));
  else post('tab.reload', { id: tab.id });
}

function stop() {
  const tab = activeTab();
  if (tab?.live) post('tab.stop', { id: tab.id });
}

/**
 * Android's Back: back in the page, else back to the tab that opened this
 * one (closing it), else Terra goes to the background.
 */
export function systemBack() {
  const tab = activeTab();
  if (settingsOpen) return setSettingsOpen(false);
  if (tab?.canGoBack && pageShouldShow(tab)) return goBack();
  if (tab && tab.openerId !== null && findTab(tab.openerId)) {
    return closeTab(tab.id);
  }
  if (tab && tab.id === scrolledNewTabId && tabs.length > 1) {
    return closeTab(tab.id);
  }
  post('app.minimize');
}

function toggleDesktop() {
  const tab = activeTab();
  if (!tab || tab.isNewTab) return;
  tab.desktop = !tab.desktop;
  if (tab.live) post('tab.desktop', { id: tab.id, on: tab.desktop });
  sendState();
}

function openFind() {
  const tab = activeTab();
  if (!pageShouldShow(tab)) return;
  sendToUi('terra:find-open', null);
}

function toggleBookmarkFor(tab: Tab | null) {
  const url = tab ? shownUrl(tab) : '';
  if (!tab || !isWebUrl(url)) return;
  data.toggleBookmark(url, tabTitle(tab), tab.isPrivate ? null : tab.favicon);
  sendState();
}

function openBookmark(id: string, inNewTab: boolean) {
  const bookmark = data.getBookmarks().find((b) => b.id === id);
  if (!bookmark) return;
  if (!inNewTab) {
    const open = tabs.find((t) => !t.isPrivate && shownUrl(t) === bookmark.url);
    if (open) {
      activateTab(open.id);
      return;
    }
    const active = activeTab();
    if (active?.isNewTab && !active.isPrivate) {
      setSettingsOpen(false);
      navigate(bookmark.url);
      return;
    }
  }
  createTab(bookmark.url, { activate: !inNewTab, nextToActive: inNewTab });
}

/** A link from History, Bookmarks...: here if on a new tab page, else a new tab. */
function openUrl(url: string) {
  const target = toUrl(url, false);
  if (!target) return;
  setSettingsOpen(false);
  const active = activeTab();
  if (active?.isNewTab && !active.isPrivate) navigate(target);
  else createTab(target);
}

function share(tab: Tab | null) {
  const url = tab ? shownUrl(tab) : '';
  if (tab && isWebUrl(url)) post('share', { url, title: tabTitle(tab) });
}

export function setSettingsOpen(open: boolean) {
  if (settingsOpen === open) return;
  settingsOpen = open;
  updatePage();
  sendTabs();
  sendSettings();
  if (!open && activeTab()?.isNewTab) focusAddressBar();
}

/** Opens the settings panel on one page (e.g. History). */
export function showPanelPage(page: PanelPage) {
  setSettingsOpen(true);
  sendToUi('browser:show-page', page);
}

// ---------------------------------------------------------------- menus

/** One line in a menu; shown by the UI as a sheet from the bottom. */
export interface MenuItem {
  id: number;
  kind: 'normal' | 'checkbox' | 'separator' | 'header' | 'icons';
  label?: string;
  /** Icon name (see ui-sheet.ts). */
  icon?: string;
  enabled?: boolean;
  checked?: boolean;
  /** Stays open when chosen (the menu is sent again, updated). */
  keepOpen?: boolean;
  submenu?: MenuItem[];
  /** Icons row: its buttons. */
  items?: MenuItem[];
}

export interface MenuTemplate {
  kind?: MenuItem['kind'];
  label?: string;
  icon?: string;
  enabled?: boolean;
  checked?: boolean;
  keepOpen?: boolean;
  submenu?: MenuTemplate[];
  items?: MenuTemplate[];
  click?: () => void;
}

const menuActions = new Map<number, () => void>();
let nextMenuId = 1;
/** The open menu: rebuilt after a keepOpen choice. */
let menuBuilder: (() => MenuTemplate[]) | null = null;

function toItems(template: MenuTemplate[]): MenuItem[] {
  return template.map((entry) => {
    const id = nextMenuId++;
    if (entry.click) menuActions.set(id, entry.click);
    return {
      id,
      kind: entry.kind ?? (entry.checked !== undefined ? 'checkbox' : 'normal'),
      label: entry.label,
      icon: entry.icon,
      enabled: entry.enabled !== false,
      checked: entry.checked,
      keepOpen: entry.keepOpen,
      submenu: entry.submenu ? toItems(entry.submenu) : undefined,
      items: entry.items ? toItems(entry.items) : undefined,
    };
  });
}

/** Shows a menu; `build` runs again to refresh it after keepOpen choices. */
function popupMenu(build: () => MenuTemplate[], title?: string) {
  menuActions.clear();
  menuBuilder = build;
  sendToUi('terra:menu', { title, items: toItems(build()) });
}

function pickMenu(id: number, keepOpen: boolean) {
  const action = menuActions.get(id);
  if (!keepOpen) {
    menuActions.clear();
    menuBuilder = null;
  }
  action?.();
  if (keepOpen && menuBuilder) {
    const build = menuBuilder;
    // After the action's own updates have gone out.
    queueMicrotask(() => {
      if (menuBuilder !== build) return;
      menuActions.clear();
      sendToUi('terra:menu-update', { items: toItems(build()) });
    });
  }
}

/** The ⋮ button. */
function showMainMenu() {
  popupMenu(() => {
    const tab = activeTab();
    const onPage = pageShouldShow(tab);
    const url = tab ? shownUrl(tab) : '';
    return [
      {
        kind: 'icons',
        items: [
          {
            label: 'Back',
            icon: 'back',
            enabled: !!tab?.canGoBack && onPage,
            click: goBack,
          },
          {
            label: 'Forward',
            icon: 'forward',
            enabled: !!tab?.canGoForward && onPage,
            click: goForward,
          },
          {
            label: data.isBookmarked(url) ? 'Remove bookmark' : 'Bookmark',
            icon: 'star',
            checked: data.isBookmarked(url),
            enabled: isWebUrl(url),
            keepOpen: true,
            click: () => toggleBookmarkFor(tab),
          },
          {
            label: tab?.loading ? 'Stop' : 'Refresh',
            icon: tab?.loading ? 'stop' : 'reload',
            enabled: onPage,
            click: tab?.loading ? stop : reload,
          },
          {
            label: 'Share',
            icon: 'share',
            enabled: isWebUrl(url),
            click: () => share(tab),
          },
        ],
      },
      { label: 'New tab', icon: 'plus', click: newTab },
      { label: 'New private tab', icon: 'eyeOff', click: newPrivateTab },
      { kind: 'separator' },
      {
        label: 'Bookmarks',
        icon: 'bookmark',
        click: () => showPanelPage('bookmarks'),
      },
      {
        label: 'History',
        icon: 'clock',
        click: () => showPanelPage('history'),
      },
      {
        label: 'Downloads',
        icon: 'download',
        click: () => showPanelPage('downloads'),
      },
      { kind: 'separator' },
      {
        label: 'Find on page',
        icon: 'search',
        enabled: onPage,
        click: openFind,
      },
      {
        label: 'Desktop site',
        icon: 'monitor',
        checked: !!tab?.desktop,
        enabled: !!tab && !tab.isNewTab,
        click: toggleDesktop,
      },
      { kind: 'separator' },
      {
        label: 'Settings',
        icon: 'settings',
        click: () => showPanelPage(lastSettingsPage),
      },
    ];
  });
}

let lastSettingsPage: PanelPage = 'appearance';

function showTabMenu(id: number) {
  const tab = findTab(id);
  if (!tab) return;
  popupMenu(() => {
    const index = tabs.indexOf(tab);
    const url = shownUrl(tab);
    const closeAll = (ids: number[]) => ids.forEach((tabId) => closeTab(tabId));
    return [
      { kind: 'header', label: tabTitle(tab) },
      { label: 'New tab', icon: 'plus', click: newTab },
      {
        label: 'Refresh',
        icon: 'reload',
        enabled: !tab.isNewTab,
        click: () =>
          tab.live ? post('tab.reload', { id }) : load(tab, shownUrl(tab)),
      },
      {
        label: 'Duplicate',
        icon: 'copy',
        enabled: !!url,
        click: () => duplicateTab(id),
      },
      {
        label: tab.pinned ? 'Unpin' : 'Pin',
        icon: 'pin',
        click: () => togglePin(id),
      },
      {
        label: tab.muted ? 'Unmute tab' : 'Mute tab',
        icon: tab.muted ? 'speaker' : 'speakerOff',
        click: () => toggleMute(id),
      },
      {
        label: data.isBookmarked(url) ? 'Remove bookmark' : 'Bookmark',
        icon: 'star',
        enabled: isWebUrl(url),
        click: () => toggleBookmarkFor(tab),
      },
      { kind: 'separator' },
      { label: 'Close', icon: 'remove', click: () => closeTab(id) },
      {
        label: 'Close other tabs',
        enabled: tabs.some((t) => t.id !== id && !t.pinned),
        click: () =>
          closeAll(
            tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id),
          ),
      },
      {
        label: 'Close tabs below',
        enabled: index < tabs.length - 1,
        click: () => closeAll(tabs.slice(index + 1).map((t) => t.id)),
      },
      { kind: 'separator' },
      {
        label: 'Reopen closed tab',
        icon: 'retry',
        enabled: closedTabUrls.length > 0,
        click: reopenClosedTab,
      },
    ];
  });
}

/** The lock in the address bar: about this site. */
function showSiteMenu() {
  const tab = activeTab();
  if (!tab || !pageShouldShow(tab)) return;
  popupMenu(() => {
    const url = shownUrl(tab);
    const origin = data.originOf(url);
    const security = securityOf(url);
    const items: MenuTemplate[] = [
      {
        kind: 'header',
        label: tab.isPrivate
          ? 'Private tab: nothing here is remembered'
          : security === 'secure'
            ? 'Connection is secure'
            : security === 'insecure'
              ? 'Connection is not secure'
              : 'Terra page',
      },
    ];
    if (origin) {
      items.push(
        {
          label: 'Block ads and trackers here',
          icon: 'shield',
          enabled: settings.blockAds,
          checked: settings.blockAds && !data.adsAllowed(origin),
          click: () => {
            data.setAdsAllowed(origin, !data.adsAllowed(origin));
            sendConfig();
            post('tab.reload', { id: tab.id });
          },
        },
        {
          label: 'Delete cookies and data for this site',
          icon: 'trash',
          click: () => {
            post('site.clear', { origin });
            post('tab.reload', { id: tab.id });
          },
        },
        {
          label: 'Site permissions…',
          icon: 'settings',
          click: () => showPanelPage('privacy'),
        },
      );
    }
    return items;
  });
}

function showBookmarkMenu(id: string) {
  const bookmark = data.getBookmarks().find((b) => b.id === id);
  if (!bookmark) return;
  popupMenu(() => [
    { kind: 'header', label: bookmark.title || hostLabel(bookmark.url) },
    { label: 'Open', icon: 'globe', click: () => openBookmark(id, false) },
    {
      label: 'Open in new tab',
      icon: 'plus',
      click: () => openBookmark(id, true),
    },
    {
      label: 'Open in private tab',
      icon: 'eyeOff',
      click: () => createTab(bookmark.url, { isPrivate: true }),
    },
    { kind: 'separator' },
    {
      label: 'Move to folder',
      icon: 'folder',
      enabled: data.getFolders().length > 0,
      submenu: [
        {
          label: 'No folder',
          checked: !bookmark.folderId,
          click: () => data.moveBookmark(id, null),
        },
        ...data.getFolders().map((folder) => ({
          label: folder.title,
          checked: bookmark.folderId === folder.id,
          click: () => data.moveBookmark(id, folder.id),
        })),
      ],
    },
    {
      label: 'Remove bookmark',
      icon: 'remove',
      click: () => data.removeBookmark(id),
    },
    { kind: 'separator' },
    {
      label: 'All bookmarks',
      icon: 'list',
      click: () => showPanelPage('bookmarks'),
    },
  ]);
}

/** Long press on a link or picture in a page. */
function showPageMenu(tab: Tab, link: string, image: string) {
  const opener =
    (url: string, background: boolean, isPrivate = false) =>
    () =>
      createTab(url, {
        activate: !background,
        nextToActive: true,
        isPrivate: isPrivate || tab.isPrivate,
        openerId: background ? null : tab.id,
      });
  popupMenu(() => {
    const items: MenuTemplate[] = [];
    if (link) {
      items.push(
        { kind: 'header', label: link },
        {
          label: 'Open in new tab',
          icon: 'plus',
          click: opener(link, true),
        },
        {
          label: 'Open in private tab',
          icon: 'eyeOff',
          enabled: !tab.isPrivate,
          click: opener(link, false, true),
        },
        {
          label: 'Copy link address',
          icon: 'copy',
          click: () => post('clipboard', { text: link }),
        },
        {
          label: 'Share link',
          icon: 'share',
          click: () => post('share', { url: link, title: '' }),
        },
        {
          label: 'Download link',
          icon: 'download',
          click: () =>
            post('download.url', {
              url: link,
              page: shownUrl(tab),
              private: tab.isPrivate,
            }),
        },
      );
    }
    if (image) {
      if (link) items.push({ kind: 'separator' });
      else items.push({ kind: 'header', label: image });
      items.push(
        {
          label: 'Open image in new tab',
          icon: 'image',
          click: opener(image, false),
        },
        {
          label: 'Download image',
          icon: 'download',
          click: () =>
            post('download.url', {
              url: image,
              page: shownUrl(tab),
              private: tab.isPrivate,
            }),
        },
        {
          label: 'Copy image address',
          icon: 'copy',
          click: () => post('clipboard', { text: image }),
        },
      );
    }
    return items;
  });
}

// ---------------------------------------------------------------- questions

interface NoticeResponse {
  action: string | null;
  fields: Record<string, string>;
  choice: string;
}

interface PendingNotice extends Notice {
  kind: string;
  keepOnNavigate: boolean;
  resolve: (response: NoticeResponse) => void;
}

const NO_ANSWER: NoticeResponse = { action: null, fields: {}, choice: '' };
let notices: PendingNotice[] = [];
let nextNoticeId = 1;

/** Shows a question above the toolbar and waits for the answer. */
function ask(
  notice: Omit<Notice, 'id'> & { kind: string },
  keepOnNavigate = false,
): Promise<NoticeResponse> {
  for (const old of notices.filter(
    (n) => n.kind === notice.kind && n.tabId === notice.tabId,
  )) {
    answerNotice(old.id, NO_ANSWER);
  }
  return new Promise((resolve) => {
    notices.push({ ...notice, id: nextNoticeId++, keepOnNavigate, resolve });
    sendNotice();
  });
}

const visibleNotice = () =>
  notices.find((n) => n.tabId === null || n.tabId === activeTabId) ?? null;

function sendNotice() {
  const notice = visibleNotice();
  sendToUi(
    'terra:notice',
    notice
      ? {
          id: notice.id,
          tabId: notice.tabId,
          text: notice.text,
          fields: notice.fields,
          choices: notice.choices,
          actions: notice.actions,
        }
      : null,
  );
}

function answerNotice(id: number, response: NoticeResponse) {
  const index = notices.findIndex((n) => n.id === id);
  if (index === -1) return;
  const [notice] = notices.splice(index, 1);
  notice.resolve(response);
  sendNotice();
}

function dropNotices(tabId: number, navigation = false) {
  for (const notice of notices.filter(
    (n) => n.tabId === tabId && !(navigation && n.keepOnNavigate),
  )) {
    answerNotice(notice.id, NO_ANSWER);
  }
}

// ---------------------------------------------------------------- permissions

const PERMISSION_PHRASES: Record<string, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  midi: 'use your MIDI devices',
};

function decisionFor(isPrivate: boolean, origin: string, name: string) {
  return (
    (isPrivate ? privateDecisions.get(`${origin} ${name}`) : undefined) ??
    data.getPermission(origin, name)
  );
}

function rememberDecision(
  isPrivate: boolean,
  origin: string,
  name: string,
  decision: PermissionDecision,
) {
  if (isPrivate) privateDecisions.set(`${origin} ${name}`, decision);
  else data.setPermission(origin, name, decision);
}

function askPermission(
  tab: Tab,
  reqId: number,
  origin: string,
  names: string[],
) {
  const answer = (allow: boolean) =>
    post('permission.answer', { id: reqId, allow });
  if (!origin || !names.length) return answer(false);
  const decisions = names.map((n) => decisionFor(tab.isPrivate, origin, n));
  if (decisions.every((d) => d === 'allow')) return answer(true);
  if (decisions.some((d) => d === 'block')) return answer(false);
  const what = names.map((n) => PERMISSION_PHRASES[n] ?? n).join(' and ');
  void ask({
    kind: `permission:${names.join('+')}`,
    tabId: tab.id,
    text: `${hostLabel(origin)} wants to ${what}`,
    actions: [
      { id: 'allow', label: 'Allow' },
      { id: 'block', label: 'Block' },
    ],
  }).then((response) => {
    if (response.action === 'allow' || response.action === 'block') {
      for (const name of names) {
        rememberDecision(tab.isPrivate, origin, name, response.action);
      }
    }
    answer(response.action === 'allow');
  });
}

/** Links for other apps (spotify:, intent:...): ask first. */
function openOutsideLink(tab: Tab, url: string, scheme: string, app: string) {
  const site = hostLabel(shownUrl(tab)) || 'This page';
  void ask({
    kind: 'external',
    tabId: tab.id,
    text: app
      ? `${site} wants to open ${app}`
      : `${site} wants to open a “${scheme}” link in another app`,
    actions: [
      { id: 'open', label: 'Open app' },
      { id: 'cancel', label: 'Cancel' },
    ],
  }).then((response) => {
    if (response.action === 'open') post('external.open', { url });
  });
}

// ---------------------------------------------------------------- passwords

function offerToSave(
  tab: Tab,
  origin: string,
  username: string,
  token: string,
  update: boolean,
) {
  const site = hostLabel(origin);
  void ask(
    {
      kind: 'save-password',
      tabId: tab.id,
      text: update
        ? `Update the saved password for ${username || 'this login'} on ${site}?`
        : `Save your password for ${site}? It stays encrypted on this phone.`,
      actions: [
        { id: 'save', label: update ? 'Update' : 'Save' },
        { id: 'never', label: 'Never for this site' },
        { id: 'later', label: 'Not now' },
      ],
    },
    true,
  ).then((response) => {
    if (response.action === 'save') post('login.save', { token });
    else if (response.action === 'never') {
      data.setNeverSavePasswords(origin, true);
    }
  });
}

function offerToFill(tab: Tab, origin: string) {
  const saved = call<SavedLogin[]>('logins.for', { origin }) ?? [];
  if (!saved.length) return;
  const site = hostLabel(origin);
  void ask({
    kind: 'fill-password',
    tabId: tab.id,
    text:
      saved.length === 1
        ? `Sign in to ${site} as ${saved[0].username || 'your saved login'}?`
        : `Sign in to ${site} as`,
    choices:
      saved.length > 1
        ? saved.map((l) => ({ value: l.id, label: l.username || '(no name)' }))
        : undefined,
    actions: [
      { id: 'fill', label: 'Fill in' },
      { id: 'later', label: 'Not now' },
    ],
  }).then((response) => {
    if (response.action !== 'fill') return;
    const login =
      saved.length === 1
        ? saved[0]
        : saved.find((l) => l.id === response.choice);
    if (!login || data.originOf(shownUrl(tab)) !== origin) return;
    post('tab.fill', { id: tab.id, loginId: login.id, origin });
  });
}

// ---------------------------------------------------------------- page events

interface TabEvent {
  id: number;
  kind: string;
  url?: string;
  back?: boolean;
  forward?: boolean;
  loading?: boolean;
  title?: string;
  favicon?: string;
  progress?: number;
  on?: boolean;
  active?: number;
  total?: number;
  openerId?: number;
  background?: boolean;
  link?: string;
  image?: string;
  origin?: string;
  username?: string;
  token?: string;
  saved?: boolean;
  update?: boolean;
  scheme?: string;
  app?: string;
  reqId?: number;
  names?: string[];
  host?: string;
  realm?: string;
}

function remember(tab: Tab, url: string) {
  if (!isWebUrl(url) || tab.isPrivate) return;
  tab.historyId = data.recordVisit(url, tab.title);
}

onHost<TabEvent>('tab', (event) => {
  if (event.kind === 'popup') {
    // A page opened a window (a link to a new tab, a sign-in popup): the
    // app made its web page already, connected to the opener.
    const opener = event.openerId ? findTab(event.openerId) : undefined;
    if (!opener) {
      post('tab.close', { id: event.id });
      return;
    }
    createTab(event.url ?? '', {
      id: event.id,
      activate: !event.background,
      afterId: opener.id,
      isPrivate: opener.isPrivate,
      openerId: opener.id,
    });
    return;
  }

  const tab = findTab(event.id);
  if (!tab) return;
  const isActive = tab.id === activeTabId;
  if (event.url !== undefined) tab.url = event.url;
  if (event.back !== undefined) tab.canGoBack = event.back;
  if (event.forward !== undefined) tab.canGoForward = event.forward;
  if (event.loading !== undefined) tab.loading = event.loading;

  switch (event.kind) {
    case 'started':
      dropNotices(tab.id, true);
      tab.progress = 0;
      tab.title = '';
      tab.favicon = null;
      if (tab.isNewTab) {
        tab.isNewTab = false;
        if (isActive) updatePage();
      }
      break;
    case 'visited':
      remember(tab, tab.url);
      break;
    case 'finished':
      tab.progress = 100;
      break;
    case 'progress':
      tab.progress = event.progress ?? 0;
      break;
    case 'title':
      tab.title = event.title ?? '';
      if (tab.historyId) data.updateVisitTitle(tab.historyId, tab.title);
      break;
    case 'favicon':
      tab.favicon = event.favicon ?? null;
      if (tab.favicon && !tab.isPrivate) {
        data.setBookmarkFavicon(shownUrl(tab), tab.favicon);
      }
      break;
    case 'closed':
      closeTab(tab.id);
      return;
    case 'audible':
      tab.audible = event.on === true;
      break;
    case 'find':
      if (isActive) {
        sendToUi('terra:find-result', {
          active: event.active ?? 0,
          total: event.total ?? 0,
        });
      }
      return;
    case 'context':
      if (isActive) showPageMenu(tab, event.link ?? '', event.image ?? '');
      return;
    case 'loginForm':
      if (
        settings.offerPasswords &&
        !tab.isPrivate &&
        event.origin &&
        !data.passwordsNeverSaved(event.origin)
      ) {
        offerToFill(tab, event.origin);
      }
      return;
    case 'loginSubmitted':
      if (
        settings.offerPasswords &&
        !tab.isPrivate &&
        event.origin &&
        event.token &&
        !event.saved &&
        !data.passwordsNeverSaved(event.origin)
      ) {
        offerToSave(
          tab,
          event.origin,
          event.username ?? '',
          event.token,
          event.update === true,
        );
      }
      return;
    case 'external':
      openOutsideLink(
        tab,
        event.url ?? '',
        event.scheme ?? '',
        event.app ?? '',
      );
      return;
    case 'permission':
      askPermission(
        tab,
        event.reqId ?? 0,
        event.origin ?? '',
        event.names ?? [],
      );
      return;
    case 'auth': {
      const reqId = event.reqId ?? 0;
      void ask({
        kind: 'auth',
        tabId: tab.id,
        text: `${event.host ?? 'This site'} asks you to sign in`,
        fields: [
          { name: 'username', label: 'Username', type: 'text' },
          { name: 'password', label: 'Password', type: 'password' },
        ],
        actions: [
          { id: 'sign-in', label: 'Sign in' },
          { id: 'cancel', label: 'Cancel' },
        ],
      }).then((response) => {
        post('auth.answer', {
          id: reqId,
          ok: response.action === 'sign-in',
          username: response.fields.username ?? '',
          password: response.fields.password ?? '',
        });
      });
      return;
    }
    case 'fullscreen':
      htmlFullScreen = event.on === true;
      break;
    case 'crashed':
      // The page's process went away: it loads again when looked at.
      tab.live = false;
      tab.loading = false;
      tab.lazyUrl = shownUrl(tab) || null;
      if (shownPage === tab.id) shownPage = undefined;
      if (isActive) activateTab(tab.id);
      break;
  }
  sendTabs();
  if (isActive) sendState();
});

// ---------------------------------------------------------------- downloads

let downloads: DownloadInfo[] = [];

onHost<DownloadInfo[]>('downloads', (list) => {
  downloads = list;
  sendToUi('browser:downloads', list);
});

// ---------------------------------------------------------------- updates

interface UpdateInfo {
  version: string;
  url: string;
}

let readyUpdate: UpdateInfo | null = null;
let updateWaiters: ((update: UpdateInfo | null) => void)[] = [];

onHost<UpdateInfo | null>('update.result', (update) => {
  if (update) {
    readyUpdate = update;
    sendToUi('terra:update-ready', update.version);
  }
  for (const resolve of updateWaiters) resolve(update);
  updateWaiters = [];
});

function checkForUpdate(): Promise<UpdateInfo | null> {
  return new Promise((resolve) => {
    updateWaiters.push(resolve);
    post('update.check');
  });
}

/** Once a day at most, and only with automatic updates on. */
async function lookForUpdate() {
  if (!settings.autoUpdate || !inApp) return;
  const last = Number(data.readJson('update-check.json')) || 0;
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  data.saveSoon('update-check.json', () => Date.now());
  const update = await checkForUpdate();
  if (!update) return;
  void ask({
    kind: 'update',
    tabId: null,
    text: `Terra ${update.version} is ready to install.`,
    actions: [
      { id: 'install', label: 'Install' },
      { id: 'later', label: 'Later' },
    ],
  }).then((response) => {
    if (response.action === 'install') {
      post('update.install', { url: update.url });
    }
  });
}

// ---------------------------------------------------------------- suggestions

let remoteRequest = 0;
const remoteWaiters = new Map<number, (text: string | null) => void>();

onHost<{ id: number; text: string | null }>('fetch.result', ({ id, text }) => {
  remoteWaiters.get(id)?.(text);
  remoteWaiters.delete(id);
});

/** Search suggestions from the engine (only with the setting on). */
async function remoteSuggestions(query: string): Promise<Suggestion[]> {
  const text = query.trim();
  if (!text || !settings.searchSuggestions) return [];
  const id = ++remoteRequest;
  const body = await Promise.race([
    new Promise<string | null>((resolve) => {
      remoteWaiters.set(id, resolve);
      post('fetch', { id, url: remoteSuggestUrl(settings.searchEngine, text) });
    }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]);
  remoteWaiters.delete(id);
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const terms =
      Array.isArray(parsed) && Array.isArray(parsed[1]) ? parsed[1] : [];
    return terms
      .filter((t): t is string => typeof t === 'string')
      .slice(0, 4)
      .map((term) => ({
        kind: 'search' as const,
        value: searchUrl(term),
        title: term,
        detail: `Search ${SEARCH_ENGINES[settings.searchEngine].name}`,
      }));
  } catch {
    return [];
  }
}

function suggest(query: string) {
  return localSuggestions(query, {
    tabs: tabs
      .filter((t) => t.id !== activeTabId && !t.isNewTab)
      .map((t) => ({ id: t.id, title: tabTitle(t), url: shownUrl(t) })),
    bookmarks: data.getBookmarks(),
    history: data.getHistory(),
    asAddress: (text) => {
      const url = toUrl(text, false);
      return url && !url.startsWith(SEARCH_ENGINES[settings.searchEngine].url)
        ? url
        : null;
    },
    searchUrl,
    engineName: SEARCH_ENGINES[settings.searchEngine].name,
  });
}

// ---------------------------------------------------------------- logins

let importWaiter: ((count: number | null) => void) | null = null;

onHost<number | null>('logins.imported', (count) => {
  importWaiter?.(count);
  importWaiter = null;
});
onHost('logins.changed', () => sendToUi('terra:logins-changed', null));

// ---------------------------------------------------------------- the app

onHost<{ urls?: string[]; text?: string }>('open', ({ urls, text }) => {
  setSettingsOpen(false);
  for (const url of (urls ?? []).slice(0, 20)) {
    const target = toUrl(url, false);
    if (target) createTab(target);
  }
  if (text) {
    const target = toUrl(text);
    if (target) createTab(target);
  }
});

onHost('memory', () => {
  sleepOldTabs(0);
  sendTabs();
});

onHost<{ state: string }>('lifecycle', ({ state }) => {
  if (state === 'pause') {
    persistSession();
    data.flushWrites();
  } else if (state === 'resume') {
    sendToUi('browser:window-focus', true);
    void lookForUpdate();
  }
});

onHost<string[] | null>('pageColors', (colors) =>
  sendToUi('terra:page-colors', colors),
);
onHost<{ top: string | null; bottom: string | null }>('pageEdges', (edges) =>
  sendToUi('terra:page-edges', edges),
);
onHost('back', () => sendToUi('terra:back', null));
onHost('default.changed', () => sendToUi('browser:window-focus', true));

// ---------------------------------------------------------------- the UI's calls

/** What the UI sends (terra.send / window.browser): like ipcMain.on. */
export const commands: Record<string, (...args: never[]) => unknown> = {
  navigate: (url: string) => navigate(String(url)),
  back: goBack,
  forward: goForward,
  reload,
  stop,
  newTab,
  closeTab: (id: number) => closeTab(Number(id)),
  activateTab: (id: number) => activateTab(Number(id)),
  moveTab: (id: number, toIndex: number) =>
    moveTab(Number(id), Number(toIndex)),
  deleteHistory: (id: string) => data.deleteHistoryEntry(String(id)),
  clearHistory: () => {
    closedTabUrls = [];
    data.clearHistory();
  },
  openUrl: (url: string) => openUrl(String(url)),
  downloadAction: (id: string, action: DownloadAction) =>
    post('download.action', { id, action }),
  clearDownloads: () => post('downloads.clear'),
  openDownloadsFolder: () =>
    post('download.action', { id: '', action: 'show' }),
  showPage: (page: PanelPage) => showPanelPage(page),
  setSettingsOpen: (open: boolean) => setSettingsOpen(open === true),
  updateSettings: (changes: Partial<Settings>) => updateSettings(changes),
  makeDefaultBrowser: () => post('default.request'),
  settingsPage: (page: PanelPage) => {
    lastSettingsPage = page;
  },

  'terra:ui-ready': () => post('ui.painted'),
  'terra:back': systemBack,
  'terra:scroll-tabs': (step: number) => scrollTabs(Math.sign(Number(step))),
  'terra:notice-answer': (
    id: number,
    action: string,
    fields: Record<string, string>,
    choice: string,
  ) =>
    answerNotice(Number(id), {
      action: String(action),
      fields: fields && typeof fields === 'object' ? fields : {},
      choice: String(choice ?? ''),
    }),
  'terra:find': (text: string, forward: boolean, newSearch: boolean) => {
    const tab = activeTab();
    if (!tab?.live) return;
    if (!text) {
      post('tab.findStop', { id: tab.id });
      sendToUi('terra:find-result', { active: 0, total: 0 });
      return;
    }
    post('tab.find', { id: tab.id, text, forward, newSearch });
  },
  'terra:find-stop': () => {
    const tab = activeTab();
    if (tab?.live) post('tab.findStop', { id: tab.id });
  },
  'terra:switch-tab': (id: number) => activateTab(Number(id)),
  'terra:history-forget': (url: string) => data.deleteHistoryUrl(String(url)),
  'terra:folder-rename': (id: string, title: string) =>
    data.renameFolder(String(id), String(title)),
  'terra:folder-delete': (id: string) => data.deleteFolder(String(id)),
  'terra:bookmark-move': (id: string, folderId: string | null) =>
    data.moveBookmark(String(id), folderId ? String(folderId) : null),
  'terra:bookmark-toggle': () => toggleBookmarkFor(activeTab()),
  'terra:bookmark-open': (id: string, inNewTab: boolean) =>
    openBookmark(String(id), inNewTab === true),
  'terra:bookmark-menu': (id: string) => showBookmarkMenu(String(id)),
  'terra:open-bookmarks': () => showPanelPage('bookmarks'),
  'terra:bookmark-remove': (id: string) => data.removeBookmark(String(id)),
  'terra:bookmark-rename': (id: string, title: string) =>
    data.renameBookmark(String(id), String(title)),
  'terra:login-delete': (id: string) => {
    call('login.delete', { id });
    sendToUi('terra:logins-changed', null);
  },
  'terra:site-reset': (origin: string, permission?: string) => {
    data.resetSite(String(origin), permission ? String(permission) : undefined);
    sendConfig();
  },
  'terra:site-set': (origin: string, key: string, value: unknown) => {
    if (key === 'allowAds') data.setAdsAllowed(origin, value === true);
    if (key === 'neverSavePasswords') {
      data.setNeverSavePasswords(origin, value === true);
    }
    sendConfig();
  },
  'terra:update-install': () => {
    if (readyUpdate) post('update.install', { url: readyUpdate.url });
  },
  'terra:tab-menu': (id: number) => showTabMenu(Number(id)),
  'terra:tab-mute': (id: number) => toggleMute(Number(id)),
  'terra:new-private-tab': newPrivateTab,
  'terra:site-menu': showSiteMenu,
  'terra:main-menu': showMainMenu,
  'terra:menu-pick': (id: number, keepOpen: boolean) =>
    pickMenu(Number(id), keepOpen === true),
  'terra:menu-close': () => {
    menuActions.clear();
    menuBuilder = null;
  },
  'terra:open-links': (links: string[]) => {
    setSettingsOpen(false);
    for (const link of Array.isArray(links) ? links.slice(0, 20) : []) {
      const url = toUrl(String(link), false);
      if (url) createTab(url);
    }
  },
  'terra:keyboard': (show: boolean) =>
    post(show ? 'keyboard.show' : 'keyboard.hide'),
};

/** What the UI asks and waits for (terra.invoke): like ipcMain.handle. */
export const queries: Record<string, (...args: never[]) => unknown> = {
  getHistory: () => data.getHistory(),
  clearBrowsingData: () => {
    post('data.clear');
    closedTabUrls = [];
    data.clearHistory();
    return true;
  },
  getDefaultBrowser: (): DefaultBrowserState =>
    call<DefaultBrowserState>('default.get') ?? {
      supported: false,
      isDefault: false,
    },
  'terra:suggest': (query: string) => suggest(String(query)),
  'terra:suggest-remote': (query: string) => remoteSuggestions(String(query)),
  'terra:suggest-open': () => null,
  'terra:bookmarks': () => data.getBookmarks(),
  'terra:bookmark-folders': () => data.getFolders(),
  'terra:folder-create': (title: string) => data.createFolder(String(title)),
  'terra:logins': () =>
    call<{ available: boolean; logins: SavedLogin[] }>('logins.list') ?? {
      available: false,
      logins: [],
    },
  'terra:login-reveal': (id: string) => call<string>('login.reveal', { id }),
  'terra:logins-import': () =>
    new Promise<number | null>((resolve) => {
      importWaiter?.(null);
      importWaiter = resolve;
      post('logins.import');
    }),
  'terra:sites': () => data.getSites(),
  'terra:import-sources': () => [],
  'terra:import': () => null,
  'terra:update-status': () => ({
    supported: inApp,
    current: appInfo.version,
    ready: readyUpdate?.version ?? null,
  }),
  'terra:update-check': async () => (await checkForUpdate())?.version ?? null,
  'terra:app-info': () => appInfo,
};

// ---------------------------------------------------------------- start

const appInfo = call<{ version: string; privateIsolated: boolean }>(
  'app.info',
) ?? { version: '', privateIsolated: false };

/** Called by the UI once it listens: everything is sent, like on load. */
export function start() {
  data.initHistory(() => sendToUi('browser:history-changed', null));
  data.initBookmarks(() => {
    sendToUi('terra:bookmarks-changed', null);
    sendState();
  });
  data.initSites(() => sendToUi('terra:sites-changed', null));
  starting = true;
  loadSettings();
  sendConfig();
  // "Clear cookies and site data when Terra closes": a phone app is never
  // really closed, so it happens when Terra starts fresh.
  if (settings.clearOnExit) post('data.clear');

  if (settings.startup === 'restore') {
    const session = data.loadSession();
    session.tabs.forEach((saved, index) => {
      createTab(saved.url, {
        activate: false,
        pinned: saved.pinned,
        lazyTitle: saved.title,
      });
      if (index === session.active) activeTabId = tabs[tabs.length - 1].id;
    });
  }
  if (activeTabId !== null) activateTab(activeTabId);
  else createTab(settings.homePage || null);

  starting = false;
  sendSettings();
  sendToUi('browser:downloads', downloads);
  sendNotice();
  post('ui.ready');
  void lookForUpdate();
}
