// Menus on the phone: the ⋮ button, a long press on a tab, a bookmark or a
// link, the lock. brain.ts builds them (like Menu.buildFromTemplate on the
// desktop); here they slide up from the bottom as a sheet.
import type { MenuItem } from './brain';
import { phoneIcon } from './icons';
import { closeLayer, openLayer } from './layout';

const sheet = document.querySelector<HTMLDivElement>('#sheet')!;
const terra = window.terra;

/** The menus shown, the last one on top (a submenu over its menu). */
let stack: { items: MenuItem[]; title?: string }[] = [];
let hideTimer = 0;

function duration() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--duration')
    .trim();
  return value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000;
}

function button(item: MenuItem, className: string) {
  const element = document.createElement('button');
  element.className = className;
  element.disabled = item.enabled === false;
  element.title = item.label ?? '';
  element.ariaLabel = item.label ?? '';
  element.innerHTML = phoneIcon(item.icon ?? '');
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
    case 'stepper': {
      const line = document.createElement('div');
      line.className = 'sheet-row';
      line.innerHTML = phoneIcon(item.icon ?? '');
      const label = document.createElement('span');
      label.className = 'sheet-label';
      label.textContent = item.label ?? '';
      const controls = document.createElement('span');
      controls.className = 'sheet-stepper';
      const [less, more] = item.items ?? [];
      const value = document.createElement('span');
      value.className = 'sheet-detail';
      value.textContent = item.detail ?? '';
      if (less) controls.append(button(less, 'icon-button'));
      controls.append(value);
      if (more) controls.append(button(more, 'icon-button'));
      line.append(label, controls);
      return line;
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

function render() {
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
  sheet.replaceChildren(...rows);
}

function pick(item: MenuItem) {
  if (item.id === -1) {
    stack.pop();
    render();
    return;
  }
  if (item.submenu) {
    stack.push({ items: item.submenu, title: item.label });
    render();
    return;
  }
  terra.send('terra:menu-pick', item.id, item.keepOpen === true);
  if (!item.keepOpen) closeSheet(false);
}

function openSheet() {
  window.clearTimeout(hideTimer);
  sheet.hidden = false;
  sheet.scrollTop = 0;
  // Next frame, so it slides in from below.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => sheet.classList.add('open')),
  );
  openLayer('sheet', () => closeSheet());
}

export function closeSheet(notify = true) {
  if (sheet.hidden) return;
  sheet.classList.remove('open');
  closeLayer('sheet');
  stack = [];
  hideTimer = window.setTimeout(() => {
    sheet.hidden = true;
    sheet.replaceChildren();
  }, duration());
  if (notify) terra.send('terra:menu-close');
}

export const isSheetOpen = () => !sheet.hidden && stack.length > 0;

terra.on<{ title?: string; items: MenuItem[] }>('terra:menu', (menu) => {
  stack = [{ items: menu.items, title: menu.title }];
  render();
  openSheet();
});

terra.on<{ items: MenuItem[] }>('terra:menu-update', ({ items }) => {
  if (!stack.length) return;
  stack[0] = { ...stack[0], items };
  if (stack.length === 1) render();
});
