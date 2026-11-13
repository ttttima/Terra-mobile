package app.terra.browser

/**
 * What runs inside every website, before its own scripts: the desktop's
 * tab-preload.ts for the phone. It tells Terra about sign-in forms (so it
 * can offer and save passwords) and sound playing, mutes on request, and
 * gives pages without a background the browser's default one. Dark mode
 * for every site is Chromium's own here (algorithmic darkening), which
 * decides before the first paint like the desktop forcer.
 */
object PageScripts {
    val SCRIPT = """
(() => {
  const port = window.terraPage;
  if (!port || window.__terraPage) return;
  window.__terraPage = true;
  const frame = Math.random().toString(36).slice(2);
  const send = (type, data) =>
    port.postMessage(JSON.stringify(Object.assign({ type, frame }, data || {})));

  // ---- sound: report playing media, mute it when the tab is muted
  let muted = false;
  let audible = false;
  const was = new WeakMap();
  const media = () => [...document.querySelectorAll('video, audio')];
  const setMute = (element) => {
    if (muted) {
      if (!was.has(element)) was.set(element, element.muted);
      element.muted = true;
    } else if (was.has(element)) {
      element.muted = was.get(element);
      was.delete(element);
    }
  };
  const check = () => {
    const now = media().some(
      (m) => !m.paused && !m.ended && (!m.muted || was.has(m)) && m.volume > 0,
    );
    if (now !== audible) {
      audible = now;
      send('audible', { on: now });
    }
  };
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied']) {
    document.addEventListener(type, (event) => {
      if (muted && event.target instanceof HTMLMediaElement) setMute(event.target);
      check();
    }, true);
  }
  port.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'mute') {
      muted = message.on === true;
      media().forEach(setMute);
      check();
    }
  });
  send('hello');

  if (window !== window.top || !/^https?:${'$'}/.test(location.protocol)) return;

  // ---- a page that sets no background gets the browser's default one
  const keepDefaultBackground = () => {
    const clear = (element) =>
      !element ||
      /^(transparent|rgba\(0, 0, 0, 0\))${'$'}/.test(getComputedStyle(element).backgroundColor);
    if (clear(document.documentElement) && clear(document.body)) {
      const style = document.createElement('style');
      style.textContent = ':root { background-color: Canvas; }';
      document.documentElement.append(style);
    }
  };
  const whenBody = (callback) => {
    if (document.body) return callback();
    const observer = new MutationObserver(() => {
      if (!document.body) return;
      observer.disconnect();
      callback();
    });
    observer.observe(document, { childList: true, subtree: true });
  };
  whenBody(keepDefaultBackground);

  // ---- passwords (as in tab-preload.ts)
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && !element.closest('[hidden]');
  };
  const passwordFields = () =>
    [...document.querySelectorAll('input[type="password"]')].filter(visible);
  const usernameFor = (password) => {
    const scope = password.form || document;
    const named = scope.querySelector('input[autocomplete="username"], input[autocomplete="email"]');
    if (named && visible(named)) return named;
    const inputs = [...scope.querySelectorAll('input')];
    const before = inputs.slice(0, inputs.indexOf(password)).reverse();
    return before.find((input) =>
      ['text', 'email', 'tel', ''].includes(input.type) && visible(input)) || null;
  };
  let formReported = false;
  let lastSent = '';
  const reportForm = () => {
    if (formReported || passwordFields().length === 0) return;
    formReported = true;
    send('loginForm');
  };
  const captureLogin = () => {
    const password = passwordFields().find((field) => field.value);
    if (!password) return;
    const user = usernameFor(password);
    const username = user ? user.value.trim() : '';
    const key = username + '\n' + password.value;
    if (key === lastSent) return;
    lastSent = key;
    send('loginSubmitted', { username, password: password.value });
  };
  let timer = null;
  const checkForm = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; reportForm(); }, 400);
  };
  window.addEventListener('DOMContentLoaded', () => {
    checkForm();
    new MutationObserver(checkForm).observe(document.body || document, {
      childList: true,
      subtree: true,
    });
  });
  window.addEventListener('submit', captureLogin, true);
  window.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('button, input[type="submit"], [role="button"]')) {
      captureLogin();
    }
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target && event.target.matches && event.target.matches('input')) {
      captureLogin();
    }
  }, true);
  // "Fill in" in Terra's question bar.
  window.__terraFill = (username, password) => {
    const field = passwordFields()[0];
    if (!field) return;
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const user = usernameFor(field);
    if (user && username) setValue(user, username);
    setValue(field, password);
    lastSent = username + '\n' + password;
    field.focus();
  };
})();
""".trimIndent()

    private fun escape(text: String) = text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")
        .replace("'", "&#39;")

    /** The page shown when a site can't be reached, in Terra's colors. */
    fun errorPage(title: String, url: String, description: String, dark: Boolean): String {
        val background = if (dark) "#111318" else "#f6f7f9"
        val text = if (dark) "#e6e8ec" else "#1d2026"
        val muted = if (dark) "#9096a3" else "#646a76"
        return """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
body{font-family:system-ui,sans-serif;background:$background;color:$text;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:520px;padding:24px}h1{font-size:24px;font-weight:600;margin:0 0 16px}
code{color:$muted;word-break:break-all}p{color:$muted;line-height:1.5}
</style>
<main><h1>${escape(title)}</h1><p><code>${escape(url)}</code></p><p>${escape(description)}</p></main>"""
    }
}
