// The phone's icons: the desktop set (ui-common.ts) and a few more for its
// menus. Same style: 24x24, stroked, round caps (design rule 5).
import { PATHS } from '../ui-common';

const MORE = {
  back: '<line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />',
  forward:
    '<line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />',
  reload:
    '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" /><polyline points="20 4 20 8.5 15.5 8.5" />',
  stop: PATHS.remove,
  share:
    '<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.6" y1="13.5" x2="15.4" y2="17.5" /><line x1="15.4" y1="6.5" x2="8.6" y2="10.5" />',
  plus: '<line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />',
  minus: '<line x1="5" y1="12" x2="19" y2="12" />',
  monitor:
    '<rect x="3" y="4" width="18" height="12" rx="2" /><line x1="8" y1="20" x2="16" y2="20" /><line x1="12" y1="16" x2="12" y2="20" />',
  printer:
    '<polyline points="6 9 6 3 18 3 18 9" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" />',
  settings:
    '<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />',
  download:
    '<line x1="12" y1="4" x2="12" y2="15" /><polyline points="7 10 12 15 17 10" /><line x1="5" y1="20" x2="19" y2="20" />',
  text: '<polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" />',
  pin: '<line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2z" />',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z" />',
  trash:
    '<polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />',
  retry:
    '<path d="M20 12a8 8 0 1 1-2.34-5.66L20 8.5" /><polyline points="20 4 20 8.5 15.5 8.5" />',
  check: '<polyline points="20 6 9 17 4 12" />',
  chevron: '<polyline points="9 18 15 12 9 6" />',
  pause:
    '<line x1="9" y1="5" x2="9" y2="19" /><line x1="15" y1="5" x2="15" y2="19" />',
  resume: '<polygon points="7 5 19 12 7 19 7 5" />',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="14 3 14 9 20 9" />',
};

export const ICONS = { ...PATHS, ...MORE };
export type PhoneIcon = keyof typeof ICONS;

export const phoneIcon = (name: string, extra = '') =>
  `<svg class="icon${extra ? ` ${extra}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name as PhoneIcon] ?? ''}</svg>`;
