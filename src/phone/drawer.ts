// The tabs on the phone: the desktop's sidebar as a drawer from the left.
// The same rows (icon, title, speaker, close); on a touch screen a tab is
// swiped sideways to close it, and held to drag it somewhere else (or, let
// go without moving, to get its menu).
import { closeBookmarksPop } from '../ui-bookmarks-pop';
import type { TabInfo, TabsState } from '../shared';
import { icon } from '../ui-common';
import { closeLayer, hasLayer, openLayer } from './layout';

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const body = document.body;
const drawer = $<HTMLElement>('#sidebar');
const tabList = $<HTMLUListElement>('#tabs');
const tabCount = $<HTMLSpanElement>('#tab-count');
const tabsButton = $<HTMLButtonElement>('#tabs-button');
const tabElements = new Map<number, HTMLLIElement>();
let tabOrder: number[] = [];

const CLOSE_ICON = icon('remove', 'icon-sm');
const PRIVATE_ICON = icon('eyeOff');

// ---------------------------------------------------------------- open, close

export function openDrawer() {
  body.classList.add('drawer-open');
  drawer.removeAttribute('aria-hidden');
  openLayer('drawer', closeDrawer);
  tabElements
    .get(Number(tabList.dataset.active))
    ?.scrollIntoView({ block: 'nearest' });
}

export function closeDrawer() {
  closeBookmarksPop();
  body.classList.remove('drawer-open');
  drawer.ariaHidden = 'true';
  drawer.style.transform = '';
  closeLayer('drawer');
}

export const isDrawerOpen = () => hasLayer('drawer');

tabsButton.addEventListener('click', openDrawer);
$('#close-drawer').addEventListener('click', closeDrawer);
$('#new-tab').addEventListener('click', () => {
  closeDrawer();
  window.browser.newTab();
});
$('#open-downloads').addEventListener('click', () => {
  closeDrawer();
  window.browser.showPage('downloads');
});
$('#open-settings').addEventListener('click', () => {
  closeDrawer();
  window.browser.setSettingsOpen(true);
});

// Swipe the drawer back to the left to close it: it follows the finger (the
// dimmed page lightens with it), and closes past a quarter of its width or
// on a quick flick.
{
  const scrim = $<HTMLElement>('#scrim');
  let startX = 0;
  let startY = 0;
  let sliding = false;
  let tracking = false;
  /** The last moves, for the speed when the finger lets go. */
  let lastX = 0;
  let lastTime = 0;
  let speed = 0;
  drawer.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    tracking = true;
    sliding = false;
    startX = lastX = event.clientX;
    startY = event.clientY;
    lastTime = event.timeStamp;
    speed = 0;
  });
  drawer.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!sliding) {
      if (Math.abs(dy) > 12) tracking = false;
      if (dx < -12 && Math.abs(dx) > Math.abs(dy) * 1.5 && !tabDrag) {
        sliding = true;
        drawer.classList.add('dragging');
        scrim.classList.add('dragging');
        drawer.setPointerCapture(event.pointerId);
      }
      return;
    }
    const time = event.timeStamp - lastTime;
    if (time > 0) speed = (event.clientX - lastX) / time;
    lastX = event.clientX;
    lastTime = event.timeStamp;
    const offset = Math.min(0, dx);
    drawer.style.transform = `translateX(${offset}px)`;
    scrim.style.opacity = String(1 + offset / drawer.offsetWidth);
  });
  const end = (event: PointerEvent) => {
    if (!tracking) return;
    tracking = false;
    if (!sliding) return;
    sliding = false;
    drawer.classList.remove('dragging');
    scrim.classList.remove('dragging');
    const dx = event.clientX - startX;
    drawer.style.transform = '';
    scrim.style.opacity = '';
    // A flick: faster than half a pixel per millisecond, to the left.
    const flick = speed < -0.5 && event.timeStamp - lastTime < 100;
    if (dx < -drawer.offsetWidth / 4 || flick) closeDrawer();
  };
  drawer.addEventListener('pointerup', end);
  drawer.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- tab rows

/** A tab being swiped away or dragged to a new place. */
let tabDrag: {
  id: number;
  item: HTMLLIElement;
  mode: 'wait' | 'swipe' | 'lift';
  startX: number;
  startY: number;
  timer: number;
  target: number;
} | null = null;
/** The click after a gesture isn't a tap on the tab. */
let swallowClick = false;

