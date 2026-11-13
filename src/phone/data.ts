// What Terra remembers on the phone: history, bookmarks and their folders,
// what each site may do, and the open tabs. The same rules and file names
// as the desktop app (library.ts, bookmarks.ts, site-settings.ts,
// session-store.ts); the files live in the app's private storage on the
// phone and never leave it.
import type {
  Bookmark,
  BookmarkFolder,
  HistoryEntry,
  PermissionDecision,
  SiteInfo,
} from '../shared';
import { call, post } from './host';

const MAX_HISTORY = 10_000;
const MAX_BOOKMARKS = 20_000;
const MAX_FOLDERS = 500;

export const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const isText = (value: unknown, max = 4096): value is string =>
  typeof value === 'string' && value.length <= max;

// ---------------------------------------------------------------- storage

export function readJson(name: string): unknown {
  const text = call<string>('fs.read', { name });
  if (!text) return null;
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

const pendingWrites = new Map<string, () => unknown>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Writes everything waiting now (the app is going to the background). */
export function flushWrites() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = null;
  for (const [name, getData] of pendingWrites) {
    post('fs.write', { name, text: JSON.stringify(getData()) });
  }
  pendingWrites.clear();
}

/** Saves a second after the last change. */
export function saveSoon(name: string, getData: () => unknown) {
  pendingWrites.set(name, getData);
  writeTimer ??= setTimeout(flushWrites, 1000);
}

// ---------------------------------------------------------------- history

/** Newest first. */
let history: HistoryEntry[] = [];
let historyChanged = () => {};
let historyNotifyTimer: ReturnType<typeof setTimeout> | null = null;

function onHistoryChange() {
  saveSoon('history.json', () => history);
  historyNotifyTimer ??= setTimeout(() => {
    historyNotifyTimer = null;
    historyChanged();
  }, 500);
}

export function initHistory(onChange: () => void) {
  historyChanged = onChange;
  const saved = readJson('history.json');
  history = Array.isArray(saved)
    ? saved
        .filter(
          (e): e is HistoryEntry =>
            e &&
            isText(e.id, 64) &&
            isText(e.url) &&
            /^https?:\/\//i.test(e.url) &&
            isText(e.title, 1024) &&
            typeof e.time === 'number',
        )
        .slice(0, MAX_HISTORY)
    : [];
}

/** Records a visit and returns its id (so the title can be added later). */
export function recordVisit(url: string, title: string): string {
  const latest = history[0];
  if (latest && latest.url === url) {
    latest.time = Date.now();
    if (title) latest.title = title;
    onHistoryChange();
    return latest.id;
  }
  const entry: HistoryEntry = { id: newId(), url, title, time: Date.now() };
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  onHistoryChange();
  return entry.id;
}

export function updateVisitTitle(id: string, title: string) {
  const entry = history.find((e) => e.id === id);
  if (!entry || entry.title === title) return;
  entry.title = title.slice(0, 1024);
  onHistoryChange();
}

export const getHistory = () => history;

export function deleteHistoryEntry(id: string) {
  history = history.filter((e) => e.id !== id);
  onHistoryChange();
}

/** Forgets every visit to one address (Shift+Delete in suggestions). */
export function deleteHistoryUrl(url: string) {
  history = history.filter((e) => e.url !== url);
  onHistoryChange();
}

export function clearHistory() {
  history = [];
  onHistoryChange();
}

// ---------------------------------------------------------------- bookmarks

/** Newest first. */
let bookmarks: Bookmark[] = [];
/** In the order they were made. */
let folders: BookmarkFolder[] = [];
let bookmarksChanged = () => {};

function changed() {
  saveSoon('bookmarks.json', () => bookmarks);
  bookmarksChanged();
}

function foldersChanged() {
  saveSoon('bookmark-folders.json', () => folders);
  changed();
}

function validFavicon(favicon: unknown): favicon is string {
  return (
    isText(favicon, 8192) && /^(https?:|data:image\/)/i.test(favicon as string)
  );
}

