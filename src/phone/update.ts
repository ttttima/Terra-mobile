// Terra updating itself (SelfUpdate.kt does the work): how far it is, shown
// in a bar above the toolbar and in Settings → Features → Updates, wherever
// the update was started from.
import { haptic } from './motion';

export interface UpdateProgress {
  state: 'permission' | 'downloading' | 'installing' | 'confirm' | 'failed';
  /** 0 to 100 while downloading. */
  percent: number;
  message: string | null;
  version: string;
  /** Android lets the new Terra open again by itself. */
  reopens: boolean;
}

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const bar = $<HTMLDivElement>('#update-bar');
const barText = $<HTMLSpanElement>('#update-bar-text');
const barProgress = $<HTMLSpanElement>('#update-bar-progress');
const rowStatus = $<HTMLElement>('#update-status');
const rowButton = $<HTMLButtonElement>('#update-button');
const rowProgress = $<HTMLSpanElement>('#update-progress');

/** The update under way, if any. */
let current: UpdateProgress | null = null;
let hideTimer = 0;

function describe(progress: UpdateProgress) {
  const name = `Terra ${progress.version}`.trim();
  switch (progress.state) {
    case 'permission':
      return `Allow Terra to install ${name}, then come back`;
    case 'downloading':
      return `Downloading ${name}… ${progress.percent}%`;
    case 'installing':
      return progress.reopens
        ? `Installing ${name}. Terra closes and opens again.`
        : `Installing ${name}. Terra closes: open it again in a moment.`;
    case 'confirm':
      return `Android asks whether to install ${name}`;
    case 'failed':
      return `The update didn't work: ${progress.message ?? 'try again'}`;
  }
}

function fill(element: HTMLElement, progress: UpdateProgress) {
  const waiting = progress.state !== 'downloading';
  element.classList.toggle('unknown', waiting);
  element.hidden = progress.state === 'failed';
  (element.firstElementChild as HTMLElement).style.width =
    `${waiting ? 100 : Math.max(2, progress.percent)}%`;
}

/** The Updates row in settings, which ui-pages.ts also writes to. */
function paintRow() {
  if (!current) return;
  const text = describe(current);
  const busy = current.state !== 'failed';
  if (rowStatus.textContent !== text) rowStatus.textContent = text;
  if (rowButton.disabled !== busy) rowButton.disabled = busy;
  fill(rowProgress, current);
}

// ui-pages.ts fills the row in again when the page is opened: an update
// under way keeps showing.
new MutationObserver(paintRow).observe(rowStatus, {
  childList: true,
  characterData: true,
  subtree: true,
});
new MutationObserver(paintRow).observe(rowButton, {
  attributes: true,
  attributeFilter: ['disabled'],
});

window.terra.on<UpdateProgress>('terra:update-progress', (progress) => {
  window.clearTimeout(hideTimer);
  const before = current?.state;
  current = progress;
  bar.hidden = false;
  barText.textContent = describe(progress);
  fill(barProgress, progress);
  paintRow();
  if (progress.state === 'installing' && before !== 'installing') {
    haptic('click');
  }
  if (progress.state === 'failed') {
    // The row says why; the button is there to try again.
    current = null;
    rowProgress.hidden = true;
    hideTimer = window.setTimeout(() => (bar.hidden = true), 6000);
  }
});

// ---------------------------------------------------------------- opening again

// Android closes Terra to update it. It may open again by itself only
// with Android's "Display over other apps" permission, which the user
// turns on in Android's own settings.
const reopenStatus = $<HTMLElement>('#reopen-status');
const reopenButton = $<HTMLButtonElement>('#reopen-button');

async function showReopen() {
  const allowed = await window.terra.invoke<boolean>('terra:update-can-reopen');
  reopenStatus.textContent = allowed
    ? 'Terra opens again by itself when an update is done'
    : 'Android closes Terra to update it. Allow "Display over other apps" and it opens again by itself. Terra never draws over anything.';
  reopenButton.hidden = allowed;
}

reopenButton.addEventListener('click', () =>
  window.terra.send('terra:update-allow-reopen'),
);
// Coming back from Android's settings.
window.browser.onWindowFocus(() => void showReopen());
void showReopen();
