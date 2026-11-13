// Types shared by the main process, the preload script and the UI.

export interface BrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Page zoom in percent (100 = normal). */
  zoom: number;
  security: PageSecurity;
  bookmarked: boolean;
  isPrivate: boolean;
}

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  favicon: string | null;
  loading: boolean;
  /** Showing our clean search page instead of a website. */
  isNewTab: boolean;
  pinned: boolean;
  /** Playing sound right now. */
  audible: boolean;
  muted: boolean;
  /** Private tab: nothing is remembered. */
  isPrivate: boolean;
}

export interface TabsState {
  tabs: TabInfo[];
  activeTabId: number | null;
  sidebarCollapsed: boolean;
  fullScreen: boolean;
  settingsOpen: boolean;
}

/** Background colors at the website's left and top edges (#rrggbb). */
/**
 * Where the liquid glass takes its colors from: the accent color, whatever
 * is behind the window (desktop, other apps; Windows blurs it), or the
 * open website.
 */
export type GlassColors = 'accent' | 'behind' | 'page';

export const GLASS_COLORS: GlassColors[] = ['accent', 'behind', 'page'];

export interface PageEdges {
  left: string | null;
  top: string | null;
}

// ---------------------------------------------------------------- bindings

/**
 * Everything a key or mouse button can be bound to, with the usual browser
 * shortcuts as defaults. Every one can be changed or cleared in Settings.
 */
export const ACTIONS = [
  { id: 'reload', label: 'Refresh', binding: 'F5' },
  { id: 'back', label: 'Back', binding: 'Mouse4' },
  { id: 'forward', label: 'Forward', binding: 'Mouse5' },
  { id: 'hardReload', label: 'Refresh without cache', binding: 'Ctrl+F5' },
  { id: 'newTab', label: 'New tab', binding: 'Ctrl+T' },
  { id: 'privateTab', label: 'New private tab', binding: 'Ctrl+Shift+N' },
  { id: 'closeTab', label: 'Close tab', binding: 'Ctrl+W' },
  { id: 'reopenTab', label: 'Reopen closed tab', binding: 'Ctrl+Shift+T' },
  { id: 'duplicateTab', label: 'Duplicate tab', binding: '' },
  { id: 'pinTab', label: 'Pin or unpin tab', binding: '' },
  { id: 'muteTab', label: 'Mute or unmute tab', binding: 'Ctrl+M' },
  { id: 'nextTab', label: 'Next tab', binding: 'Ctrl+Tab' },
  { id: 'previousTab', label: 'Previous tab', binding: 'Ctrl+Shift+Tab' },
  { id: 'focusAddress', label: 'Address bar', binding: 'Ctrl+L' },
  { id: 'find', label: 'Find on page', binding: 'Ctrl+F' },
  { id: 'bookmarkPage', label: 'Bookmark this page', binding: 'Ctrl+D' },
  { id: 'print', label: 'Print', binding: 'Ctrl+P' },
  { id: 'savePage', label: 'Save page as', binding: 'Ctrl+S' },
  { id: 'openFile', label: 'Open file', binding: 'Ctrl+O' },
  { id: 'viewSource', label: 'View page source', binding: 'Ctrl+U' },
  { id: 'toggleSidebar', label: 'Compact sidebar', binding: '' },
  { id: 'fullScreen', label: 'Full screen', binding: 'F11' },
  { id: 'openSettings', label: 'Settings', binding: 'Ctrl+,' },
  { id: 'openHistory', label: 'History', binding: 'Ctrl+H' },
  { id: 'openDownloads', label: 'Downloads', binding: 'Ctrl+J' },
  { id: 'openBookmarks', label: 'Bookmarks', binding: 'Ctrl+Shift+O' },
  { id: 'openPasswords', label: 'Passwords', binding: '' },
  { id: 'zoomIn', label: 'Zoom in', binding: 'Ctrl+=' },
  { id: 'zoomOut', label: 'Zoom out', binding: 'Ctrl+-' },
  { id: 'zoomReset', label: 'Reset zoom', binding: 'Ctrl+0' },
  { id: 'devTools', label: 'Developer tools', binding: 'F12' },
] as const;