export function initBookmarks(notify: () => void) {
  bookmarksChanged = notify;
  const savedFolders = readJson('bookmark-folders.json');
  folders = Array.isArray(savedFolders)
    ? savedFolders
        .filter(
          (f): f is BookmarkFolder =>
            f &&
            isText(f.id, 64) &&
            isText(f.title, 256) &&
            typeof f.time === 'number',
        )
        .slice(0, MAX_FOLDERS)
    : [];
  const folderIds = new Set(folders.map((f) => f.id));
  const saved = readJson('bookmarks.json');
  bookmarks = Array.isArray(saved)
    ? saved
        .filter(
          (b): b is Bookmark =>
            b &&
            isText(b.id, 64) &&
            isText(b.url) &&
            /^(https?|file):/i.test(b.url) &&
            isText(b.title, 1024) &&
            typeof b.time === 'number',
        )
        .map((b) => ({
          ...b,
          favicon: validFavicon(b.favicon) ? b.favicon : undefined,
          folderId:
            isText(b.folderId, 64) && folderIds.has(b.folderId)
              ? b.folderId
              : undefined,
        }))
        .slice(0, MAX_BOOKMARKS)
    : [];
}

export const getBookmarks = () => bookmarks;
export const getFolders = () => folders;

export const isBookmarked = (url: string) =>
  bookmarks.some((bookmark) => bookmark.url === url);

export function createFolder(title: string) {
  if (folders.length >= MAX_FOLDERS) return null;
  const folder = {
    id: newId(),
    title: title.trim().slice(0, 256) || 'New folder',
    time: Date.now(),
  };
  folders.push(folder);
  foldersChanged();
  return folder.id;
}

export function renameFolder(id: string, title: string) {
  const folder = folders.find((f) => f.id === id);
  const name = title.trim().slice(0, 256);
  if (!folder || !name) return;
  folder.title = name;
  foldersChanged();
}

/** Deletes the folder only; its bookmarks move to the top level. */
export function deleteFolder(id: string) {
  folders = folders.filter((f) => f.id !== id);
  for (const bookmark of bookmarks) {
    if (bookmark.folderId === id) bookmark.folderId = undefined;
  }
  foldersChanged();
}

export function moveBookmark(id: string, folderId: string | null) {
  const bookmark = bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  if (folderId !== null && !folders.some((f) => f.id === folderId)) return;
  bookmark.folderId = folderId ?? undefined;
  changed();
}

