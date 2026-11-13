// Where things are on the phone's screen.
//
// The web page is a native view under this page. #page-area is where it
// shows: its place is sent to the app (which puts the page there and
// passes it the touches), and the background around it gets a hole of the
// same rounded shape (--hole). Drawers, menus and settings are "layers":
// while one is open every touch comes here, and Android's Back closes the
// top one.
import { onHost, post } from './host';

const root = document.documentElement;
const body = document.body;
const pageArea = document.querySelector<HTMLElement>('#page-area')!;

interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
  ime: number;
}

let insets: Insets = { top: 0, bottom: 0, left: 0, right: 0, ime: 0 };
let pageVisible = false;

// ---------------------------------------------------------------- layers

interface Layer {
  name: string;
  close: () => void;
  /** Takes every touch (the page can't be used while it's open). */
  capture: boolean;
}

const layers: Layer[] = [];

export function openLayer(name: string, close: () => void, capture = true) {
  const index = layers.findIndex((layer) => layer.name === name);
  if (index !== -1) layers.splice(index, 1);
  layers.push({ name, close, capture });
  update();
}

export function closeLayer(name: string) {
  const index = layers.findIndex((layer) => layer.name === name);
  if (index === -1) return;
  layers.splice(index, 1);
  update();
}

export const hasLayer = (name: string) =>
  layers.some((layer) => layer.name === name);

// Tapping the dimmed page closes the drawer or menu on top.
const scrim = document.querySelector<HTMLElement>('#scrim')!;
scrim.addEventListener('click', () => layers.at(-1)?.close());

/**
 * How far the drawer or a menu is out (0 to 1): the page under it dims
 * that much, following it frame by frame instead of fading on its own.
 */
const dimmed = new Map<string, number>();
export function dim(name: string, amount: number) {
  if (amount > 0.001) dimmed.set(name, Math.min(1, amount));
  else dimmed.delete(name);
  const most = Math.max(0, ...dimmed.values());
  scrim.style.opacity = most ? most.toFixed(3) : '';
}

/** Android's Back: closes the top layer, or goes back in the browser. */
window.terra.on('terra:back', () => {
  const top = layers.at(-1);
  if (top) top.close();
  else window.terra.send('terra:back');
});

// ---------------------------------------------------------------- the page

window.terra.on<boolean>('terra:page-visible', (visible) => {
  pageVisible = visible;
  body.classList.toggle('page-visible', visible);
  update();
});

window.terra.on<{ top: string | null; bottom: string | null }>(
  'terra:page-edges',
  (edges) => {
    const isColor = (value: string | null): value is string =>
      value !== null && /^#[0-9a-f]{6}$/i.test(value);
    for (const [name, value] of [
      ['--page-top', edges.top],
      ['--page-bottom', edges.bottom],
    ] as const) {
      if (isColor(value)) root.style.setProperty(name, value);
      else root.style.removeProperty(name);
    }
  },
);

/** A rounded-rectangle hole in a full-screen shape, as a CSS clip path. */
function holePath(box: DOMRect, radius: number) {
  const w = innerWidth;
  const h = innerHeight;
  const { left: x, top: y, width, height } = box;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const right = x + width;
  const bottom = y + height;
  return (
    `path(evenodd, "M0 0H${w}V${h}H0Z ` +
    `M${x + r} ${y}H${right - r}A${r} ${r} 0 0 1 ${right} ${y + r}` +
    `V${bottom - r}A${r} ${r} 0 0 1 ${right - r} ${bottom}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${bottom - r}` +
    `V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z")`
  );
}

let frame = 0;
let lastSent = '';

/** Tells the app where the page is and who gets the touches. */
function update() {
  body.classList.toggle(
    'scrim',
    layers.some((l) => l.name === 'drawer' || l.name === 'sheet'),
  );
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const box = pageArea.getBoundingClientRect();
    const capture = !pageVisible || layers.some((layer) => layer.capture);
    const radius = parseFloat(getComputedStyle(pageArea).borderTopLeftRadius);
    root.style.setProperty(
      '--hole',
      pageVisible && box.width > 0 ? holePath(box, radius || 0) : 'none',
    );
    const message = {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height,
      dpr: devicePixelRatio,
      capture,
    };
    const key = JSON.stringify(message);
    if (key === lastSent) return;
    lastSent = key;
    post('layout', message);
  });
}

new ResizeObserver(update).observe(pageArea);
window.addEventListener('resize', update);

// ---------------------------------------------------------------- insets

/** Is someone typing in our own UI (not in the web page)? */
function typingHere() {
  const active = document.activeElement;
  return (
    document.hasFocus() &&
    !!active &&
    (active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement)
  );
}

/** The keyboard is up for the web page: it takes the toolbar's place. */
function updateKeyboard() {
  body.classList.toggle('ime-page', insets.ime > 0 && !typingHere());
  body.classList.toggle('ime-open', insets.ime > 0);
  update();
}

onHost<Insets>('insets', (next) => {
  insets = next;
  for (const [name, value] of Object.entries(next)) {
    root.style.setProperty(
      name === 'ime' ? '--ime' : `--inset-${name}`,
      `${Math.round(value)}px`,
    );
  }
  updateKeyboard();
});

document.addEventListener('focusin', updateKeyboard);
document.addEventListener('focusout', () => setTimeout(updateKeyboard));
window.addEventListener('blur', updateKeyboard);
window.addEventListener('focus', updateKeyboard);

/** Asks Android to show the keyboard for the field that has the focus. */
export function showKeyboard() {
  post('keyboard.show');
}

export const keyboardOpen = () => insets.ime > 0;
