// The phone's preload.ts: the same window.browser and window.terra API the
// desktop UI uses, answered by brain.ts in this page instead of by the main
// process. Imported first, so the shared UI modules find it.
import type {
  BrowserState,
  DefaultBrowserState,
  DownloadAction,
  DownloadInfo,
  HistoryEntry,
  PageEdges,
  PanelPage,
  Settings,
  TabsState,
} from '../shared';
import { commands, onBrain, queries } from './brain';

// The desktop's BrowserAPI (renderer.ts there), so the shared UI modules
// type-check the same way here.
interface BrowserAPI {
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
  stop: () => void;
  newTab: () => void;
  closeTab: (id: number) => void;
  activateTab: (id: number) => void;
  moveTab: (id: number, toIndex: number) => void;
  toggleSidebar: () => void;
  getHistory: () => Promise<HistoryEntry[]>;
  deleteHistory: (id: string) => void;
  clearHistory: () => void;
  openUrl: (url: string) => void;
  downloadAction: (id: string, action: DownloadAction) => void;
  clearDownloads: () => void;
  openDownloadsFolder: () => void;
  showPage: (page: PanelPage) => void;
  onDownloads: (callback: (downloads: DownloadInfo[]) => void) => void;
  onHistoryChanged: (callback: () => void) => void;
  onShowPage: (callback: (page: PanelPage) => void) => void;
  windowAction: (action: 'close' | 'minimize' | 'maximize') => void;
  platform: string;
  mouseButton: (button: number) => void;
  setRecordingBinding: (on: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  updateSettings: (changes: Partial<Settings>) => void;
  clearBrowsingData: () => Promise<boolean>;
  getDefaultBrowser: () => Promise<DefaultBrowserState>;
  makeDefaultBrowser: () => void;
  onStateChanged: (callback: (state: BrowserState) => void) => void;
  onTabsChanged: (callback: (state: TabsState) => void) => void;
  onSettingsChanged: (callback: (settings: Settings) => void) => void;
  onPageEdges: (callback: (edges: PageEdges) => void) => void;
  onWindowFocus: (callback: (focused: boolean) => void) => void;
  onFocusAddress: (callback: () => void) => void;
}

declare global {
  interface Window {
    browser: BrowserAPI;
  }
}

type Command = (...args: unknown[]) => unknown;

function send(name: string, ...args: unknown[]) {
  const command = commands[name] as Command | undefined;
  if (command) command(...args);
  else console.warn(`Terra: no command ${name}`);
}

async function invoke<T>(name: string, ...args: unknown[]): Promise<T> {
  const query = queries[name] as Command | undefined;
  if (!query) throw new Error(`Terra: no query ${name}`);
  return (await query(...args)) as T;
}

const on =
  <T>(channel: string) =>
  (callback: (payload: T) => void) =>
    onBrain(channel, (payload) => callback(payload as T));

const browser: Window['browser'] = {
  navigate: (url) => send('navigate', url),
  back: () => send('back'),
  forward: () => send('forward'),
  reload: () => send('reload'),
  stop: () => send('stop'),
  newTab: () => send('newTab'),
  closeTab: (id) => send('closeTab', id),
  activateTab: (id) => send('activateTab', id),
  moveTab: (id, toIndex) => send('moveTab', id, toIndex),
  // No compact sidebar on a phone: the tabs open in a drawer.
  toggleSidebar: () => {},
  getHistory: () => invoke('getHistory'),
  deleteHistory: (id) => send('deleteHistory', id),
  clearHistory: () => send('clearHistory'),
  openUrl: (url) => send('openUrl', url),
  downloadAction: (id, action) => send('downloadAction', id, action),
  clearDownloads: () => send('clearDownloads'),
  openDownloadsFolder: () => send('openDownloadsFolder'),
  showPage: (page) => send('showPage', page),
  onDownloads: on<DownloadInfo[]>('browser:downloads'),
  onHistoryChanged: (callback) =>
    onBrain('browser:history-changed', () => callback()),
  onShowPage: on<PanelPage>('browser:show-page'),
  windowAction: () => {},
  platform: 'android',
  mouseButton: () => {},
  setRecordingBinding: () => {},
  setSettingsOpen: (open) => send('setSettingsOpen', open),
  updateSettings: (changes) => send('updateSettings', changes),
  clearBrowsingData: () => invoke('clearBrowsingData'),
  getDefaultBrowser: () => invoke('getDefaultBrowser'),
  makeDefaultBrowser: () => send('makeDefaultBrowser'),
  onStateChanged: on<BrowserState>('browser:state'),
  onTabsChanged: on<TabsState>('browser:tabs'),
  onSettingsChanged: on<Settings>('browser:settings'),
  onPageEdges: on<PageEdges>('browser:page-edges'),
  onWindowFocus: on<boolean>('browser:window-focus'),
  onFocusAddress: (callback) =>
    onBrain('browser:focus-address', () => callback()),
};

window.browser = browser;

window.terra = {
  send,
  invoke,
  on: (channel, callback) =>
    onBrain(channel, (payload) => callback(payload as never)),
  pathForFile: () => '',
};
