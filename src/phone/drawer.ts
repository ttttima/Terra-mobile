// The tabs on the phone: the desktop's sidebar as a drawer from the left.
// The same rows (icon, title, speaker, close); on a touch screen a tab is
// swiped sideways to close it, and held to drag it somewhere else (or, let
// go without moving, to get its menu).
//
// Everything here moves on springs (motion.ts): the drawer follows the
// finger and is thrown open or shut, a swiped tab flies off as fast as it
// was thrown, and the other rows glide into the room it leaves.
import { closeBookmarksPop } from '../ui-bookmarks-pop';
import type { TabInfo, TabsState } from '../shared';
import { icon } from '../ui-common';
import { closeLayer, dim, openLayer } from './layout';
import {
  LIVELY,
  SMOOTH,
  Spring,
  Tracker,
  glide,
  haptic,
  play,
  project,
  rubberband,
} from './motion';

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

/** A flick faster than this (px/s) shows as a little bounce on landing. */
const THROWN = 300;

// ---------------------------------------------------------------- open, close

let isOpen = false;
/** Where the drawer is fully away: its width and its shadow off screen. */
const closedAt = () => -(drawer.offsetWidth + 16);
/** The drawer's place: 0 when open, closedAt() when away. */
const slide = new Spring(0, (x) => {
  drawer.style.transform = `translateX(${x}px)`;
  dim('drawer', 1 - x / closedAt());
});
/** Away and still: the stylesheet holds it off screen. */
const parked = () => !isOpen && !slide.moving && !drawer.style.transform;

export function openDrawer(velocity = 0) {
  if (parked()) slide.value = closedAt();
  if (!isOpen) {
    isOpen = true;
    body.classList.add('drawer-open');
    drawer.removeAttribute('aria-hidden');
    openLayer('drawer', () => closeDrawer());
    tabElements
      .get(Number(tabList.dataset.active))
      ?.scrollIntoView({ block: 'nearest' });
  }
  slide.to(0, {
    velocity,
    ...(Math.abs(velocity) > THROWN ? LIVELY : SMOOTH),
  });
}

export function closeDrawer(velocity = 0) {
  closeBookmarksPop();
  if (parked()) return;
  if (isOpen) {
    isOpen = false;
    body.classList.remove('drawer-open');
    drawer.ariaHidden = 'true';
    closeLayer('drawer');
  }
  slide.to(closedAt(), {
    velocity,
    onRest: () => {
      drawer.style.transform = '';
      dim('drawer', 0);
    },
  });
}

export const isDrawerOpen = () => isOpen;

tabsButton.addEventListener('click', () => openDrawer());
$('#close-drawer').addEventListener('click', () => closeDrawer());
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

// The drawer under a finger: it goes where the finger goes (pulled past
// open it gives a little, like a rubber band), and let go it lands where
// the throw was heading. It can be caught again while it's still moving.
{
  const tracker = new Tracker();
  let startX = 0;
  let startY = 0;
  let grab = 0;
  let tracking = false;
  let sliding = false;
  const hold = (event: PointerEvent) => {
    sliding = true;
    // From where it is now, and from where the finger took hold of it.
    slide.set(slide.value);
    grab = event.clientX - slide.value;
    tracker.reset();
    tracker.add(event.clientX, event.timeStamp);
    drawer.setPointerCapture(event.pointerId);
  };
  const follow = (event: PointerEvent) => {
    const x = event.clientX - grab;
    slide.set(x > 0 ? rubberband(x, drawer.offsetWidth) : x);
  };
  drawer.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') return;
    tracking = true;
    sliding = false;
    startX = event.clientX;
    startY = event.clientY;
    if (slide.moving) hold(event);
  });
  drawer.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    if (!sliding) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dy) > 12) tracking = false;
      else if (dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.5 && !tabDrag) {
        hold(event);
      }
      return;
    }
    tracker.add(event.clientX, event.timeStamp);
    follow(event);
  });
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!tracking) return;
    tracking = false;
    if (!sliding) return;
    sliding = false;
    swallowClick = true;
    setTimeout(() => (swallowClick = false));
    let velocity = 0;
    if (!cancelled) {
      velocity = tracker.release(event.clientX, event.timeStamp);
      follow(event);
    }
    const landing = slide.value + project(velocity);
    if (!cancelled && landing < closedAt() / 2) closeDrawer(velocity);
    else openDrawer(velocity);
  };
  drawer.addEventListener('pointerup', (event) => end(event, false));
  drawer.addEventListener('pointercancel', (event) => end(event, true));
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
  /** A swiped row's place, sideways. */
  swipe?: Spring;
} | null = null;
/** The click after a gesture isn't a tap on the tab. */
let swallowClick = false;
const swipeTracker = new Tracker();

