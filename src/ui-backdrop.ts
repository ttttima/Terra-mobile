// The window's backdrop: every large, soft gradient behind Terra's UI (the
// liquid glass light and sheen, the smooth-divider glows around the page
// and settings) drawn by the GPU, with dithering.
//
// Why: Chromium draws CSS gradients straight into 8 bits per channel
// without dithering. A gradient that changes by ten levels over 500 px then
// shows as ten flat rings. Noise laid on top afterwards can't fix that (the
// steps are already there); dithering has to happen while the color is
// still exact. So here the colors are computed in float, a triangular noise
// of +-1 level is added per physical pixel, and only then are they rounded
// to 8 bits: smooth, without visible grain.
//
// Same look as the CSS it replaces (index.css "liquid glass" and "smooth
// dividers", which stay as the fallback without WebGL): the same layers,
// positions, colors and sRGB blending. It only draws when something changes
// (colors, size, the sidebar slide, a fade); nothing runs while idle.

const canvas = document.querySelector<HTMLCanvasElement>('#backdrop')!;
const body = document.body;
const root = document.documentElement;

// The glass layers, the same as body.glass in index.css (the fallback):
// center x, y and radii x, y in % of the window; light fades out at 70%.
const POOLS = [
  [8, 12, 60, 55],
  [92, 88, 55, 50],
  [70, 6, 45, 40],
];
const POOL_END = 0.7;
const SHEEN_ANGLE = 160; // degrees, as in linear-gradient(160deg, ...)
const SHEEN_END = 0.4;

const VERTEX = `
attribute vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const FRAGMENT = `
precision highp float;
uniform vec2 uSize;        // canvas size in device pixels
uniform float uDpr;        // device pixels per CSS pixel
uniform vec3 uBase;
uniform float uBaseAlpha;  // 1, or the translucent "behind" layer
uniform float uGlass;
uniform float uPools;      // 0 for "behind": its colors come from behind
uniform vec4 uPool[3];     // rgb, alpha
uniform vec4 uPoolGeo[3];  // center x, y, radius x, y (CSS px)
uniform vec4 uSheen;       // rgb, alpha
uniform vec4 uSheenGeo;    // start x, y, direction x, y
uniform float uSheenLength;
uniform vec4 uGlowRect[2]; // x, y, width, height (CSS px); width 0 = off
uniform vec3 uGlowColor[2];
uniform vec4 uGlowShape[2];// radius, spread, sigma, radius of the shadow

float roundRect(vec2 p, vec4 rect, float radius) {
  vec2 halfSize = rect.zw * 0.5;
  vec2 q = abs(p - (rect.xy + halfSize)) - halfSize + radius;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
}

float erfApprox(float x) {
  float s = sign(x);
  x = abs(x);
  float x2 = x * x;
  return s * sqrt(1.0 - exp(-x2 * (1.2732395 + 0.147 * x2) / (1.0 + 0.147 * x2)));
}

// Per-pixel white noise without visible structure (a hash, not a sine:
// stable on every GPU and at any pixel position on screen).
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Premultiplied "source over": a straight color at some alpha on top.
vec4 over(vec4 under, vec3 color, float alpha) {
  return vec4(color * alpha, alpha) + under * (1.0 - alpha);
}