/**
 * Bumped when new default shortcuts are added, so people who saved settings
 * before get the new defaults for actions they never set themselves.
 */
export const BINDINGS_VERSION = 2;

/** A user-made shortcut: press it to open \`url\` in a new tab. */
export interface CustomBinding {
  id: string;
  url: string;
  binding: string;
}

export type ActionId = (typeof ACTIONS)[number]['id'];
export type Bindings = Record<ActionId, string>;

export function defaultBindings(): Bindings {
  return Object.fromEntries(
    ACTIONS.map((action) => [action.id, action.binding]),
  ) as Bindings;
}

/** Mouse side buttons, by DOM button number (3 = back, 4 = forward). */
export const MOUSE_BUTTONS: Record<number, string> = {
  3: 'Mouse4',
  4: 'Mouse5',
};

/**
 * One text form for a key press, used by both the main process and the
 * UI so a binding recorded in settings matches what is pressed later:
 * "F5", "Ctrl+Shift+T", "Alt+ArrowLeft". Returns "" for a lone modifier.
 */
export function keyCombo(press: {
  key: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}): string {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(press.key)) {
    return '';
  }
  const key =
    press.key === ' '
      ? 'Space'
      : press.key.length === 1
        ? press.key.toUpperCase()
        : press.key;
  return [
    press.ctrl && 'Ctrl',
    press.alt && 'Alt',
    press.shift && 'Shift',
    press.meta && 'Meta',
    key,
  ]
    .filter(Boolean)
    .join('+');
}

/** How a binding is shown in settings. */
export function bindingLabel(binding: string) {
  if (!binding) return 'Not set';
  if (binding === 'Mouse4') return 'Mouse back';
  if (binding === 'Mouse5') return 'Mouse forward';
  return binding
    .replace('ArrowLeft', '←')
    .replace('ArrowRight', '→')
    .replace('ArrowUp', '↑')
    .replace('ArrowDown', '↓');
}

// ---------------------------------------------------------------- library

export interface HistoryEntry {
  id: string;
  url: string;
  title: string;
  /** When it was visited, in ms since 1970. */
  time: number;
}

export type DownloadState =
  | 'progressing'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

export interface DownloadInfo {
  id: string;
  filename: string;
  url: string;
  /** Where the file is saved ("" until chosen in a Save dialog). */
  path: string;
  received: number;
  /** 0 when the server doesn't say how big the file is. */
  total: number;
  state: DownloadState;
  started: number;
  canResume: boolean;
  /** For completed downloads: is the file still on disk? */
  exists: boolean;
}

export type DownloadAction =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'open'
  | 'show'
  | 'retry'
  | 'remove';

/** Whether Terra can be, and is, the system's default browser. */
export interface DefaultBrowserState {
  supported: boolean;
  isDefault: boolean;
}

/** Pages that open in the full-window panel next to the settings. */
export type PanelPage =
  | 'appearance'
  | 'navigation'
  | 'features'
  | 'privacy'
  | 'history'
  | 'downloads'
  | 'bookmarks'
  | 'passwords';

export const PANEL_PAGES: PanelPage[] = [
  'appearance',
  'navigation',
  'features',
  'privacy',
  'history',
  'downloads',
  'bookmarks',
  'passwords',
];

// ---------------------------------------------------------------- bookmarks

export interface Bookmark {
  id: string;
  url: string;
  title: string;
  /** When it was added, in ms since 1970. */
  time: number;
  /** The site's icon, picked up when the page is open in a tab. */
  favicon?: string;
  /** The folder it's in (see BookmarkFolder), or none: top level. */
  folderId?: string;
}

/** A folder in the bookmarks pop-out. One level, no folders in folders. */
export interface BookmarkFolder {
  id: string;
  title: string;
  /** When it was made, in ms since 1970. */
  time: number;
}