const HOLD_MS = 450;
const MOVE = 12;

function rowHeight() {
  const first = tabList.children[0] as HTMLElement | undefined;
  if (!first) return 0;
  const gap = parseFloat(getComputedStyle(tabList).rowGap) || 0;
  return first.offsetHeight + gap;
}

/** Rows back where the list puts them (after a drag made room). */
function clearDragStyles() {
  for (const element of tabElements.values()) {
    if (element.dataset.thrown) continue;
    element.style.transform = '';
    element.classList.remove('shifted', 'lifted');
  }
}

/** The rows glide back to their own places. */
function settle(item: HTMLLIElement) {
  item.classList.add('settling');
  setTimeout(() => item.classList.remove('settling'), 400);
  glide(tabElements.values(), clearDragStyles);
}

function startGesture(event: PointerEvent, id: number, item: HTMLLIElement) {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if ((event.target as Element).closest('button')) return;
  if (item.dataset.thrown) return;
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
    haptic('lift');
  }, HOLD_MS);
}

function moveGesture(event: PointerEvent) {
  const drag = tabDrag;
  if (!drag) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  if (drag.mode === 'wait') {
    if (Math.abs(dx) > MOVE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // Sideways first: swipe the tab away. It starts from under the
      // finger as it is now, so it doesn't jump the first 12 pixels.
      window.clearTimeout(drag.timer);
      const { item } = drag;
      const swipe = new Spring(0, (x) => {
        item.style.transform = `translateX(${x}px)`;
        item.style.opacity = String(
          Math.max(0, 1 - Math.abs(x) / item.offsetWidth),
        );
      });
      tabDrag = { ...drag, mode: 'swipe', startX: event.clientX, swipe };
      item.classList.add('swiping');
      item.setPointerCapture(event.pointerId);
      swipeTracker.reset();
      swipeTracker.add(event.clientX, event.timeStamp);
    } else if (Math.abs(dy) > MOVE) {
      // Up or down first: the list scrolls.
      window.clearTimeout(drag.timer);
      tabDrag = null;
    }
    return;
  }
  if (drag.mode === 'swipe') {
    swipeTracker.add(event.clientX, event.timeStamp);
    drag.swipe?.set(dx);
    return;
  }
  // Lifted: follow the finger, and make room where it would land.
  const height = rowHeight();
  const from = tabOrder.indexOf(drag.id);
  const target = Math.max(
    0,
    Math.min(tabOrder.length - 1, from + Math.round(dy / height)),
  );
  if (target !== drag.target) haptic('tick');
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
  if (drag.mode === 'swipe' && drag.swipe) {
    swallowClick = true;
    setTimeout(() => (swallowClick = false));
    const { swipe } = drag;
    const width = item.offsetWidth;
    let velocity = 0;
    if (!cancelled) {
      velocity = swipeTracker.release(event.clientX, event.timeStamp);
      swipe.set(event.clientX - drag.startX);
    }
    // Where the throw is heading decides, not where the finger let go.
    const landing = swipe.value + project(velocity);
    const back = () =>
      swipe.to(0, {
        velocity,
        ...LIVELY,
        onRest: () => {
          item.classList.remove('swiping');
          item.style.transform = '';
          item.style.opacity = '';
          delete item.dataset.thrown;
        },
      });
    if (cancelled || Math.abs(landing) < width / 2) return back();
    // Thrown away: it flies on at the finger's speed while the tab closes.
    const side = Math.sign(landing);
    item.dataset.thrown = '1';
    haptic('tick');
    swipe.to(side * (width + 32), {
      velocity: Math.sign(velocity) === side ? velocity : 0,
      onRest: () => {
        if (item.classList.contains('leaving')) item.remove();
      },
    });
    window.browser.closeTab(drag.id);
    // Should the tab stay after all, the row comes back.
    setTimeout(() => {
      if (tabElements.get(drag.id) === item) back();
    }, 800);
    return;
  }
  if (drag.mode === 'lift') {
    swallowClick = true;
    setTimeout(() => (swallowClick = false));
    const moved =
      Math.abs(event.clientY - drag.startY) > MOVE ||
      Math.abs(event.clientX - drag.startX) > MOVE;
    const from = tabOrder.indexOf(drag.id);
    if (cancelled || !moved || drag.target === from) {
      settle(item);
      if (!cancelled && !moved) window.terra.send('terra:tab-menu', drag.id);
      return;
    }
    haptic('click');
    item.classList.add('settling');
    setTimeout(() => item.classList.remove('settling'), 400);
    // The new order comes back through renderTabs, which glides every row
    // from where the drag left it. moveTab counts the moved tab in its old
    // place (like the desktop).
    window.browser.moveTab(
      drag.id,
      drag.target > from ? drag.target + 1 : drag.target,
    );
    setTimeout(() => {
      if (!tabDrag && item.style.transform) settle(item);
    }, 200);
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

/** A closed tab's row fades where it stood while the others move up. */
function leave(element: HTMLLIElement) {
  element.style.top = `${element.offsetTop}px`;
  element.style.left = `${element.offsetLeft}px`;
  element.style.width = `${element.offsetWidth}px`;
  element.classList.add('leaving');
  tabList.append(element);
  // Thrown off by a swipe: it is already on its way out.
  if (element.dataset.thrown) {
    setTimeout(() => element.remove(), 1000);
    return;
  }
  const fade = isOpen
    ? play(element, [
        { opacity: 1, scale: '1' },
        { opacity: 0, scale: '0.92' },
      ])
    : null;
  if (!fade) return element.remove();
  element.style.opacity = '0';
  fade.finished.then(
    () => element.remove(),
    () => element.remove(),
  );
}

export function renderTabs(state: TabsState) {
  const ids = new Set(state.tabs.map((tab) => tab.id));
  const staying = [...tabElements.values()].filter((element) =>
    ids.has(Number(element.dataset.id)),
  );
  const added: HTMLLIElement[] = [];

  const change = () => {
    for (const [id, element] of tabElements) {
      if (!ids.has(id)) {
        tabElements.delete(id);
        leave(element);
      }
    }
    // A dragged row was dropped: every row goes to its real place.
    if (!tabDrag) clearDragStyles();
    tabOrder = state.tabs.map((tab) => tab.id);
    tabList.dataset.active = String(state.activeTabId ?? '');

    state.tabs.forEach((tab, index) => {
      let item = tabElements.get(tab.id);
      if (!item) {
        item = createTabElement(tab.id);
        tabElements.set(tab.id, item);
        added.push(item);
      }
      const active = tab.id === state.activeTabId && !state.settingsOpen;
      item.classList.toggle('active', active);
      item.ariaSelected = String(active);
      item.querySelector('.tab-title')!.textContent = tab.title;
      const next = state.tabs[index + 1];
      item.classList.toggle('pinned', tab.pinned);
      item.classList.toggle(
        'pinned-last',
        tab.pinned && !!next && !next.pinned,
      );
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
  };

  // With the drawer in view the rows glide to their new places and new
  // ones grow in; out of view there is nothing to see.
  if (isOpen || slide.moving) {
    glide(staying, change);
    for (const item of added) {
      play(
        item,
        [
          { opacity: 0, scale: '0.92' },
          { opacity: 1, scale: '1' },
        ],
        { lively: true },
      );
    }
  } else {
    change();
  }

  const count = state.tabs.length;
  const shown = String(Math.min(count, 99));
  if (tabCount.textContent !== shown) {
    // The number lands with a small bounce when a tab opens or closes.
    if (tabCount.textContent) {
      play(tabCount, [{ scale: '1.4' }, { scale: '1' }], { lively: true });
    }
    tabCount.textContent = shown;
  }
  tabsButton.classList.toggle('many', count > 9);
  tabsButton.title = `${count} ${count === 1 ? 'tab' : 'tabs'}`;
  tabsButton.ariaLabel = tabsButton.title;
}