void main() {
  vec2 device = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec2 p = device / uDpr;
  vec4 color = vec4(uBase * uBaseAlpha, uBaseAlpha);

  if (uGlass > 0.5) {
    for (int i = 2; i >= 0; i--) {
      if (uPools < 0.5) break;
      vec2 d = (p - uPoolGeo[i].xy) / uPoolGeo[i].zw;
      float t = length(d);
      color = over(color, uPool[i].rgb, uPool[i].a * max(0.0, 1.0 - t / ${POOL_END.toFixed(2)}));
    }
    float s = max(0.0, dot(p - uSheenGeo.xy, uSheenGeo.zw) / uSheenLength);
    color = over(color, uSheen.rgb, uSheen.a * max(0.0, 1.0 - s / ${SHEEN_END.toFixed(2)}));
  }

  // Glows: a box-shadow (blur = 2 sigma, spread) under a solid box.
  for (int i = 0; i < 2; i++) {
    if (uGlowRect[i].z <= 0.0) continue;
    vec4 shape = uGlowShape[i];
    if (roundRect(p, uGlowRect[i], shape.x) <= 0.0) {
      color = vec4(uGlowColor[i], 1.0);
    } else {
      vec4 grown = uGlowRect[i] + vec4(-shape.y, -shape.y, 2.0 * shape.y, 2.0 * shape.y);
      float d = roundRect(p, grown, shape.w);
      float alpha = 0.5 * (1.0 - erfApprox(d / (shape.z * 1.41421356)));
      color = over(color, uGlowColor[i], alpha);
    }
  }

  // Dither before the 8-bit rounding: triangular noise of +-1 level.
  float grain = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + vec2(113.7, 57.3)) - 1.0;
  gl_FragColor = vec4(color.rgb + grain / 255.0 * color.a, color.a);
}
`;

let gl: WebGLRenderingContext | null = null;
let program: WebGLProgram | null = null;
const uniforms = new Map<string, WebGLUniformLocation | null>();

function setUp(): boolean {
  gl = canvas.getContext('webgl', {
    // Translucent output for "behind the window" glass (premultiplied).
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power',
  });
  if (!gl) return false;
  const compile = (type: number, source: string) => {
    const shader = gl!.createShader(type)!;
    gl!.shaderSource(shader, source);
    gl!.compileShader(shader);
    if (gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) return shader;
    console.warn('Backdrop shader:', gl!.getShaderInfoLog(shader));
    return null;
  };
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vertex || !fragment) return false;
  program = gl.createProgram()!;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
  gl.useProgram(program);
  // One triangle covering the whole canvas.
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  uniforms.clear();
  return true;
}

const uniform = (name: string) => {
  if (!uniforms.has(name))
    uniforms.set(name, gl!.getUniformLocation(program!, name));
  return uniforms.get(name)!;
};

// ---- reading the colors and shapes from the page's own styles

const parser = document
  .createElement('canvas')
  .getContext('2d', { willReadFrequently: true })!;
parser.canvas.width = 1;
parser.canvas.height = 1;
const parsed = new Map<string, number[]>();

/** Any CSS color (hex, rgb, oklch, with alpha) as [r, g, b, a] from 0 to 1. */
function rgba(css: string): number[] {
  const key = css.trim();
  const known = parsed.get(key);
  if (known) return known;
  parser.clearRect(0, 0, 1, 1);
  parser.fillStyle = '#000000';
  parser.fillStyle = key;
  parser.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = parser.getImageData(0, 0, 1, 1).data;
  const color = [r / 255, g / 255, b / 255, a / 255];
  if (parsed.size > 512) parsed.clear();
  parsed.set(key, color);
  return color;
}

interface Glow {
  rect: number[];
  color: number[];
  radius: number;
}

interface State {
  width: number;
  height: number;
  base: number[];
  baseAlpha: number;
  glass: boolean;
  behind: boolean;
  pools: number[][];
  light: number;
  sheen: number[];
  glows: Glow[];
  fade: number;
  spread: number;
}

/** Everything the backdrop depends on, read from the live styles. */
function readState(): State {
  const style = getComputedStyle(body);
  const value = (name: string) => style.getPropertyValue(name);
  const glass = body.classList.contains('glass');
  const behind = glass && body.classList.contains('glass-behind');
  const smooth = body.classList.contains('smooth-dividers');
  const glows: Glow[] = [];
  if (smooth) {
    const page = document.querySelector<HTMLElement>('#page-glow');
    if (page) {
      const pageStyle = getComputedStyle(page);
      if (pageStyle.display !== 'none') {
        const box = page.getBoundingClientRect();
        glows.push({
          rect: [box.left, box.top, box.width, box.height],
          color: rgba(pageStyle.backgroundColor),
          radius: parseFloat(pageStyle.borderTopLeftRadius) || 0,
        });
      }
    }
    const content = document.querySelector<HTMLElement>('.settings-content');
    if (!glass && content && body.classList.contains('settings-open')) {
      const box = content.getBoundingClientRect();
      glows.push({
        rect: [box.left, box.top, box.width, box.height],
        color: rgba(value('--bg')),
        radius: 0,
      });
    }
  }
  return {
    width: innerWidth,
    height: innerHeight,
    base: rgba(value('--panel')),
    baseAlpha: behind ? parseFloat(value('--glass-behind')) / 100 || 0.3 : 1,
    glass,
    behind,
    pools: glass
      ? ['--glass-1', '--glass-2', '--glass-3'].map((name) => rgba(value(name)))
      : [],
    light: glass ? parseFloat(value('--glass-light')) / 100 || 0 : 0,
    sheen: glass ? rgba(value('--glass-sheen')) : [0, 0, 0, 0],
    glows,
    fade: parseFloat(value('--fade')) || 0,
    spread: parseFloat(value('--fade-spread')) || 0,
  };
}

let lastDrawn = '';

function draw(force = false) {
  if (!gl || !program || canvas.hidden) return;
  const state = readState();
  const key = `${canvas.width}x${canvas.height} ${JSON.stringify(state)}`;
  if (!force && key === lastDrawn) return;
  lastDrawn = key;
  const { width, height } = state;
  const dpr = canvas.width / Math.max(1, width);

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(uniform('uSize'), canvas.width, canvas.height);
  gl.uniform1f(uniform('uDpr'), dpr);
  gl.uniform3f(uniform('uBase'), state.base[0], state.base[1], state.base[2]);
  gl.uniform1f(uniform('uBaseAlpha'), state.baseAlpha);
  gl.uniform1f(uniform('uGlass'), state.glass ? 1 : 0);
  gl.uniform1f(uniform('uPools'), state.behind ? 0 : 1);
  if (state.glass) {
    POOLS.forEach(([x, y, rx, ry], i) => {
      const [r, g, b, a] = state.pools[i];
      // color-mix(in srgb, color X%, transparent): the color at X% alpha.
      gl!.uniform4f(uniform(`uPool[${i}]`), r, g, b, a * state.light);
      gl!.uniform4f(
        uniform(`uPoolGeo[${i}]`),
        (x / 100) * width,
        (y / 100) * height,
        (rx / 100) * width,
        (ry / 100) * height,
      );
    });
    // linear-gradient(160deg): along (sin, -cos), over the CSS gradient
    // line length, starting half of it before the center.
    const angle = (SHEEN_ANGLE * Math.PI) / 180;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const length = Math.abs(width * dx) + Math.abs(height * dy);
    gl.uniform4f(
      uniform('uSheen'),
      state.sheen[0],
      state.sheen[1],
      state.sheen[2],
      state.sheen[3],
    );
    gl.uniform4f(
      uniform('uSheenGeo'),
      width / 2 - (dx * length) / 2,
      height / 2 - (dy * length) / 2,
      dx,
      dy,
    );
    gl.uniform1f(uniform('uSheenLength'), length);
  }
  for (let i = 0; i < 2; i++) {
    const glow = state.glows[i];
    if (!glow) {
      gl.uniform4f(uniform(`uGlowRect[${i}]`), 0, 0, 0, 0);
      continue;
    }
    gl.uniform4f(
      uniform(`uGlowRect[${i}]`),
      glow.rect[0],
      glow.rect[1],
      glow.rect[2],
      glow.rect[3],
    );
    gl.uniform3f(
      uniform(`uGlowColor[${i}]`),
      glow.color[0],
      glow.color[1],
      glow.color[2],
    );
    // CSS spread rounds the shadow's corners by radius + spread, but keeps
    // square corners square.
    const shadowRadius = glow.radius > 0 ? glow.radius + state.spread : 0;
    gl.uniform4f(
      uniform(`uGlowShape[${i}]`),
      glow.radius,
      state.spread,
      state.fade / 2,
      shadowRadius,
    );
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ---- when to draw

let frame = 0;
/** Keep drawing every frame until then (fades and slides in progress). */
let busyUntil = 0;
let transitions = 0;

function tick() {
  frame = 0;
  draw();
  if (transitions > 0 || performance.now() < busyUntil) {
    frame = requestAnimationFrame(tick);
  }
}

/** Something may have changed: draw on the next frames for a moment. */
function invalidate(forMs = 200) {
  busyUntil = Math.max(busyUntil, performance.now() + forMs);
  if (!frame) frame = requestAnimationFrame(tick);
}

let active = false;

/** Only while glass or smooth dividers are on: otherwise it's one flat color. */
function updateActive() {
  const wanted =
    !!gl &&
    (body.classList.contains('glass') ||
      body.classList.contains('smooth-dividers'));
  if (wanted === active) {
    if (active) invalidate();
    return;
  }
  active = wanted;
  canvas.hidden = !wanted;
  body.classList.toggle('backdrop-gl', wanted);
  if (wanted) {
    resizeCanvas(
      canvas.clientWidth * devicePixelRatio,
      canvas.clientHeight * devicePixelRatio,
    );
    lastDrawn = '';
    invalidate();
  } else {
    // Give the GPU memory back while it's not needed.
    canvas.width = 1;
    canvas.height = 1;
  }
}

function resizeCanvas(width: number, height: number) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    lastDrawn = '';
  }
}

if (setUp()) {
  // Exact device pixels, so the dither is per physical pixel at any scaling.
  new ResizeObserver((entries) => {
    if (!active) return;
    const entry = entries[0];
    const size = entry.devicePixelContentBoxSize?.[0];
    if (size) resizeCanvas(size.inlineSize, size.blockSize);
    else
      resizeCanvas(
        entry.contentRect.width * devicePixelRatio,
        entry.contentRect.height * devicePixelRatio,
      );
    draw(true);
  }).observe(canvas, { box: 'device-pixel-content-box' });

  // Colors, themes, tints, page edges, settings: classes and inline styles
  // on <html> and <body>.
  const watch = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  };
  new MutationObserver(updateActive).observe(body, watch);
  new MutationObserver(() => invalidate()).observe(root, watch);
  // Shapes that move: the page area (sidebar slide, notice bar) and the
  // settings content.
  const shapes = new ResizeObserver(() => invalidate());
  for (const selector of ['#page-glow', '.settings-content']) {
    const element = document.querySelector(selector);
    if (element) shapes.observe(element);
  }
  // Fades of the glass colors and the sidebar slide: draw every frame.
  body.addEventListener('transitionrun', (event) => {
    if (event.target !== body) return;
    transitions++;
    invalidate();
  });
  const ended = (event: TransitionEvent) => {
    if (event.target !== body) return;
    transitions = Math.max(0, transitions - 1);
    invalidate(50);
  };
  body.addEventListener('transitionend', ended);
  body.addEventListener('transitioncancel', ended);

  canvas.addEventListener('webglcontextlost', (event) => {
    // Fall back to the CSS gradients until the GPU is back.
    event.preventDefault();
    active = false;
    body.classList.remove('backdrop-gl');
    canvas.hidden = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (setUp()) updateActive();
  });

  updateActive();
}