// ---------------------------------------------------------------- passwords

/** A saved login as the UI sees it (the password stays in the main process). */
export interface SavedLogin {
  id: string;
  origin: string;
  username: string;
  time: number;
}

// ---------------------------------------------------------------- sites

export type PermissionDecision = 'allow' | 'block';

/** What one website may do, as shown on the Privacy page. */
export interface SiteInfo {
  origin: string;
  permissions: Record<string, PermissionDecision>;
  /** Zoom level, 0 = 100%. */
  zoom: number;
  /** Ads and trackers are allowed on this site. */
  allowAds: boolean;
  /** Never offer to save passwords here. */
  neverSavePasswords: boolean;
}

/** Names shown for website permissions. */
export const PERMISSION_LABELS: Record<string, string> = {
  camera: 'Camera',
  microphone: 'Microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
  midi: 'MIDI devices',
  'clipboard-read': 'See what you copied',
  'display-capture': 'Share your screen',
  'idle-detection': 'Know when you are away',
  'window-management': 'Manage windows on your screens',
  openExternal: 'Open other apps',
};

// ---------------------------------------------------------------- toolbar

/** One line in the address bar dropdown. */
export interface Suggestion {
  kind: 'search' | 'url' | 'tab' | 'bookmark' | 'history';
  /** What opens (a URL), or the tab id for kind "tab". */
  value: string;
  title: string;
  /** Second line: the address, or "Switch to tab". */
  detail: string;
}

/** Security of the page in the address bar. */
export type PageSecurity = 'secure' | 'insecure' | 'local' | 'none';

export interface FindResult {
  active: number;
  total: number;
}

/**
 * A question or message in the bar under the toolbar: a site asking for a
 * permission, saving a password, a sign-in box, an update...
 */
export interface Notice {
  id: number;
  /** The tab it belongs to (shown only there), or null for every tab. */
  tabId: number | null;
  text: string;
  /** Inputs to fill in (sign-in boxes). */
  fields?: { name: string; label: string; type: 'text' | 'password' }[];
  /** A choice from a list (which screen to share). */
  choices?: { value: string; label: string }[];
  /** Buttons, the first is the main one. */
  actions: { id: string; label: string }[];
}

export type Theme = 'dark' | 'light' | 'oled';

export const THEMES: Theme[] = ['dark', 'light', 'oled'];

/** Window background behind the UI for each theme (matches --bg in CSS). */
export const THEME_BACKGROUNDS: Record<Theme, string> = {
  dark: '#111318',
  light: '#f6f7f9',
  oled: '#000000',
};

/**
 * How much of the background tint goes into each surface. OLED dark stays
 * pure black, so it is never tinted.
 */
export const TINT_AMOUNT: Record<Theme, number> = {
  dark: 0.12,
  light: 0.08,
  oled: 0,
};