const HOLD_MS = 450;
const MOVE = 12;

function rowHeight() {
  const first = tabList.children[0] as HTMLElement | undefined;
  if (!first) return 0;
  const gap = parseFloat(getComputedStyle(tabList).rowGap) || 0;
  return first.offsetHeight + gap;
}

function resetShifts() {
  for (const element of tabElements.values()) {
    element.style.transform = '';
    element.classList.remove('shifted');
  }
}

function startGesture(event: PointerEvent, id: number, item: HTMLLIElement) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if ((event.target as Element).closest('button')) return;
  const drag = {
    id,
    item,
    mode: 'wait' as const,
    startX: event.clientX,
    startY: event.clientY,
    timer: 0,
    target: tabOrder.indexOf(id),
  };
  tabDrag = drag;
  drag.timer = window.setTimeout(() => {
    if (tabDrag !== drag || tabDrag.mode !== 'wait') return;
    tabDrag.mode = 'lift';
    item.classList.add('lifted');
    item.setPointerCapture(event.pointerId);
    navigator.vibrate?.(8);
  }, HOLD_MS);
}

function moveGesture(event: PointerEvent) {
  const drag = tabDrag;
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (drag.mode === 'wait') {
    if (Math.abs(dx) > MOVE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Sideways first: swipe the tab away.
      window.clearTimeout(drag.timer);
      tabDrag = { ...drag, mode: 'swipe' };
      drag.item.classList.add('swiping');
      drag.item.setPointerCapture(event.pointerId);
    } else if (Math.abs(dy) > MOVE) {
      // Up or down first: the list scrolls.
      window.clearTimeout(drag.timer);
      tabDrag = null;
    }
    return;
  }
  if (drag.mode === 'swipe') {
    drag.item.style.transform = `translateX(${dx}px)`;
    drag.item.style.opacity = String(
      Math.max(0.2, 1 - Math.abs(dx) / drag.item.offsetWidth),
    );
    return;
  }
  // Lifted: follow the finger, and make room where it would land.
  const height = rowHeight();
  const from = tabOrder.indexOf(drag.id);
  const target = Math.max(
    0,
    Math.min(tabOrder.length - 1, from + Math.round(dy / height)),
  );
  drag.target = target;
  drag.item.style.transform = `translateY(${dy}px)`;
  tabOrder.forEach((id, index) => {
    if (id === drag.id) return;
    const element = tabElements.get(id);
    if (!element) return;
    let shift = 0;
    if (from < target && index > from && index <= target) shift = -height;
    if (from > target && index < from && index >= target) shift = height;
    element.classList.add('shifted');
    element.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function endGesture(event: PointerEvent, cancelled: boolean) {
  const drag = tabDrag;
  if (!drag) return;
  tabDrag = null;
  window.clearTimeout(drag.timer);
  const { item } = drag;
  if (drag.mode === 'swipe') {
    swallowClick = true;
    const dx = event.clientX - drag.startX;
    item.classList.remove('swiping');
    if (!cancelled && Math.abs(dx) > item.offsetWidth * 0.35) {
      item.style.transform = `translateX(${Math.sign(dx) * item.offsetWidth}px)`;
      window.browser.closeTab(drag.id);
    } else {
      item.style.transform = '';
      item.style.opacity = '';
    }
    return;
  }
  if (drag.mode === 'lift') {
    swallowClick = true;
    item.classList.remove('lifted');
    item.style.transform = '';
    resetShifts();
    const moved =
      Math.abs(event.clientY - drag.startY) > MOVE ||
      Math.abs(event.clientX - drag.startX) > MOVE;
    if (cancelled) return;
    if (!moved) {
      window.terra.send('terra:tab-menu', drag.id);
      return;
    }
    const from = tabOrder.indexOf(drag.id);
    if (drag.target !== from) {
      // moveTab counts the moved tab in its old place (like the desktop).
      window.browser.moveTab(
        drag.id,
        drag.target > from ? drag.target + 1 : drag.target,
      );
    }
  }
}

// While a tab is lifted the list must not scroll under the finger.
tabList.addEventListener(
  'touchmove',
  (event) => {
    if (tabDrag && tabDrag.mode !== 'wait') event.preventDefault();
  },
  { passive: false },
);
tabList.addEventListener('contextmenu', (event) => event.preventDefault());

function createTabElement(id: number) {
  const item = document.createElement('li');
  item.className = 'tab';
  item.role = 'tab';
  item.tabIndex = 0;
  item.dataset.id = String(id);

  const tabIcon = document.createElement('span');
  tabIcon.className = 'tab-icon';
  const title = document.createElement('span');
  title.className = 'tab-title';

  const audio = document.createElement('button');
  audio.className = 'tab-audio';
  audio.hidden = true;
  audio.addEventListener('click', (event) => {
    event.stopPropagation();
    window.terra.send('terra:tab-mute', id);
  });

  const close = document.createElement('button');
  close.className = 'tab-close';
  close.title = 'Close tab';
  close.ariaLabel = 'Close tab';
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    window.browser.closeTab(id);
  });

  item.append(tabIcon, title, audio, close);
  item.addEventListener('click', () => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    window.browser.activateTab(id);
    closeDrawer();
  });
  item.addEventListener('pointerdown', (event) =>
    startGesture(event, id, item),
  );
  item.addEventListener('pointermove', moveGesture);
  item.addEventListener('pointerup', (event) => endGesture(event, false));
  item.addEventListener('pointercancel', (event) => endGesture(event, true));
  return item;
}

