# Terra for Android

Terra-mobile is the Android version of Terra, the desktop browser in
[ttttima/Terra-Browser](https://github.com/ttttima/Terra-Browser) (Electron). It is the
same UI and design laid out for a phone, on top of a native Kotlin shell.

- `phone.html` + `src/phone/`: the UI, built by `vite.config.mts` into the
  app's assets (`android/app/src/main/assets/ui`, not committed).
  - `brain.ts` is the desktop's `main.ts` (tabs, settings, questions,
    menus); `api.ts` is its `preload.ts` (the same `window.browser` /
    `window.terra`); `host.ts` talks to the native app.
  - `layout.ts`: the native pages sit under this page, which is see-through
    where `#page-area` is; it reports that rectangle and the safe areas.
  - `motion.ts`: how everything moves (springs, see design rule 8).
  - `drawer.ts` (tabs), `toolbar.ts`, `sheet.ts` (menus from below),
    `settings.ts`, `data.ts` (the saved files), `icons.ts`.
- Shared with the desktop, kept identical to its files: `src/shared.ts`,
  `ui-common.ts`, `ui-pages.ts`, `ui-bookmarks-pop.ts`, `ui-color-panel.ts`,
  `ui-backdrop.ts`, `suggest-local.ts` and `index.css` (imported by
  `phone.css`). Change them in both repos, and keep them free of Electron
  and desktop-only DOM.
