// A small color picker that opens under a "Custom" button: a saturation and
// brightness area, a hue slider and a hex field. Every change previews
// live; Apply keeps the color, Cancel (or Escape, or clicking elsewhere)
// goes back to the one before.

export interface ColorPanelOptions {
  /** The color to start from, #rrggbb. */
  color: string;
  label: string;
  onPreview: (hex: string) => void;
  onApply: (hex: string) => void;
  onCancel: () => void;
}

interface Hsv {
  h: number;
  s: number;
  v: number;
}

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function hexToHsv(hex: string): Hsv {
  const value = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (c) => c / 255,
  );
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? delta / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * clamp(Math.min(k, 4 - k), 0, 1);
  };
  return `#${[f(5), f(3), f(1)]
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** "#abc", "abc", "#aabbcc" or "aabbcc" as #aabbcc, or null. */
function parseHex(text: string) {
  const value = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(value)) return `#${value}`;
  if (/^[0-9a-f]{3}$/.test(value)) {
    return `#${[...value].map((c) => c + c).join('')}`;
  }
  return null;
}

let close: ((apply: boolean) => void) | null = null;

/** Closes an open panel, going back to the color before it. */
export function cancelColorPanel() {
  close?.(false);
}

export function openColorPanel(
  anchor: HTMLElement,
  options: ColorPanelOptions,
) {
  // A second click on the same button closes it.
  const reopening = anchor.classList.contains('panel-open');
  cancelColorPanel();
  if (reopening) return;

  let hsv = hexToHsv(options.color);
  let hex = options.color;

  const panel = document.createElement('div');
  panel.className = 'color-panel';
  panel.role = 'dialog';
  panel.ariaLabel = options.label;

  const area = document.createElement('div');
  area.className = 'color-area';
  const areaThumb = document.createElement('span');
  areaThumb.className = 'color-thumb';
  area.append(areaThumb);

  const hue = document.createElement('input');
  hue.type = 'range';
  hue.className = 'color-hue';
  hue.min = '0';
  hue.max = '359';
  hue.ariaLabel = 'Hue';

  const field = document.createElement('div');
  field.className = 'color-field';
  const swatch = document.createElement('span');
  swatch.className = 'color-swatch';
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.maxLength = 7;
  input.ariaLabel = 'Hex color';
  field.append(swatch, input);

  const actions = document.createElement('div');
  actions.className = 'color-actions';
  const cancel = document.createElement('button');
  cancel.className = 'button';
  cancel.textContent = 'Cancel';
  const apply = document.createElement('button');
  apply.className = 'primary';
  apply.textContent = 'Apply';
  actions.append(cancel, apply);

  panel.append(area, hue, field, actions);
  document.body.append(panel);

  /** Shows the current color everywhere except the control being used. */
  function render(from: 'area' | 'hue' | 'input' | null) {
    hex = hsvToHex(hsv);
    panel.style.setProperty('--hue', `hsl(${Math.round(hsv.h)} 100% 50%)`);
    panel.style.setProperty('--picked', hex);
    areaThumb.style.left = `${hsv.s * 100}%`;
    areaThumb.style.top = `${(1 - hsv.v) * 100}%`;
    if (from !== 'hue') hue.value = String(Math.round(hsv.h));
    if (from !== 'input') {
      input.value = hex;
      input.classList.remove('invalid');
    }
    options.onPreview(hex);
  }

  function pickFromArea(event: PointerEvent) {
    const box = area.getBoundingClientRect();
    hsv = {
      ...hsv,
      s: clamp((event.clientX - box.left) / box.width),
      v: 1 - clamp((event.clientY - box.top) / box.height),
    };
    render('area');
  }

  area.addEventListener('pointerdown', (event) => {
    area.setPointerCapture(event.pointerId);
    pickFromArea(event);
  });
  area.addEventListener('pointermove', (event) => {
    if (area.hasPointerCapture(event.pointerId)) pickFromArea(event);
  });
  hue.addEventListener('input', () => {
    hsv = { ...hsv, h: Number(hue.value) };
    render('hue');
  });
  input.addEventListener('input', () => {
    const typed = parseHex(input.value);
    input.classList.toggle('invalid', !typed);
    if (!typed) return;
    // Keep the hue of greys, where hex alone doesn't have one.
    const next = hexToHsv(typed);
    hsv = next.s === 0 || next.v === 0 ? { ...next, h: hsv.h } : next;
    render('input');
  });

  function place() {
    const box = anchor.getBoundingClientRect();
    const width = panel.offsetWidth;
    panel.style.left = `${Math.max(8, box.right - width)}px`;
    const below = box.bottom + 8;
    const fits = below + panel.offsetHeight <= window.innerHeight - 8;
    panel.style.top = `${fits ? below : box.top - 8 - panel.offsetHeight}px`;
  }

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as Node;
    if (!panel.contains(target) && !anchor.contains(target)) finish(false);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    } else if (event.key === 'Enter' && panel.contains(event.target as Node)) {
      event.preventDefault();
      finish(true);
    }
  };
  // The settings page scrolls under it: just close, like a menu would.
  const onScroll = (event: Event) => {
    if (!panel.contains(event.target as Node)) finish(false);
  };
  const onResize = () => finish(false);

  function finish(keep: boolean) {
    close = null;
    anchor.classList.remove('panel-open');
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onResize);
    panel.remove();
    if (keep) options.onApply(hex);
    else options.onCancel();
  }

  cancel.addEventListener('click', () => finish(false));
  apply.addEventListener('click', () => finish(true));
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);

  close = finish;
  anchor.classList.add('panel-open');
  render(null);
  place();
  input.focus();
  input.select();
}
