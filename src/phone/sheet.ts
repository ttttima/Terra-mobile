// Menus on the phone: the ⋮ button, a long press on a tab, a bookmark or a
// link, the lock. brain.ts builds them (like Menu.buildFromTemplate on the
// desktop); here they come up from the bottom as a sheet.
//
// The sheet moves on a spring (motion.ts): it rises from below, can be
// pulled down and thrown away with a finger, and grows or shrinks to fit
// when a submenu opens.
import type { MenuItem } from './brain';
import { phoneIcon } from './icons';
import { closeLayer, dim, openLayer } from './layout';
import {
  LIVELY,
  SMOOTH,
  Spring,
  Tracker,
  haptic,
  play,
  project,
  rubberband,
} from './motion';

const sheet = document.querySelector<HTMLDivElement>('#sheet')!;
const terra = window.terra;

/** The menus shown, the last one on top (a submenu over its menu). */
let stack: { items: MenuItem[]; title?: string }[] = [];

// ---------------------------------------------------------------- moving

/** How far down the sheet is fully away: below the screen's edge. */
const awayAt = () => innerHeight - sheet.offsetTop + 16;
/** The sheet's place: 0 when up, awayAt() when away. */
const rise = new Spring(0, (y) => {
  sheet.style.transform = `translateY(${y}px)`;
  dim('sheet', 1 - y / awayAt());
});
/** Its height while it changes to fit another menu. */
const fit = new Spring(0, (height) => {
  sheet.style.height = `${height}px`;
});

function put() {
  sheet.replaceChildren();
  sheet.hidden = true;
  sheet.style.transform = '';
  sheet.style.height = '';
  dim('sheet', 0);
}

function openSheet() {
  if (sheet.hidden) {
    sheet.hidden = false;
    sheet.scrollTop = 0;
    rise.set(awayAt());
  }
  rise.to(0, SMOOTH);
  openLayer('sheet', () => closeSheet());
}

export function closeSheet(notify = true, velocity = 0) {
  if (sheet.hidden || !stack.length) return;
  stack = [];
  closeLayer('sheet');
  fit.stop();
  rise.to(awayAt(), { velocity, onRest: put });
  if (notify) terra.send('terra:menu-close');
}

export const isSheetOpen = () => !sheet.hidden && stack.length > 0;

// Pulled down with a finger: it follows (pulled up, it gives a little),
// and let go it lands where the throw was heading: away, or back up.
{
  const tracker = new Tracker();
  let startX = 0;
  let startY = 0;
  let grab = 0;
  let tracking = false;
  let pulling = false;
  let swallow = false;
  const hold = (event: PointerEvent) => {
    pulling = true;
    rise.set(rise.value);
    grab = event.clientY - rise.value;
    tracker.reset();
    tracker.add(event.clientY, event.timeStamp);
    sheet.setPointerCapture(event.pointerId);
  };
  const follow = (event: PointerEvent) => {
    const y = event.clientY - grab;
    rise.set(y < 0 ? rubberband(y, sheet.offsetHeight) : y);
  };
  sheet.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' || !stack.length) return;
    tracking = true;
    pulling = false;
    startX = event.clientX;
    startY = event.clientY;
    if (rise.moving) hold(event);
  });
  sheet.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    if (!pulling) {
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      const fits = sheet.scrollHeight <= sheet.clientHeight;
      if (Math.abs(dx) > 12) tracking = false;
      // A long menu scrolls first; at its top it comes down with the finger.
      else if (dy > 8 && sheet.scrollTop <= 0) hold(event);
      else if (dy < -8 && fits) hold(event);
      return;
    }
    tracker.add(event.clientY, event.timeStamp);
    follow(event);
  });
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!tracking) return;
    tracking = false;
    if (!pulling) return;
    pulling = false;
    swallow = true;
    setTimeout(() => (swallow = false));
    let velocity = 0;
    if (!cancelled) {
      velocity = tracker.release(event.clientY, event.timeStamp);
      follow(event);
    }
    const landing = rise.value + project(velocity);
    if (!cancelled && landing > sheet.offsetHeight * 0.4) {
      closeSheet(true, velocity);
    } else {
      rise.to(0, { velocity, ...(Math.abs(velocity) > 300 ? LIVELY : SMOOTH) });
    }
  };
  sheet.addEventListener('pointerup', (event) => end(event, false));
  sheet.addEventListener('pointercancel', (event) => end(event, true));
  // The tap that ends a pull isn't a choice.
  sheet.addEventListener(
    'click',
    (event) => {
      if (swallow) event.stopPropagation();
    },
    true,
  );
}

// ---------------------------------------------------------------- rows