- `android/`: the native shell (Kotlin, `app.terra.browser`): one WebView
  per tab under the UI; downloads, passwords (Android keystore), ad
  blocking, permissions, page colors and updates (`Updater.kt`, from this
  repo's GitHub releases) are done there.

Everything the user saves (history, bookmarks, passwords, settings, open
tabs) stays on the phone in the app's files; never send it anywhere. Only
GitHub (updates), the ad block list, and opt-in search suggestions use the
network.

`npm run apk` builds `out/Terra-<version>.apk` (needs Android Studio for its
Java and SDK; `npm run apk -- debug` for a debug build). The first release
build makes the signing key `android/terra-release.jks` +
`android/keystore.properties`: never commit them, and keep them, since
updates must be signed with the same key. `npm run dev` serves the UI in a
normal browser with a stand-in for the native app. Before finishing, run
`npm run typecheck` and `npm run lint`.

Not on the phone: "Behind the window" glass, window animations, compact
sidebar, keyboard shortcuts, importing from other browsers.

## Design rules

The owner cares a lot about symmetry and cleanliness. Every UI change must
follow these rules. All values live as tokens at the top of `src/index.css`,
with the phone's sizes at the top of `src/phone/phone.css`; use the tokens
and never hard-code a size, radius, color or duration.

### 1. Everything sits on a 4px grid

- Spacing (padding, margin, gap) uses only: 4, 8, 12, 16, 24, 32, 48.
- Every size (width, height, icon) is a multiple of 4.
- No odd pixels (3px, 6px, 10px, 14px, 12.5px...). The only exception is 1px
  borders and 2px focus/selection rings.

### 2. Three control heights

The desktop's three heights, one step up for fingers:

| Token          | Size | Used for                                          |
| -------------- | ---- | ------------------------------------------------- |
| `--control-sm` | 32   | small inline buttons (tab close), swatches        |
| `--control`    | 40   | buttons, inputs, selects, tabs, list rows         |
| `--control-lg` | 56   | bars (toolbar, drawer header/footer), hero search |

A bar is always `--control-lg` tall and holds `--control` items, giving
exactly 8px above and below them.

### 3. Four radii, nested correctly

- `--radius-sm` 4: tiny things inside controls (letter badges, close button)
- `--radius` 8: every control
- `--radius-lg` 12: cards
- `--radius-full`: only for things that are round by nature (switches,
  color swatches, the new-tab search pill)
- `--radius-page` 0 on the phone (35 on the desktop): the web page has
  square corners, edge to edge above the toolbar.
- A shape inside another uses `outer radius - padding` so curves stay parallel.

### 4. Shared axes and lines

- The tabs drawer and the settings list are `--sidebar-full` (320) wide,
  leaving a strip of the page to tap on narrow phones.
- In a row with an icon on the left and a button on the right (a tab), both
  are centered the same distance from their edge: mirrored.
- Horizontal lines line up: every bar is the same `--control-lg` tall.
- Content columns (settings panels, new-tab search) are max 640 wide and
  centered.

### 5. One icon style

- Icons are inline SVG, 24x24 viewBox, `stroke: currentColor`, stroke-width
  2, round caps and joins, no fill. Drawn at `--icon` (20px on the phone).
- Never use text characters as icons (no ←, →, ⟳, ×, +).

### 6. Type scale

- Only these sizes: 10 (letter badges only), 12 (secondary text, labels),
  14 (all normal UI text on the phone, `--text-md`), 16 (new-tab search),
  24 (page titles). No new-tab headline on the phone.
- Only two weights: 400 and 600.

### 7. Color and motion

- Colors only from theme tokens (`--bg`, `--panel`, `--text`, `--accent`...),
  so all three color modes (dark, light, OLED) and the accent color work.
- The selected state is the same everywhere: `--accent-soft` background and
  `--text-strong` text (active tab, active settings category).
- Pressed is the phone's hover: the same `--hover` background everywhere.
- Lines between sections (bars, drawer edge, rows) use `--divider`, never
  `--border`, so the "Section dividers" setting can hide them. Hidden lines
  stay 1px wide and transparent so nothing shifts. New dividers must also
  get a rule in the "smooth dividers" section of `index.css`.
- Colors change in one duration, `--duration` (150ms). Places and sizes
  move on springs (rule 8), never on a fixed-time slide.
- Liquid glass (`body.glass`, Appearance) only changes the background: the
  window's own background becomes frosted glass with soft light
  (`--glass*` tokens). Its three colors (`--glass-1/2/3`) come from the
  accent or the open website (`PageSampler.kt`): sampled from small local
  pictures of the page, every 250 ms while its colors change and 750 ms
  when still, skipped while Terra is in the background. Controls, cards and
  the web page never change.
- Large, soft gradients (anything spanning more than a few dozen pixels,
  like the glass light or the smooth-divider glows) band into rings in
  plain CSS. Draw them in `ui-backdrop.ts`, which computes them in float and
  dithers before rounding to 8 bits; the CSS versions stay only as the
  fallback without WebGL. Don't add noise overlays on top.

### 8. Motion

Everything that moves follows `src/phone/motion.ts`; keep new motion on it.

- Anything a finger can drag (the drawer, a menu, a tab row, the address
  pill) is a `Spring`: it follows the finger 1:1 from where it was
  grabbed, keeps the finger's speed when let go (`Tracker`), lands where
  the throw was heading (`project`), gives like a rubber band past its end
  (`rubberband`), and can be caught again mid-flight. Never a CSS
  transition for these.
- Two spring shapes only: `SMOOTH` (settles without overshoot) for
  everything, `LIVELY` (a small bounce) only after a flick or a drop.
- Things nobody drags use the same springs as CSS easings (`--spring`,
  `--spring-bouncy` with their `-time`), through `play()`, `glide()`
  (rows finding new places) or `@starting-style` (things that appear).
  Only `transform`, `translate`, `scale`, `opacity` and `clip-path` move.
- Things arrive from where they belong and leave at once: nothing waits
  for an animation to finish, and input is never blocked by one.
- Buttons answer a press right away (`scale`, the `--press` amount).
- The page under the drawer or a menu dims with it (`dim()` in
  `layout.ts`), not on its own timer.
- Web pages are native views: swiping through tabs pushes them sideways in
  `Tabs.kt` with the same spring as an Android interpolator.
- A sideways drag only reaches the UI where `touch-action` says so, on the
  element and inside any scroll area around it (see the drawer in
  `phone.css`); otherwise the browser cuts the gesture off.
- `haptic()` gives a small tap at real moments only: a tab coming loose,
  passing a slot, landing, a bookmark made.
- "Remove animations" in Android's settings turns all of it off.