/** Blends `color` into `base` (both #rrggbb) by `amount` (0-1). */
export function mixHex(base: string, color: string, amount: number) {
  const parse = (hex: string) => {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };
  const a = parse(base);
  const b = parse(color);
  return `#${a
    .map((channel, i) =>
      Math.round(channel + (b[i] - channel) * amount)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The tint color in use, or null (none, or OLED dark). */
export function activeTint(
  settings: Pick<Settings, 'theme' | 'backgroundTint' | 'accentColor'>,
) {
  if (TINT_AMOUNT[settings.theme] === 0 || !settings.backgroundTint)
    return null;
  return settings.backgroundTint === 'accent'
    ? settings.accentColor
    : settings.backgroundTint;
}

/** The window background (--bg) for these settings. */
export function themeBackground(
  settings: Pick<Settings, 'theme' | 'backgroundTint' | 'accentColor'>,
) {
  const base = THEME_BACKGROUNDS[settings.theme];
  const tint = activeTint(settings);
  return tint ? mixHex(base, tint, TINT_AMOUNT[settings.theme]) : base;
}

/** Ready-made accent colors shown as swatches in settings. */
export const ACCENT_PRESETS = [
  { name: 'Blue', color: '#4f7cff' },
  { name: 'Purple', color: '#8b5cf6' },
  { name: 'Pink', color: '#ec4899' },
  { name: 'Red', color: '#ef4444' },
  { name: 'Orange', color: '#f97316' },
  { name: 'Yellow', color: '#eab308' },
  { name: 'Green', color: '#22c55e' },
  { name: 'Teal', color: '#14b8a6' },
];

export type SearchEngine = 'google' | 'duckduckgo' | 'bing' | 'brave';

/** Auto-compact sidebar: unused this long, the sidebar compacts. */
export const AUTO_COMPACT_MS = 1000;
/** Auto-compact sidebar: the mouse rests this long to open it again. */
export const HOVER_EXPAND_MS = 300;

export interface Settings {
  searchEngine: SearchEngine;
  homePage: string;
  sidebarCollapsed: boolean;
  /** Compact the sidebar when unused, open it again on hover. */
  autoCompactSidebar: boolean;
  /** Show the lines between sections (sidebar, bars, rows). */
  showDividers: boolean;
  /** Soft, faded dividers instead of sharp 1px lines. */
  smoothDividers: boolean;
  /** Make websites without a dark mode dark (built-in forcer). */
  forceDark: boolean;
  /** Mouse wheel over the sidebar switches tabs. */
  scrollTabs: boolean;
  /** Show a Save dialog for every download instead of using Downloads. */
  askDownloadLocation: boolean;
  /** Key or mouse button for each action ("" = not set). */
  bindings: Bindings;
  /** User-made shortcuts that open a site. */
  customBindings: CustomBinding[];
  theme: Theme;
  /** Main accent color as #rrggbb. */
  accentColor: string;
  /**
   * Color blended into the backgrounds in dark and light mode: '' for none,
   * 'accent' to follow the accent color, or #rrggbb.
   */
  backgroundTint: string;
  /**
   * Liquid glass: the window's background becomes frosted glass with soft
   * light in the accent's colors under it (dark and light mode).
   */
  liquidGlass: boolean;
  /**
   * The glass's colors: the accent color, what's behind the window, or the
   * main colors of the open website.
   */
  glassColors: GlassColors;
  /** Zoom and fade the window when it opens and closes. */
  windowAnimations: boolean;
  /** See BINDINGS_VERSION. */
  bindingsVersion: number;
  /** What opens when Terra starts. */
  startup: 'restore' | 'newTab';
  /** Ask the search engine for suggestions while typing (sends the text). */
  searchSuggestions: boolean;
  /** Block ads and trackers. */
  blockAds: boolean;
  /** Offer to save passwords and fill them in. */
  offerPasswords: boolean;
  /** Delete cookies, cache and site data when Terra closes. */
  clearOnExit: boolean;
  /** Download new versions in the background and offer to restart. */
  autoUpdate: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SEARCH_ENGINES: Record<
  SearchEngine,
  { name: string; url: string }
> = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
};

export const DEFAULT_SETTINGS: Settings = {
  searchEngine: 'google',
  // Empty = new tabs show the clean search page.
  homePage: '',
  sidebarCollapsed: false,
  autoCompactSidebar: false,
  showDividers: true,
  smoothDividers: false,
  forceDark: false,
  scrollTabs: false,
  askDownloadLocation: false,
  bindings: defaultBindings(),
  customBindings: [],
  theme: 'dark',
  accentColor: '#4f7cff',
  backgroundTint: '',
  liquidGlass: false,
  glassColors: 'accent',
  windowAnimations: true,
  bindingsVersion: BINDINGS_VERSION,
  startup: 'restore',
  searchSuggestions: false,
  blockAds: true,
  offerPasswords: true,
  clearOnExit: false,
  autoUpdate: true,
};
