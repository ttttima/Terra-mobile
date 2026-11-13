// How things move on the phone.
//
// Everything a finger can touch moves on a spring: it starts from where
// the thing is on screen right now, keeps the finger's speed when let go,
// and can be caught again at any moment. A spring is described the way a
// designer thinks about it: `response` (seconds, how quick) and `damping`
// (1 = settles without overshoot, lower = a little bounce; used only when
// a flick carried momentum).
//
// Things nobody drags (a button springing back, a row finding its place)
// use the same springs as CSS easings (--spring, --spring-bouncy), so the
// whole app moves alike.
import { post } from './host';

const reduce = matchMedia('(prefers-reduced-motion: reduce)');
/** "Remove animations" is on in Android's settings. */
export const reducedMotion = () => reduce.matches;

export interface SpringShape {
  /** Seconds: lower is snappier. */
  response?: number;
  /** 1 settles smoothly; lower overshoots. */
  damping?: number;
}

export const SMOOTH: Required<SpringShape> = { response: 0.3, damping: 1 };
/** After a flick or a throw: the momentum shows as a small overshoot. */
export const LIVELY: Required<SpringShape> = { response: 0.32, damping: 0.8 };

interface SpringMove extends SpringShape {
  /** Units per second, from the finger that let go. */
  velocity?: number;
  /** Called when it comes to rest there (not when caught on the way). */
  onRest?: () => void;
}

const STEP = 1 / 240;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private stiffness = 0;
  private friction = 0;
  private frame = 0;
  private last = 0;
  private onRest: (() => void) | undefined;

  /** `precision`: how close counts as there (half a pixel by default). */
  constructor(
    value: number,
    private readonly onUpdate: (value: number) => void,
    private readonly precision = 0.5,
  ) {
    this.value = this.target = value;
    this.shape(SMOOTH);
  }

  private shape({ response, damping }: SpringShape) {
    const omega = (2 * Math.PI) / (response ?? SMOOTH.response);
    this.stiffness = omega * omega;
    this.friction = 2 * (damping ?? SMOOTH.damping) * omega;
  }

  get moving() {
    return this.frame !== 0;
  }

  /** Held by a finger: it is exactly there, now. */
  set(value: number) {
    this.stop();
    this.value = this.target = value;
    this.velocity = 0;
    this.onUpdate(value);
  }

  /** Let go: springs to `target` from where it is, as fast as it was going. */
  to(target: number, move: SpringMove = {}) {
    this.target = target;
    this.onRest = move.onRest;
    this.shape(move);
    if (move.velocity !== undefined) this.velocity = move.velocity;
    if (reducedMotion()) return this.finish();
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.onRest = undefined;
  }

  private finish() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.value = this.target;
    this.velocity = 0;
    this.onUpdate(this.value);
    const done = this.onRest;
    this.onRest = undefined;
    done?.();
  }

  private tick = (now: number) => {
    // A long pause (the app was in the background) isn't a long flight.
    let time = Math.min(0.064, (now - this.last) / 1000);
    this.last = now;
    while (time > 0) {
      const step = Math.min(STEP, time);
      const force =
        -this.stiffness * (this.value - this.target) -
        this.friction * this.velocity;
      this.velocity += force * step;
      this.value += this.velocity * step;
      time -= step;
    }
    const resting =
      Math.abs(this.value - this.target) < this.precision &&
      Math.abs(this.velocity) < this.precision * 20;
    if (resting) return this.finish();
    this.onUpdate(this.value);
    this.frame = requestAnimationFrame(this.tick);
  };
}

/** The finger's speed when it lets go, from its last few moves. */
export class Tracker {
  private points: { time: number; at: number }[] = [];

  reset() {
    this.points = [];
  }

  add(at: number, time: number) {
    this.points.push({ time, at });
    while (this.points.length > 2 && time - this.points[0].time > 100) {
      this.points.shift();
    }
  }