function siteOf(url: string) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** A page is open with this icon: its bookmarks (and the site's) get it. */
export function setBookmarkFavicon(pageUrl: string, favicon: string) {
  if (!validFavicon(favicon)) return;
  const origin = siteOf(pageUrl);
  let updated = false;
  for (const bookmark of bookmarks) {
    const exact = bookmark.url === pageUrl;
    const sameSite = !bookmark.favicon && siteOf(bookmark.url) === origin;
    if ((exact || sameSite) && bookmark.favicon !== favicon) {
      bookmark.favicon = favicon;
      updated = true;
    }
  }
  if (updated) changed();
}

/** Adds the page, or removes it if it's already bookmarked. */
export function toggleBookmark(
  url: string,
  title: string,
  favicon: string | null = null,
): boolean {
  if (isBookmarked(url)) {
    bookmarks = bookmarks.filter((bookmark) => bookmark.url !== url);
    changed();
    return false;
  }
  bookmarks.unshift({
    id: newId(),
    url,
    title: title.slice(0, 1024),
    time: Date.now(),
    ...(validFavicon(favicon) ? { favicon } : {}),
  });
  if (bookmarks.length > MAX_BOOKMARKS) bookmarks.length = MAX_BOOKMARKS;
  changed();
  return true;
}

export function removeBookmark(id: string) {
  bookmarks = bookmarks.filter((bookmark) => bookmark.id !== id);
  changed();
}

export function renameBookmark(id: string, title: string) {
  const bookmark = bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  bookmark.title = title.trim().slice(0, 1024);
  changed();
}

// ---------------------------------------------------------------- sites

interface Site {
  permissions: Record<string, PermissionDecision>;
  zoom: number;
  allowAds: boolean;
  neverSavePasswords: boolean;
}

let sites: Record<string, Site> = {};
let sitesChanged = () => {};

const emptySite = (): Site => ({
  permissions: {},
  zoom: 0,
  allowAds: false,
  neverSavePasswords: false,
});

function siteChanged(origin: string) {
  const site = sites[origin];
  if (
    site &&
    Object.keys(site.permissions).length === 0 &&
    site.zoom === 0 &&
    !site.allowAds &&
    !site.neverSavePasswords
  ) {
    delete sites[origin];
  }
  saveSoon('sites.json', () => sites);
  sitesChanged();
}

export function initSites(notify: () => void) {
  sitesChanged = notify;
  const saved = readJson('sites.json');
  sites = {};
  if (!saved || typeof saved !== 'object') return;
  for (const [origin, value] of Object.entries(
    saved as Record<string, unknown>,
  )) {
    if (!isText(origin, 512) || !value || typeof value !== 'object') continue;
    const raw = value as Partial<Site>;
    const permissions: Record<string, PermissionDecision> = {};
    for (const [name, decision] of Object.entries(raw.permissions ?? {})) {
      if (isText(name, 64) && (decision === 'allow' || decision === 'block')) {
        permissions[name] = decision;
      }
    }
    sites[origin] = {
      permissions,
      zoom:
        typeof raw.zoom === 'number' ? Math.max(-5, Math.min(5, raw.zoom)) : 0,
      allowAds: raw.allowAds === true,
      neverSavePasswords: raw.neverSavePasswords === true,
    };
  }
}

/** "https://example.com" for a page address, or "" when it has no origin. */
export function originOf(url: string): string {
  try {
    const { protocol, origin } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : '';
  } catch {
    return '';
  }
}

const site = (origin: string) => (sites[origin] ??= emptySite());

export const getPermission = (origin: string, name: string) =>
  sites[origin]?.permissions[name];

export function setPermission(
  origin: string,
  name: string,
  decision: PermissionDecision,
) {
  if (!origin) return;
  site(origin).permissions[name] = decision;
  siteChanged(origin);
}

export const getZoom = (origin: string) => sites[origin]?.zoom ?? 0;

export function setZoom(origin: string, zoom: number) {
  if (!origin) return;
  site(origin).zoom = Math.max(-5, Math.min(5, zoom));
  siteChanged(origin);
}

export const adsAllowed = (origin: string) => sites[origin]?.allowAds === true;

/** Sites where the ad blocker is off, for the app's request filter. */
export const adsAllowedOrigins = () =>
  Object.entries(sites)
    .filter(([, s]) => s.allowAds)
    .map(([origin]) => origin);

export function setAdsAllowed(origin: string, allow: boolean) {
  if (!origin) return;
  site(origin).allowAds = allow;
  siteChanged(origin);
}

export const passwordsNeverSaved = (origin: string) =>
  sites[origin]?.neverSavePasswords === true;

export function setNeverSavePasswords(origin: string, never: boolean) {
  if (!origin) return;
  site(origin).neverSavePasswords = never;
  siteChanged(origin);
}

export function getSites(): SiteInfo[] {
  return Object.entries(sites)
    .map(([origin, s]) => ({ origin, ...s }))
    .sort((a, b) => a.origin.localeCompare(b.origin));
}

export function resetSite(origin: string, permission?: string) {
  if (!sites[origin]) return;
  if (permission) delete sites[origin].permissions[permission];
  else delete sites[origin];
  siteChanged(origin);
}

// ---------------------------------------------------------------- session

export interface SavedTab {
  url: string;
  title: string;
  pinned: boolean;
}

export interface SavedSession {
  tabs: SavedTab[];
  active: number;
}

let session: SavedSession = { tabs: [], active: 0 };

export function loadSession(): SavedSession {
  const saved = readJson('session.json') as Partial<SavedSession> | null;
  const tabs = Array.isArray(saved?.tabs)
    ? saved.tabs
        .filter(
          (t): t is SavedTab =>
            t &&
            isText(t.url) &&
            /^https?:/i.test(t.url) &&
            isText(t.title, 1024),
        )
        .map((t) => ({ url: t.url, title: t.title, pinned: t.pinned === true }))
        .slice(0, 500)
    : [];
  const active = Number(saved?.active);
  return {
    tabs,
    active:
      Number.isInteger(active) && active >= 0 && active < tabs.length
        ? active
        : 0,
  };
}

export function saveSession(next: SavedSession) {
  session = next;
  saveSoon('session.json', () => session);
}
