// Small helpers shared by the UI modules.

export interface TerraBridge {
  send: (channel: string, ...args: unknown[]) => void;
  invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>;
  on: <T = unknown>(channel: string, callback: (payload: T) => void) => void;
  pathForFile: (file: File) => string;
}

declare global {
  interface Window {
    terra: TerraBridge;
  }
}

export const terra = window.terra;

export const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

/** Icon shapes (24x24, stroked), see design rule 5. */
export const PATHS = {
  search:
    '<circle cx="11" cy="11" r="7" /><line x1="16" y1="16" x2="20" y2="20" />',
  globe:
    '<circle cx="12" cy="12" r="9" /><line x1="3" y1="12" x2="21" y2="12" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />',
  tab: '<rect x="4" y="5" width="16" height="14" rx="2" /><line x1="4" y1="9" x2="20" y2="9" />',
  star: '<polygon points="12 3 14.8 8.8 21 9.6 16.5 14 17.6 20.2 12 17.3 6.4 20.2 7.5 14 3 9.6 9.2 8.8 12 3" />',
  clock:
    '<circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 15" />',
  remove:
    '<line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z" />',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />',
  eyeOff:
    '<path d="M3 3l18 18" /><path d="M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 4" /><path d="M6.6 6.6C3.9 8.4 2 12 2 12s4 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />',
  speaker:
    '<polygon points="4 9 8 9 13 5 13 19 8 15 4 15 4 9" /><path d="M16.5 8.5a5 5 0 0 1 0 7" />',
  bookmark: '<path d="M6 4h12v16l-6-4-6 4z" />',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />',
  folderPlus:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" />',
  list: '<line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><line x1="4" y1="6" x2="5" y2="6" /><line x1="4" y1="12" x2="5" y2="12" /><line x1="4" y1="18" x2="5" y2="18" />',
  speakerOff:
    '<polygon points="4 9 8 9 13 5 13 19 8 15 4 15 4 9" /><line x1="17" y1="10" x2="21" y2="14" /><line x1="21" y1="10" x2="17" y2="14" />',
};

export type IconName = keyof typeof PATHS;

export const icon = (name: IconName, extra = '') =>
  `<svg class="icon${extra ? ` ${extra}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name]}</svg>`;

/** A small square button with an icon, for list rows. */
export function actionButton(
  name: IconName,
  title: string,
  onClick: () => void,
) {
  const button = document.createElement('button');
  button.className = 'icon-button list-action';
  button.title = title;
  button.ariaLabel = title;
  button.innerHTML = icon(name);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function hostOf(url: string) {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol === 'file:') return 'File on this computer';
    return hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** Letter badge used for sites in lists. */
export function letterBadge(text: string) {
  const badge = document.createElement('span');
  badge.className = 'tab-icon letter';
  badge.textContent = (text.trim()[0] ?? '•').toUpperCase();
  return badge;
}

export function emptyState(text: string) {
  const element = document.createElement('div');
  element.className = 'empty-state';
  element.textContent = text;
  return element;
}

/** The two lines of text in a list row. */
export function listText(title: string, detail: string) {
  const text = document.createElement('span');
  text.className = 'list-text';
  const main = document.createElement('span');
  main.className = 'list-title';
  main.textContent = title;
  const sub = document.createElement('small');
  sub.textContent = detail;
  text.append(main, sub);
  return text;
}
