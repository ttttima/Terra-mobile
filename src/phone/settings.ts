// Settings on the phone: the desktop's panel (renderer.ts) one screen at a
// time. First the list of pages (the desktop's left column), then the page;
// Back goes up a level. Appearance, History and Downloads are the
// desktop's code; ui-pages.ts adds Privacy, Bookmarks and Passwords.
import {
  ACCENT_PRESETS,
  SEARCH_ENGINES,
  TINT_AMOUNT,
  activeTint,
  mixHex,
  type DefaultBrowserState,
  type DownloadAction,
  type DownloadInfo,
  type GlassColors,
  type HistoryEntry,
  type PanelPage,
  type SearchEngine,
  type Settings,
  type Theme,
} from '../shared';
import { cancelColorPanel, openColorPanel } from '../ui-color-panel';
import { pageShown } from '../ui-pages';
import { phoneIcon } from './icons';
import { closeLayer, openLayer } from './layout';

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const body = document.body;
const settingsPage = $<HTMLElement>('#settings');

// ---------------------------------------------------------------- navigation

const categories = document.querySelectorAll<HTMLButtonElement>('.category');
const panels = document.querySelectorAll<HTMLElement>('.settings-panel');
let currentPage: PanelPage = 'appearance';
/** Opened straight on a page (History from the menu): Back leaves. */
let cameDirect = false;

function showPanel(page: PanelPage, direct: boolean) {
  cancelColorPanel();
  currentPage = page;
  cameDirect = direct;
  settingsPage.classList.add('show-panel');
  for (const panel of panels) panel.hidden = panel.dataset.panel !== page;
  const active = [...categories].find((b) => b.dataset.category === page);
  $('#settings-title').textContent =
    active?.querySelector('.label')?.textContent ?? '';
  $('.settings-content').scrollTop = 0;
  if (page === 'history') void loadHistory();
  if (page === 'downloads') renderDownloads();
  if (['appearance', 'navigation', 'features', 'privacy'].includes(page)) {
    window.terra.send('settingsPage', page);
  }
  pageShown(page);
}

function showList() {
  cancelColorPanel();
  settingsPage.classList.remove('show-panel');
}

/** Back inside settings: page -> list -> browsing. */
function back() {
  if (document.querySelector('.color-panel')) return cancelColorPanel();
  if (settingsPage.classList.contains('show-panel') && !cameDirect) {
    showList();
  } else {
    window.browser.setSettingsOpen(false);
  }
}

let open = false;

export function setSettingsVisible(visible: boolean) {
  if (visible === open) return;
  open = visible;
  if (!visible) {
    cancelColorPanel();
    closeLayer('settings');
  } else {
    openLayer('settings', back);
    // From the gear: the list. browser:show-page then opens a page.
    showList();
  }
  settingsPage.hidden = !visible;
  body.classList.toggle('settings-open', visible);
}

for (const button of categories) {
  button.insertAdjacentHTML('beforeend', phoneIcon('chevron', 'row-chevron'));
  button.addEventListener('click', () =>
    showPanel(button.dataset.category as PanelPage, false),
  );
}
window.browser.onShowPage((page) => {
  // Arrives right after settings open (from the menu or the drawer).
  setTimeout(() => showPanel(page, true));
});
$('#close-settings').addEventListener('click', () =>
  window.browser.setSettingsOpen(false),
);
$('#settings-back').addEventListener('click', back);

void window.terra
  .invoke<{ version: string }>('terra:app-info')
  .then(({ version }) => {
    $('#settings-version').textContent = version ? `Terra ${version}` : '';
  });

// ---------------------------------------------------------------- default browser

const defaultBrowserRow = $<HTMLDivElement>('#default-browser-row');
const defaultBrowserText = $<HTMLElement>('#default-browser-text');
const makeDefault = $<HTMLButtonElement>('#make-default');

