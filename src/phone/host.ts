// The bridge to the Android app (android/app/src/main/java/.../Host.kt).
// Commands go out with post (no answer) or call (answered right away);
// the app sends events back through window.terraNative.receive.
//
// Outside the app (a normal browser, for working on the layout) a small
// stand-in answers instead: files live in localStorage and "pages" load
// instantly without showing anything.

interface AndroidHost {
  post(message: string): void;
  call(message: string): string;
}

declare global {
  interface Window {
    TerraHost?: AndroidHost;
    terraNative: { receive: (message: string) => void };
  }
}

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function emit(type: string, data: unknown) {
  for (const handler of handlers.get(type) ?? []) {
    try {
      handler(data);
    } catch (error) {
      console.error(`Terra: ${type} handler failed`, error);
    }
  }
}

window.terraNative = {
  receive(message: string) {
    const { type, data } = JSON.parse(message) as {
      type: string;
      data: unknown;
    };
    emit(type, data);
  },
};

/** True inside the Android app. */
export const inApp = !!window.TerraHost;

const host: AndroidHost = window.TerraHost ?? standIn();

/** A command for the app; nothing comes back. */
export function post(type: string, data: unknown = null) {
  host.post(JSON.stringify({ type, data }));
}

/** A question the app answers right away (reading a file, a password...). */
export function call<T>(type: string, data: unknown = null): T | null {
  const text = host.call(JSON.stringify({ type, data }));
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Listens to one kind of event from the app. */
export function onHost<T>(type: string, handler: (data: T) => void) {
  let set = handlers.get(type);
  if (!set) handlers.set(type, (set = new Set()));
  set.add(handler as Handler);
}

// ---------------------------------------------------------------- stand-in

function standIn(): AndroidHost {
  const later = (type: string, data: unknown, ms = 0) =>
    setTimeout(() => emit(type, data), ms);
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  };
  setTimeout(() =>
    emit('insets', { top: 24, bottom: 16, left: 0, right: 0, ime: 0 }),
  );
  return {
    post(message) {
      const { type, data } = JSON.parse(message) as {
        type: string;
        data: Record<string, unknown>;
      };
      if (type === 'fs.write') {
        localStorage.setItem(`terra:${data.name}`, String(data.text));
      } else if (type === 'tab.load') {
        const tab = { id: data.id, url: data.url };
        later('tab', { ...tab, kind: 'started', loading: true });
        later('tab', { ...tab, kind: 'visited', back: true, forward: false });
        later('tab', { ...tab, kind: 'title', title: host(String(data.url)) });
        later('tab', { ...tab, kind: 'finished', loading: false }, 300);
      }
    },
    call(message) {
      const { type, data } = JSON.parse(message) as {
        type: string;
        data: Record<string, unknown>;
      };
      switch (type) {
        case 'fs.read':
          return JSON.stringify(localStorage.getItem(`terra:${data.name}`));
        case 'app.info':
          return JSON.stringify({ version: 'dev', privateIsolated: true });
        case 'logins.list':
          return JSON.stringify({ available: true, logins: [] });
        case 'logins.for':
          return '[]';
        case 'default.get':
          return JSON.stringify({ supported: true, isDefault: false });
        default:
          return '';
      }
    },
  };
}