function button(item: MenuItem, className: string) {
  const element = document.createElement('button');
  element.className = className;
  element.disabled = item.enabled === false;
  element.title = item.label ?? '';
  element.ariaLabel = item.label ?? '';
  element.innerHTML = phoneIcon(item.icon ?? '');
  element.dataset.icon = item.icon ?? '';
  element.classList.toggle('checked', item.checked === true);
  element.addEventListener('click', () => pick(item));
  return element;
}

function row(item: MenuItem): HTMLElement {
  switch (item.kind) {
    case 'separator': {
      const line = document.createElement('div');
      line.className = 'sheet-separator';
      line.role = 'separator';
      return line;
    }
    case 'header': {
      const header = document.createElement('div');
      header.className = 'sheet-header';
      header.textContent = item.label ?? '';
      return header;
    }
    case 'icons': {
      const icons = document.createElement('div');
      icons.className = 'sheet-icons';
      icons.append(
        ...(item.items ?? []).map((child) => button(child, 'icon-button')),
      );
      return icons;
    }
    default: {
      const line = document.createElement('button');
      line.className = 'sheet-row';
      line.role = item.kind === 'checkbox' ? 'menuitemcheckbox' : 'menuitem';
      line.disabled = item.enabled === false;
      line.innerHTML = phoneIcon(item.icon ?? '');
      const label = document.createElement('span');
      label.className = 'sheet-label';
      label.textContent = item.label ?? '';
      line.append(label);
      if (item.checked) {
        line.insertAdjacentHTML('beforeend', phoneIcon('check', 'sheet-check'));
        line.ariaChecked = 'true';
      }
      if (item.submenu) {
        line.insertAdjacentHTML('beforeend', phoneIcon('chevron'));
      }
      line.addEventListener('click', () => pick(item));
      return line;
    }
  }
}

/**
 * Shows the top menu. `from` says how it got there: 1 into a submenu (its
 * rows come in from the right), -1 back out (from the left), 0 as it is.
 */
function render(from: -1 | 0 | 1 = 0) {
  const top = stack.at(-1);
  if (!top) return;
  const rows: HTMLElement[] = [];
  if (stack.length > 1) {
    rows.push(
      row({
        id: -1,
        kind: 'normal',
        label: top.title ?? 'Back',
        icon: 'back',
      }),
    );
    rows.push(row({ id: -2, kind: 'separator' }));
  }
  rows.push(...top.items.map(row));

  // The sheet grows or shrinks to the new menu instead of jumping.
  const before = from && !sheet.hidden ? sheet.offsetHeight : 0;
  fit.stop();
  sheet.style.height = '';
  sheet.replaceChildren(...rows);
  // A menu that fits can be pulled by hand; a longer one scrolls.
  sheet.style.touchAction =
    sheet.scrollHeight <= sheet.clientHeight ? 'none' : 'pan-y';
  if (!from) return;
  sheet.scrollTop = 0;
  const after = sheet.offsetHeight;
  if (before && Math.abs(after - before) > 1) {
    fit.set(before);
    fit.to(after, { onRest: () => (sheet.style.height = '') });
  }
  for (const element of rows) {
    play(element, [
      { opacity: 0, transform: `translateX(${from * 24}px)` },
      { opacity: 1, transform: 'none' },
    ]);
  }
}

function pick(item: MenuItem) {
  if (item.id === -1) {
    stack.pop();
    render(-1);
    return;
  }
  if (item.submenu) {
    stack.push({ items: item.submenu, title: item.label });
    render(1);
    return;
  }
  terra.send('terra:menu-pick', item.id, item.keepOpen === true);
  if (!item.keepOpen) closeSheet(false);
}

/** The icons that are on (the star of a bookmarked page). */
const checkedIcons = () =>
  new Set(
    [...sheet.querySelectorAll<HTMLElement>('.icon-button.checked')].map(
      (element) => element.dataset.icon,
    ),
  );

terra.on<{ title?: string; items: MenuItem[] }>('terra:menu', (menu) => {
  stack = [{ items: menu.items, title: menu.title }];
  render();
  openSheet();
});

terra.on<{ items: MenuItem[] }>('terra:menu-update', ({ items }) => {
  if (!stack.length) return;
  stack[0] = { ...stack[0], items };
  if (stack.length !== 1) return;
  const before = checkedIcons();
  render();
  // What was just turned on answers with a small pop.
  for (const element of sheet.querySelectorAll<HTMLElement>(
    '.icon-button.checked',
  )) {
    if (before.has(element.dataset.icon)) continue;
    haptic('click');
    play(element, [{ scale: '0.6' }, { scale: '1' }], { lively: true });
  }
});