function renderTabIcon(element: HTMLElement, tab: TabInfo) {
  const key = tab.loading
    ? 'loading'
    : tab.isPrivate
      ? 'private'
      : (tab.favicon ?? `letter:${tab.title}`);
  if (element.dataset.key === key) return;
  element.dataset.key = key;
  element.replaceChildren();
  element.classList.remove('spinner', 'letter', 'private');
  if (tab.loading) {
    element.classList.add('spinner');
  } else if (tab.isPrivate) {
    element.classList.add('private');
    element.innerHTML = PRIVATE_ICON;
  } else if (tab.favicon) {
    const image = document.createElement('img');
    image.src = tab.favicon;
    image.alt = '';
    image.addEventListener('error', () => {
      element.dataset.key = '';
      renderTabIcon(element, { ...tab, favicon: null });
    });
    element.append(image);
  } else {
    element.classList.add('letter');
    element.textContent = (tab.title.trim()[0] ?? '•').toUpperCase();
  }
}

export function renderTabs(state: TabsState) {
  const ids = new Set(state.tabs.map((tab) => tab.id));
  for (const [id, element] of tabElements) {
    if (!ids.has(id)) {
      element.remove();
      tabElements.delete(id);
    }
  }
  tabOrder = state.tabs.map((tab) => tab.id);
  tabList.dataset.active = String(state.activeTabId ?? '');

  state.tabs.forEach((tab, index) => {
    let item = tabElements.get(tab.id);
    if (!item) {
      item = createTabElement(tab.id);
      tabElements.set(tab.id, item);
    }
    const active = tab.id === state.activeTabId && !state.settingsOpen;
    item.classList.toggle('active', active);
    item.ariaSelected = String(active);
    item.querySelector('.tab-title')!.textContent = tab.title;
    const next = state.tabs[index + 1];
    item.classList.toggle('pinned', tab.pinned);
    item.classList.toggle('pinned-last', tab.pinned && !!next && !next.pinned);
    item.classList.toggle('private', tab.isPrivate);
    const audio = item.querySelector<HTMLButtonElement>('.tab-audio')!;
    audio.hidden = !tab.audible && !tab.muted;
    const audioKey = tab.muted ? 'muted' : 'playing';
    if (audio.dataset.key !== audioKey) {
      audio.dataset.key = audioKey;
      audio.innerHTML = icon(tab.muted ? 'speakerOff' : 'speaker', 'icon-sm');
      audio.title = tab.muted ? 'Unmute tab' : 'Mute tab';
      audio.ariaLabel = audio.title;
    }
    renderTabIcon(item.querySelector<HTMLElement>('.tab-icon')!, tab);
    if (tabList.children[index] !== item) {
      tabList.insertBefore(item, tabList.children[index] ?? null);
    }
  });

  const count = state.tabs.length;
  tabCount.textContent = String(Math.min(count, 99));
  tabsButton.classList.toggle('many', count > 9);
  tabsButton.title = `${count} ${count === 1 ? 'tab' : 'tabs'}`;
  tabsButton.ariaLabel = tabsButton.title;
}
