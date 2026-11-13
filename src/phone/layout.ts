// Where things are on the phone's screen.
//
// The web page is a native view under this page. #page-area is where it
// shows: its place is sent to the app (which puts the page there and
// passes it the touches), and the background around it gets a hole of the
// same rounded shape (--hole). Drawers, menus and settings are "layers":
// while one is open every touch comes here, and Android's Back closes the
// top one.
import { onHost, post } from './host';
import { reducedMotion } from './motion';

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
/**
 * While the keyboard slides (see "keyboard" below): how far the toolbar is
 * still drawn from its place, and how much taller the web page is kept
 * until the toolbar has covered that part.
 */
let shift = 0;
let pageExtra = 0;

/** The hole for the page follows the toolbar's edge as it slides. */
function cutHole() {
  const box = pageArea.getBoundingClientRect();
  const radius = parseFloat(getComputedStyle(pageArea).borderTopLeftRadius);
  const shown = new DOMRect(
    box.left,
    box.top,
    box.width,
    Math.max(0, box.height + shift),
  );
  root.style.setProperty(
    '--hole',
    pageVisible && box.width > 0 ? holePath(shown, radius || 0) : 'none',
  );
  return box;
}

/** Tells the app where the page is and who gets the touches. */
function update() {
  body.classList.toggle(
    'scrim',
    layers.some((l) => l.name === 'drawer' || l.name === 'sheet'),
  );
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const box = cutHole();
    const capture = !pageVisible || layers.some((layer) => layer.capture);
    const message = {
      x: box.left,
      y: box.top,
      width: box.width,
      height: box.height + pageExtra,
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

/**
 * The keyboard is up for the web page (the page has the focus, not this
 * UI): it takes the toolbar's place. Up while the focus is still here but
 * a field just let go of it, it is on its way out and the toolbar stays.
 */
function updateKeyboard() {
  body.classList.toggle('ime-page', insets.ime > 0 && !document.hasFocus());
  body.classList.toggle('ime-open', insets.ime > 0);
  update();
}

// ---------------------------------------------------------------- keyboard

// The keyboard slides in and out, and what sits on it slides along: the
// toolbar (with the bars above it) by its whole way, the new tab page's
// search box by half (it stays in the middle of what's left). The layout
// itself changes at once; these are drawn from where they were and brought
// to their new place on the keyboard's own timing, which the app reports
// as it starts ("ime.motion"). The web page keeps its full height until
// the toolbar has covered it, and gets it back at once when the keyboard
// leaves.

const riders = ['#toolbar', '#notice-bar', '#update-bar'].map(
  (selector) => document.querySelector<HTMLElement>(selector)!,
);
const centered = ['#start-page', '#page-glow'].map(
  (selector) => document.querySelector<HTMLElement>(selector)!,
);

/**
 * How the keyboard moves this time: milliseconds, its curve sampled, and
 * when it began (wall clock, the same one Date.now() reads), so the news
 * taking a frame to get here doesn't leave the toolbar a frame behind.
 */
let motion: { duration: number; curve: number[]; at: number } | null = null;
onHost<{ duration: number; curve: number[]; at: number }>(
  'ime.motion',
  (next) => {
    if (next.duration > 0 && next.curve.length > 1) motion = next;
  },
);

let slideFrame = 0;
const settled: (() => void)[] = [];
/** Runs when the keyboard has finished moving (things can be measured). */
export const onKeyboardSettled = (run: () => void) => settled.push(run);
const leaving: (() => void)[] = [];
/** Runs as our keyboard starts to go away (Back, or its own hide key). */
export const onKeyboardLeaving = (run: () => void) => leaving.push(run);

function place(offset: number) {
  shift = offset;
  const move = offset ? `translateY(${offset}px)` : '';
  for (const element of riders) element.style.transform = move;
  // The page's own layers end where the toolbar now begins.
  const bottom = offset ? `${-offset}px` : '';
  for (const element of centered) element.style.bottom = bottom;
  cutHole();
}

function settle() {
  cancelAnimationFrame(slideFrame);
  slideFrame = 0;
  pageExtra = 0;
  place(0);
  update();
  for (const run of settled) run();
}

/** The layout just moved by `delta`: slide there with the keyboard. */
function slideWithKeyboard(delta: number) {
  // Drawn where it was a moment ago (also when caught mid-slide).
  const from = shift + delta;
  if (!from || reducedMotion()) return settle();
  pageExtra = Math.max(0, from);
  place(from);
  update();
  cancelAnimationFrame(slideFrame);
  const began = Date.now();
  const step = () => {
    // The keyboard's own start, if it told us (just before or after the
    // new height arrived); otherwise ours.
    const known = motion && Math.abs(motion.at - began) < 200 ? motion : null;
    const elapsed = Date.now() - (known?.at ?? began);
    const t = Math.min(1, elapsed / (known?.duration ?? 250));
    let done = 1 - (1 - t) ** 3;
    if (known) {
      const at = t * (known.curve.length - 1);
      const index = Math.min(known.curve.length - 2, Math.floor(at));
      const a = known.curve[index];
      done = a + (known.curve[index + 1] - a) * (at - index);
    }
    if (t >= 1) return settle();
    place(from * (1 - done));
    slideFrame = requestAnimationFrame(step);
  };
  slideFrame = requestAnimationFrame(step);
}

/** What the bottom of the screen takes from the UI. */
const bottomOf = (i: Insets) => Math.max(i.bottom, i.ime);

onHost<Insets>('insets', (next) => {
  const before = bottomOf(insets);
  const keyboardMoved = Math.round(next.ime) !== Math.round(insets.ime);
  const wasPage = body.classList.contains('ime-page');
  insets = next;
  for (const [name, value] of Object.entries(next)) {
    root.style.setProperty(
      name === 'ime' ? '--ime' : `--inset-${name}`,
      `${Math.round(value)}px`,
    );
  }
  updateKeyboard();
  // Only our own keyboard: the web page's is the page's business.
  const ours = !wasPage && !body.classList.contains('ime-page');
  if (!ours) {
    settle();
  } else if (keyboardMoved) {
    if (next.ime <= 0) for (const run of leaving) run();
    slideWithKeyboard(Math.round(bottomOf(next)) - Math.round(before));
  }
  // Android may report the same height again while the keyboard is still
  // sliding: the slide under way carries on.
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