async function updateDefaultBrowser() {
  let state: DefaultBrowserState;
  try {
    state = await window.browser.getDefaultBrowser();
  } catch {
    return;
  }
  defaultBrowserRow.hidden = !state.supported;
  defaultBrowserText.textContent = state.isDefault
    ? 'Terra opens links from other apps'
    : 'Open links from other apps in Terra';
  makeDefault.disabled = state.isDefault;
  makeDefault.textContent = state.isDefault ? 'Default' : 'Make default';
}
makeDefault.addEventListener('click', () =>
  window.browser.makeDefaultBrowser(),
);
window.browser.onWindowFocus((focused) => {
  if (focused) void updateDefaultBrowser();
});
void updateDefaultBrowser();

// ---------------------------------------------------------------- settings rows

const searchEngine = $<HTMLSelectElement>('#setting-search-engine');
const homePage = $<HTMLInputElement>('#setting-home-page');
const showDividers = $<HTMLInputElement>('#setting-show-dividers');
const forceDark = $<HTMLInputElement>('#setting-force-dark');
const scrollTabs = $<HTMLInputElement>('#setting-scroll-tabs');
const smoothDividers = $<HTMLInputElement>('#setting-smooth-dividers');
const smoothDividersRow = $<HTMLElement>('#smooth-dividers-row');
const clearData = $<HTMLButtonElement>('#clear-data');

function applyDividers(show: boolean, smooth: boolean) {
  body.classList.toggle('no-dividers', !show);
  body.classList.toggle('smooth-dividers', show && smooth);
  smoothDividers.disabled = !show;
  smoothDividersRow.classList.toggle('disabled', !show);
}

for (const [value, engine] of Object.entries(SEARCH_ENGINES)) {
  searchEngine.add(new Option(engine.name, value));
}

searchEngine.addEventListener('change', () =>
  window.browser.updateSettings({
    searchEngine: searchEngine.value as SearchEngine,
  }),
);
homePage.addEventListener('change', () =>
  window.browser.updateSettings({ homePage: homePage.value }),
);
homePage.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') homePage.blur();
});
showDividers.addEventListener('change', () => {
  applyDividers(showDividers.checked, smoothDividers.checked);
  window.browser.updateSettings({ showDividers: showDividers.checked });
});
smoothDividers.addEventListener('change', () => {
  applyDividers(showDividers.checked, smoothDividers.checked);
  window.browser.updateSettings({ smoothDividers: smoothDividers.checked });
});
forceDark.addEventListener('change', () =>
  window.browser.updateSettings({ forceDark: forceDark.checked }),
);
scrollTabs.addEventListener('change', () =>
  window.browser.updateSettings({ scrollTabs: scrollTabs.checked }),
);

clearData.addEventListener('click', async () => {
  if (
    !confirm(
      'Delete cookies, cache and site data? You will be signed out of websites.',
    )
  ) {
    return;
  }
  clearData.disabled = true;
  clearData.textContent = 'Clearing…';
  try {
    await window.browser.clearBrowsingData();
    clearData.textContent = 'Cleared';
  } catch {
    clearData.textContent = 'Failed, try again';
  }
  setTimeout(() => {
    clearData.disabled = false;
    clearData.textContent = 'Clear data';
  }, 2000);
});

// ---------------------------------------------------------------- accent

const accentSwatches = $<HTMLDivElement>('#accent-swatches');
const accentCustom = $<HTMLButtonElement>('#accent-custom');

function fullHex(value: string) {
  const color = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(color)) return color;
  if (/^#[0-9a-f]{3}$/.test(color)) {
    return `#${Array.from(color.slice(1), (c) => c + c).join('')}`;
  }
  return null;
}

