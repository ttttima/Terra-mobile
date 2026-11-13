// Terra for Android: the UI page. The API comes first (api.ts, in place of
// the desktop's preload), then the shared desktop modules and the phone's
// own ones, and finally brain.ts starts and sends the user's setup.
import './api';
import './phone.css';
import '../ui-backdrop';
import '../ui-pages';
import { closeBookmarksPop } from '../ui-bookmarks-pop';
import { start } from './brain';
import { closeDrawer, renderTabs } from './drawer';
import { closeLayer } from './layout';
import { closeSheet } from './sheet';
import { setSettingsVisible } from './settings';
import './toolbar';
import './update';

const body = document.body;
const startPage = document.querySelector<HTMLElement>('#start-page')!;
const startSearch = document.querySelector<HTMLInputElement>('#start-search')!;
const privateNote = document.querySelector<HTMLElement>('#private-note')!;

body.classList.add('platform-android');

window.browser.onTabsChanged((state) => {
  renderTabs(state);
  body.classList.toggle('fullscreen', state.fullScreen);
  setSettingsVisible(state.settingsOpen);
  if (state.settingsOpen) {
    closeDrawer();
    closeSheet();
    closeBookmarksPop();
  }
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  const showStart =
    !!active?.isNewTab && !state.settingsOpen && !state.fullScreen;
  if (startPage.hidden === showStart) {
    startPage.hidden = !showStart;
    body.classList.toggle('start-open', showStart);
    if (showStart) startSearch.value = '';
    else {
      startSearch.blur();
      closeLayer('start-search');
    }
  }
  privateNote.hidden = !active?.isPrivate;
  resolveTabs();
});

// ---- first paint
//
// The app shows its own background until the UI looks like the user set
// it up (their colors, their tabs); then it's told to show this page.

let resolveTabs = () => {};
let resolveSettings = () => {};
const tabsSeen = new Promise<void>((r) => (resolveTabs = r));
const settingsSeen = new Promise<void>((r) => (resolveSettings = r));
window.browser.onSettingsChanged(() => resolveSettings());
void Promise.all([tabsSeen, settingsSeen]).then(() =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      body.classList.remove('starting');
      window.terra.send('terra:ui-ready');
    }),
  ),
);

// Long presses in our own UI never open the system's text menu, except
// in fields.
document.addEventListener('contextmenu', (event) => {
  const target = event.target as HTMLElement;
  if (!target.closest('input, textarea')) event.preventDefault();
});

start();