  /**
   * The finger let go at `at`: its speed in pixels per second (none if it
   * had stopped before lifting). Where it let go counts too: a quick flick
   * may have sent hardly any moves.
   */
  release(at: number, time: number) {
    this.add(at, time);
    const first = this.points[0];
    const last = this.points.at(-1)!;
    if (last === first || last.time === first.time) return 0;
    return ((last.at - first.at) / (last.time - first.time)) * 1000;
  }
}

/**
 * Where a flick would come to rest if it slid on like a scrolling page:
 * the distance still to go at this speed.
 */
export const project = (velocity: number, rate = 0.994) =>
  ((velocity / 1000) * rate) / (1 - rate);

/** Pulling past the end: it follows less and less, never stops dead. */
export const rubberband = (past: number, size: number, give = 0.55) =>
  (past * size * give) / (size + give * Math.abs(past));

// ---------------------------------------------------------------- CSS springs

/** A spring from 0 to 1 as a CSS `linear()` easing, and how long it takes. */
function springEasing({ response, damping }: Required<SpringShape>) {
  const omega = (2 * Math.PI) / response;
  const stiffness = omega * omega;
  const friction = 2 * damping * omega;
  const samples: number[] = [0];
  let value = 0;
  let velocity = 0;
  let time = 0;
  const every = 1 / 60;
  while (time < 2) {
    for (let i = 0; i < 4; i++) {
      velocity +=
        (-stiffness * (value - 1) - friction * velocity) * (every / 4);
      value += velocity * (every / 4);
    }
    time += every;
    samples.push(value);
    if (Math.abs(1 - value) < 0.001 && Math.abs(velocity) < 0.01) break;
  }
  samples[samples.length - 1] = 1;
  return {
    easing: `linear(${samples.map((s) => +s.toFixed(4)).join(', ')})`,
    duration: Math.round(time * 1000),
  };
}

const canSpring = CSS.supports('transition-timing-function', 'linear(0, 1)');
const smooth = springEasing(SMOOTH);
const lively = springEasing(LIVELY);

// Without linear() (an old WebView) phone.css falls back to --ease.
if (canSpring) {
  const style = document.documentElement.style;
  style.setProperty('--spring', smooth.easing);
  style.setProperty('--spring-time', `${smooth.duration}ms`);
  style.setProperty('--spring-bouncy', lively.easing);
  style.setProperty('--spring-bouncy-time', `${lively.duration}ms`);
}

/**
 * Plays keyframes on a spring (for things nobody is dragging). Returns
 * nothing to wait for when animations are off.
 */
export function play(
  element: Element,
  keyframes: Keyframe[],
  options: { lively?: boolean; add?: boolean; delay?: number } = {},
) {
  if (reducedMotion()) return null;
  const spring = options.lively ? lively : smooth;
  return element.animate(keyframes, {
    duration: canSpring ? spring.duration : 250,
    easing: canSpring ? spring.easing : 'cubic-bezier(0.2, 0, 0, 1)',
    delay: options.delay ?? 0,
    fill: 'backwards',
    composite: options.add ? 'add' : 'replace',
  });
}

/**
 * Things that change place (rows after one is closed or moved) glide there
 * instead of jumping: where they were, the change, where they are now.
 */
export function glide(elements: Iterable<HTMLElement>, change: () => void) {
  const before = new Map<HTMLElement, DOMRect>();
  for (const element of elements) {
    before.set(element, element.getBoundingClientRect());
  }
  change();
  for (const [element, was] of before) {
    if (!element.isConnected) continue;
    const now = element.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    play(element, [
      { transform: `translate(${dx}px, ${dy}px)` },
      { transform: 'none' },
    ]);
  }
}

// ---------------------------------------------------------------- touch

/**
 * A small tap from the phone itself, at the moment something happens:
 * `tick` a step (a row passing a slot), `click` something snapped or
 * toggled, `lift` a held thing came loose.
 */
export const haptic = (kind: 'tick' | 'click' | 'lift') =>
  post('haptic', { kind });