function hexToRgb(hex: string) {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function mix(hex: string, target: number, amount: number) {
  const [r, g, b] = hexToRgb(hex).map((c) =>
    Math.round(c + (target - c) * amount),
  );
  return `rgb(${r}, ${g}, ${b})`;
}

/** What the UI colors depend on, kept current for live previews. */
const colors: Pick<Settings, 'theme' | 'accentColor' | 'backgroundTint'> = {
  theme: 'dark',
  accentColor: ACCENT_PRESETS[0].color,
  backgroundTint: '',
};

function applyAccent(hex: string) {
  const [r, g, b] = hexToRgb(hex);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  const style = document.documentElement.style;
  style.setProperty('--accent', hex);
  style.setProperty('--accent-strong', hex);
  style.setProperty(
    '--accent-hover',
    luminance > 0.6 ? mix(hex, 0, 0.12) : mix(hex, 255, 0.15),
  );
  style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.18)`);
  style.setProperty('--on-accent', luminance > 0.6 ? '#111318' : '#ffffff');
  colors.accentColor = hex;
  applyBackground();
  const isPreset = ACCENT_PRESETS.some((preset) => preset.color === hex);
  accentCustom.classList.toggle('selected', !isPreset);
  for (const swatch of accentSwatches.querySelectorAll<HTMLElement>(
    '.accent-swatch',
  )) {
    swatch.classList.toggle('selected', swatch.dataset.color === hex);
  }
}

function chooseAccent(hex: string) {
  applyAccent(hex);
  window.browser.updateSettings({ accentColor: hex });
}

for (const preset of ACCENT_PRESETS) {
  const swatch = document.createElement('button');
  swatch.className = 'accent-swatch';
  swatch.title = preset.name;
  swatch.ariaLabel = `${preset.name} accent`;
  swatch.dataset.color = preset.color;
  swatch.style.background = preset.color;
  swatch.addEventListener('click', () => chooseAccent(preset.color));
  accentSwatches.append(swatch);
}

accentCustom.addEventListener('click', () => {
  const saved = colors.accentColor;
  openColorPanel(accentCustom, {
    color: saved,
    label: 'Custom accent color',
    onPreview: applyAccent,
    onApply: chooseAccent,
    onCancel: () => applyAccent(saved),
  });
});

// ---------------------------------------------------------------- tint and glass

const TINTED_TOKENS = [
  '--bg',
  '--panel',
  '--border',
  '--hover',
  '--input-bg',
  '--input-border',
  '--chip',
  '--spinner-track',
];

const tintRow = $<HTMLDivElement>('#tint-row');
const tintNote = $<HTMLElement>('#tint-note');
const glassRow = $<HTMLLabelElement>('#glass-row');
const glassNote = $<HTMLElement>('#glass-note');
const liquidGlass = $<HTMLInputElement>('#setting-liquid-glass');
const glassColorsRow = $<HTMLDivElement>('#glass-colors-row');
const glassColorsNote = $<HTMLElement>('#glass-colors-note');
const glassColorsSelect = $<HTMLSelectElement>('#setting-glass-colors');
let glassWanted = false;
let glassSource: GlassColors = 'accent';
let pageColors: string[] | null = null;

/** The liquid glass background; OLED stays black. */
function applyGlass() {
  const oled = colors.theme === 'oled';
  const on = glassWanted && !oled;
  body.classList.toggle('glass', on);
  glassRow.classList.toggle('disabled', oled);
  liquidGlass.disabled = oled;
  liquidGlass.checked = glassWanted;
  glassNote.textContent = oled
    ? 'Off in OLED dark'
    : 'Frosted glass background with soft light';
  glassColorsRow.hidden = !on;
  glassColorsSelect.value = glassSource;
  let main: string | null = null;
  let extra: string[] = [];
  if (glassSource === 'page') {
    main = pageColors?.[0] ?? null;
    extra = pageColors?.slice(1) ?? [];
    glassColorsNote.textContent = pageColors
      ? "The soft light takes the open website's colors"
      : 'No website open here: using the accent';
  } else {
    glassColorsNote.textContent = 'The soft light uses your accent color';
  }
  const style = body.style;
  const set = (name: string, value: string | null | undefined) =>
    value ? style.setProperty(name, value) : style.removeProperty(name);
  set('--glass-color', main);
  set('--glass-color-2', extra[0]);
  set('--glass-color-3', extra[1]);
}

glassColorsSelect.addEventListener('change', () => {
  glassSource = glassColorsSelect.value as GlassColors;
  applyGlass();
  window.browser.updateSettings({ glassColors: glassSource });
});

window.terra.on<string[] | null>('terra:page-colors', (next) => {
  pageColors = next?.length ? next : null;
  applyGlass();
});

liquidGlass.addEventListener('change', () => {
  glassWanted = liquidGlass.checked;
  applyGlass();
  window.browser.updateSettings({ liquidGlass: glassWanted });
});

const tintSwatches = $<HTMLDivElement>('#tint-swatches');
const tintCustom = $<HTMLButtonElement>('#tint-custom');

function applyBackground() {
  const style = document.documentElement.style;
  for (const token of TINTED_TOKENS) style.removeProperty(token);
  const tint = activeTint(colors);
  if (tint) {
    const computed = getComputedStyle(document.documentElement);
    for (const token of TINTED_TOKENS) {
      const base = fullHex(computed.getPropertyValue(token));
      if (base) {
        style.setProperty(token, mixHex(base, tint, TINT_AMOUNT[colors.theme]));
      }
    }
  }
  const oled = colors.theme === 'oled';
  tintRow.classList.toggle('disabled', oled);
  applyGlass();
  tintNote.textContent = oled ? 'Off in OLED dark' : 'Dark and light mode';
  for (const control of tintRow.querySelectorAll<HTMLButtonElement>('button')) {
    control.disabled = oled;
  }
  const choice = colors.backgroundTint;
  const isPreset = [
    '',
    'accent',
    ...ACCENT_PRESETS.map((p) => p.color),
  ].includes(choice);
  tintCustom.classList.toggle('selected', !isPreset);
  if (!isPreset) tintCustom.style.setProperty('--tint-custom', choice);
  for (const swatch of tintSwatches.querySelectorAll<HTMLElement>(
    '.accent-swatch',
  )) {
    swatch.classList.toggle('selected', swatch.dataset.tint === choice);
  }
}

function chooseTint(value: string) {
  colors.backgroundTint = value;
  applyBackground();
  window.browser.updateSettings({ backgroundTint: value });
}

for (const option of [
  { tint: '', name: 'None', extra: 'tint-none' },
  { tint: 'accent', name: 'Same as accent', extra: 'tint-accent' },
  ...ACCENT_PRESETS.map((preset) => ({
    tint: preset.color,
    name: preset.name,
    extra: '',
  })),
]) {
  const swatch = document.createElement('button');
  swatch.className = `accent-swatch ${option.extra}`.trim();
  swatch.title = option.name;
  swatch.ariaLabel = `${option.name} background`;
  swatch.dataset.tint = option.tint;
  if (option.tint.startsWith('#')) swatch.style.background = option.tint;
  swatch.addEventListener('click', () => chooseTint(option.tint));
  tintSwatches.append(swatch);
}

tintCustom.addEventListener('click', () => {
  const saved = colors.backgroundTint;
  const preview = (value: string) => {
    colors.backgroundTint = value;
    applyBackground();
  };
  openColorPanel(tintCustom, {
    color: activeTint(colors) ?? colors.accentColor,
    label: 'Custom background tint',
    onPreview: preview,
    onApply: chooseTint,
    onCancel: () => preview(saved),
  });
});

const themeInputs = document.querySelectorAll<HTMLInputElement>(
  'input[name="theme"]',
);
for (const input of themeInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    document.documentElement.dataset.theme = input.value;
    colors.theme = input.value as Theme;
    applyBackground();
    window.browser.updateSettings({ theme: input.value as Theme });
  });
}

// ---------------------------------------------------------------- history

const historyList = $<HTMLDivElement>('#history-list');
const historySearch = $<HTMLInputElement>('#history-search');
const HISTORY_PAGE = 300;
let historyEntries: HistoryEntry[] = [];
let historyShown = HISTORY_PAGE;

function iconButton(icon: string, title: string, onClick: () => void) {
  const button = document.createElement('button');
  button.className = 'icon-button list-action';
  button.title = title;
  button.ariaLabel = title;
  button.innerHTML = phoneIcon(icon);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function dayLabel(time: number) {
  const day = new Date(time);
  const today = new Date();
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: day.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

function emptyState(message: string) {
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = message;
  return empty;
}

async function loadHistory() {
  historyEntries = await window.browser.getHistory();
  renderHistory();
}

function renderHistory() {
  const query = historySearch.value.trim().toLowerCase();
  const matches = query
    ? historyEntries.filter(
        (e) =>
          e.title.toLowerCase().includes(query) ||
          e.url.toLowerCase().includes(query),
      )
    : historyEntries;
  if (matches.length === 0) {
    historyList.replaceChildren(
      emptyState(query ? 'Nothing matches your search' : 'No history yet'),
    );
    return;
  }
  const cards: HTMLElement[] = [];
  let card: HTMLElement | null = null;
  let label = '';
  for (const entry of matches.slice(0, historyShown)) {
    const day = dayLabel(entry.time);
    if (!card || day !== label) {
      label = day;
      card = document.createElement('div');
      card.className = 'settings-card list-card';
      const title = document.createElement('div');
      title.className = 'card-title';
      title.textContent = day;
      card.append(title);
      cards.push(card);
    }
    card.append(historyRow(entry));
  }
  if (matches.length > historyShown) {
    const more = document.createElement('button');
    more.className = 'text-button show-more';
    more.textContent = `Show more (${matches.length - historyShown})`;
    more.addEventListener('click', () => {
      historyShown += HISTORY_PAGE;
      renderHistory();
    });
    cards.push(more);
  }
  historyList.replaceChildren(...cards);
}

function historyRow(entry: HistoryEntry) {
  const row = document.createElement('div');
  row.className = 'list-row clickable';
  row.tabIndex = 0;
  const badge = document.createElement('span');
  badge.className = 'tab-icon letter';
  badge.textContent = (hostOf(entry.url)[0] ?? '•').toUpperCase();
  const text = document.createElement('span');
  text.className = 'list-text';
  const title = document.createElement('span');
  title.className = 'list-title';
  title.textContent = entry.title || hostOf(entry.url);
  const sub = document.createElement('small');
  sub.textContent = `${new Date(entry.time).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })} · ${hostOf(entry.url)}`;
  text.append(title, sub);
  const remove = iconButton('remove', 'Remove from history', () => {
    window.browser.deleteHistory(entry.id);
    historyEntries = historyEntries.filter((e) => e.id !== entry.id);
    renderHistory();
  });
  row.addEventListener('click', () => window.browser.openUrl(entry.url));
  row.append(badge, text, remove);
  return row;
}

historySearch.addEventListener('input', () => {
  historyShown = HISTORY_PAGE;
  renderHistory();
});
$('#history-clear').addEventListener('click', () => {
  if (!confirm('Delete your whole browsing history?')) return;
  window.browser.clearHistory();
  historyEntries = [];
  renderHistory();
});
window.browser.onHistoryChanged(() => {
  if (currentPage === 'history' && open) void loadHistory();
});

// ---------------------------------------------------------------- downloads

const downloadsList = $<HTMLDivElement>('#downloads-list');
let downloads: DownloadInfo[] = [];
const speeds = new Map<
  string,
  { bytes: number; time: number; speed: number }
>();

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function downloadStatus(d: DownloadInfo) {
  const size = d.total
    ? `${formatBytes(d.received)} of ${formatBytes(d.total)}`
    : formatBytes(d.received);
  switch (d.state) {
    case 'progressing': {
      const speed = speeds.get(d.id)?.speed ?? 0;
      return speed > 0 ? `${size} · ${formatBytes(speed)}/s` : size;
    }
    case 'paused':
      return `Waiting · ${size}`;
    case 'completed':
      return d.exists
        ? `${formatBytes(d.total)} · ${hostOf(d.url)}`
        : 'File deleted or moved';
    case 'cancelled':
      return 'Cancelled';
    case 'interrupted':
      return 'Failed';
  }
}

function measureSpeeds() {
  const now = Date.now();
  for (const d of downloads) {
    const last = speeds.get(d.id);
    if (d.state !== 'progressing') {
      speeds.delete(d.id);
    } else if (!last) {
      speeds.set(d.id, { bytes: d.received, time: now, speed: 0 });
    } else if (now - last.time >= 500) {
      const current = ((d.received - last.bytes) * 1000) / (now - last.time);
      const speed = last.speed ? last.speed * 0.6 + current * 0.4 : current;
      speeds.set(d.id, { bytes: d.received, time: now, speed });
    }
  }
}

function renderDownloads() {
  if (downloads.length === 0) {
    downloadsList.replaceChildren(emptyState('No downloads yet'));
    return;
  }
  downloadsList.replaceChildren(...downloads.map(downloadRow));
}

function downloadRow(d: DownloadInfo) {
  const row = document.createElement('div');
  row.className = 'list-row download-row';
  const canOpen = d.state === 'completed' && d.exists;
  row.classList.toggle('clickable', canOpen);
  row.classList.toggle(
    'faded',
    !canOpen && d.state !== 'progressing' && d.state !== 'paused',
  );
  const fileIcon = document.createElement('span');
  fileIcon.className = 'list-icon';
  fileIcon.innerHTML = phoneIcon('file');
  const text = document.createElement('span');
  text.className = 'list-text';
  const name = document.createElement('span');
  name.className = 'list-title';
  name.textContent = d.filename || 'Download';
  const status = document.createElement('small');
  status.textContent = downloadStatus(d);
  text.append(name, status);
  if (d.state === 'progressing' || d.state === 'paused') {
    const bar = document.createElement('span');
    bar.className = 'progress';
    bar.classList.toggle('unknown', !d.total);
    const fill = document.createElement('span');
    fill.style.width = d.total
      ? `${Math.min(100, (d.received / d.total) * 100)}%`
      : '100%';
    bar.append(fill);
    text.append(bar);
  }
  const actions = document.createElement('span');
  actions.className = 'list-actions';
  const act = (action: DownloadAction) => () =>
    window.browser.downloadAction(d.id, action);
  if (d.state === 'progressing' || d.state === 'paused') {
    actions.append(iconButton('remove', 'Cancel', act('cancel')));
  } else {
    if (d.state !== 'completed') {
      actions.append(iconButton('retry', 'Try again', act('retry')));
    }
    actions.append(iconButton('remove', 'Remove from list', act('remove')));
  }
  if (canOpen) row.addEventListener('click', act('open'));
  row.append(fileIcon, text, actions);
  return row;
}

window.browser.onDownloads((list) => {
  downloads = list;
  measureSpeeds();
  $('#open-downloads').classList.toggle(
    'busy',
    list.some((d) => d.state === 'progressing'),
  );
  if (currentPage === 'downloads' && open) renderDownloads();
});
$('#downloads-folder').addEventListener('click', () =>
  window.browser.openDownloadsFolder(),
);
$('#downloads-clear').addEventListener('click', () =>
  window.browser.clearDownloads(),
);

// ---------------------------------------------------------------- settings in

window.browser.onSettingsChanged((settings) => {
  document.documentElement.dataset.theme = settings.theme;
  colors.theme = settings.theme;
  colors.backgroundTint = settings.backgroundTint;
  glassWanted = settings.liquidGlass;
  glassSource = settings.glassColors;
  applyAccent(settings.accentColor);
  for (const input of themeInputs) {
    input.checked = input.value === settings.theme;
  }
  searchEngine.value = settings.searchEngine;
  if (document.activeElement !== homePage) homePage.value = settings.homePage;
  showDividers.checked = settings.showDividers;
  smoothDividers.checked = settings.smoothDividers;
  forceDark.checked = settings.forceDark;
  scrollTabs.checked = settings.scrollTabs;
  applyDividers(settings.showDividers, settings.smoothDividers);
});
