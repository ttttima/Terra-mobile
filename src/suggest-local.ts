// Address bar suggestions from open tabs, bookmarks and history. Plain
// logic with no Electron in it, so the phone app (src/phone) uses it too.
import type {
  Bookmark,
  HistoryEntry,
  SearchEngine,
  Suggestion,
} from './shared';

export interface SuggestContext {
  tabs: { id: number; title: string; url: string }[];
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  /** URL for typed text if it is an address (not a search), else null. */
  asAddress: (text: string) => string | null;
  searchUrl: (text: string) => string;
  engineName: string;
}

export interface SuggestResult {
  suggestions: Suggestion[];
  /** A site address that starts with the typed text, to complete inline. */
  complete: string;
}

const MAX = 8;

const display = (url: string) =>
  url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export function localSuggestions(
  query: string,
  ctx: SuggestContext,
): SuggestResult {
  const text = query.trim();
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  const matches = (title: string, url: string) => {
    const haystack = `${title} ${display(url)}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  };

  // History grouped by address: visited often and recently ranks higher.
  const now = Date.now();
  const scores = new Map<
    string,
    { url: string; title: string; score: number }
  >();
  for (const entry of ctx.history) {
    if (!matches(entry.title, entry.url)) continue;
    const ageDays = (now - entry.time) / 86_400_000;
    const weight =
      ageDays < 4 ? 1 : ageDays < 14 ? 0.7 : ageDays < 31 ? 0.5 : 0.3;
    const item = scores.get(entry.url) ?? {
      url: entry.url,
      title: entry.title,
      score: 0,
    };
    item.score += weight;
    if (!item.title && entry.title) item.title = entry.title;
    scores.set(entry.url, item);
  }
  // Typing the start of a site's address ranks it first.
  const startsWith = (url: string) =>
    display(url).toLowerCase().startsWith(lower) ? 10 : 0;
  const history = [...scores.values()]
    .map((item) => ({ ...item, score: item.score + startsWith(item.url) }))
    .sort((a, b) => b.score - a.score);

  // Inline completion: the best site whose address starts with what's typed.
  let complete = '';
  if (lower && !lower.includes(' ')) {
    const candidates = [
      ...history.map((h) => h.url),
      ...ctx.bookmarks.map((b) => b.url),
    ];
    for (const url of candidates) {
      const host = hostOf(url);
      if (host.startsWith(lower) && host.length > lower.length) {
        complete = host;
        break;
      }
    }
  }

  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion) => {
    const key = s.kind === 'tab' ? `tab:${s.value}` : s.value;
    if (seen.has(key) || suggestions.length >= MAX) return;
    seen.add(key);
    suggestions.push(s);
  };

  if (complete) {
    const url = ctx.asAddress(complete) ?? `https://${complete}`;
    add({ kind: 'url', value: url, title: complete, detail: 'Go to site' });
  }
  const address = ctx.asAddress(text);
  if (address) {
    add({
      kind: 'url',
      value: address,
      title: display(address),
      detail: 'Go to site',
    });
  } else if (text) {
    add({
      kind: 'search',
      value: ctx.searchUrl(text),
      title: text,
      detail: `Search ${ctx.engineName}`,
    });
  }

  for (const tab of ctx.tabs
    .filter((t) => t.url && matches(t.title, t.url))
    .slice(0, 2)) {
    add({
      kind: 'tab',
      value: String(tab.id),
      title: tab.title,
      detail: `Switch to tab · ${display(tab.url)}`,
    });
  }
  for (const bookmark of ctx.bookmarks
    .filter((b) => matches(b.title, b.url))
    .slice(0, 3)) {
    add({
      kind: 'bookmark',
      value: bookmark.url,
      title: bookmark.title || display(bookmark.url),
      detail: display(bookmark.url),
    });
  }
  for (const item of history.slice(0, 6)) {
    add({
      kind: 'history',
      value: item.url,
      title: item.title || display(item.url),
      detail: display(item.url),
    });
  }
  return { suggestions, complete };
}

const REMOTE: Record<SearchEngine, (q: string) => string> = {
  google: (q) =>
    `https://suggestqueries.google.com/complete/search?client=firefox&q=${encodeURIComponent(q)}`,
  duckduckgo: (q) =>
    `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
  bing: (q) =>
    `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
  brave: (q) =>
    `https://search.brave.com/api/suggest?q=${encodeURIComponent(q)}`,
};

/** Where to ask the search engine for suggestions (OpenSearch JSON). */
export const remoteSuggestUrl = (engine: SearchEngine, query: string) =>
  REMOTE[engine](query);
