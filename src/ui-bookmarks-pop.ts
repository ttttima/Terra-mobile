// The bookmarks pop-out: the button next to the sidebar toggle opens a list
// of every bookmark, grouped in folders. It's the only place bookmarks show
// (besides the Bookmarks page): the sidebar itself is for tabs. Make, rename and delete folders
// here; drag a bookmark onto a folder (or out of it) to move it, or use
// "Move to folder" in its right-click menu.
//
// It sits inside the sidebar column, 4px from each edge, so its rows and
// icons line up exactly with the tabs under it (and never overlap the web
// page, which is drawn above our UI).
import type { Bookmark, BookmarkFolder } from './shared';
import { $, actionButton, hostOf, icon, terra } from './ui-common';

/** The site's icon, or a letter badge when there is none (yet). */
function siteIcon(bookmark: Bookmark) {
  const box = document.createElement('span');
  box.className = 'tab-icon';
  const letter = () => {
    box.replaceChildren();
    box.classList.add('letter');
    box.textContent = (
      (bookmark.title || hostOf(bookmark.url)).trim()[0] ?? '•'
    ).toUpperCase();
  };
  if (bookmark.favicon) {
    const image = document.createElement('img');
    image.src = bookmark.favicon;
    image.alt = '';
    image.addEventListener('error', letter);
    box.append(image);
  } else {
    letter();
  }
  return box;
}

const button = $<HTMLButtonElement>('#bookmarks-pop-button');
const pop = $<HTMLDivElement>('#bookmarks-pop');

const OPEN_FOLDERS_KEY = 'terra-open-folders';
let openFolders = new Set<string>();
try {
  openFolders = new Set(
    JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]') as string[],
  );
} catch {
  // Starts with every folder closed.
}

function saveOpenFolders() {
  try {
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...openFolders]));
  } catch {
    // Only a convenience.
  }
}

/** Set while a folder name is being typed: re-renders keep the field. */
let editing: { folderId: string | null; value: string } | null = null;
/** A native menu was just opened from here: its focus change isn't a click away. */
let menuOpenedAt = 0;
let draggedId: string | null = null;
/** True while the list is being replaced: a field losing focus then isn't done. */
let replacing = false;

export function isBookmarksPopOpen() {
  return !pop.hidden;
}

export function closeBookmarksPop() {
  if (pop.hidden) return;
  pop.hidden = true;
  editing = null;
  button.classList.remove('active');
  button.ariaExpanded = 'false';
}

async function openPop() {
  pop.hidden = false;
  button.classList.add('active');
  button.ariaExpanded = 'true';
  await render();
}

button.addEventListener('click', () => {
  if (isBookmarksPopOpen()) closeBookmarksPop();
  else void openPop();
});

// Closes on Escape, a click anywhere else, or a click into the web page
// (which takes the focus away from our UI).
document.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target as Node;
    if (!pop.contains(target) && !button.contains(target)) closeBookmarksPop();
  },
  true,
);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isBookmarksPopOpen() && !editing) {
    closeBookmarksPop();
    button.focus();
  }
});
window.addEventListener('blur', () => {
  if (Date.now() - menuOpenedAt > 1000) closeBookmarksPop();
});

function openBookmark(bookmark: Bookmark, inNewTab: boolean) {
  terra.send('terra:bookmark-open', bookmark.id, inNewTab);
  if (!inNewTab) closeBookmarksPop();
}

/** A row shaped like a tab: icon, title, and buttons on the right. */
function baseRow(className: string, iconElement: HTMLElement, title: string) {
  const row = document.createElement('div');
  row.className = `tab pop-row ${className}`;
  row.tabIndex = 0;
  const label = document.createElement('span');
  label.className = 'tab-title';
  label.textContent = title;
  row.append(iconElement, label);
  return row;
}

function bookmarkRow(bookmark: Bookmark, inFolder: boolean) {
  const title = bookmark.title || hostOf(bookmark.url);
  const row = baseRow(
    inFolder ? 'pop-bookmark in-folder' : 'pop-bookmark',
    siteIcon(bookmark),
    title,
  );
  row.title = `${title}\n${bookmark.url}`;
  row.draggable = true;
  row.dataset.id = bookmark.id;
  row.append(
    actionButton('remove', 'Remove bookmark', () =>
      terra.send('terra:bookmark-remove', bookmark.id),
    ),
  );
  row.addEventListener('click', (event) =>
    openBookmark(bookmark, event.ctrlKey),
  );
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key === 'Enter') openBookmark(bookmark, event.ctrlKey);
    if (event.key === 'Delete')
      terra.send('terra:bookmark-remove', bookmark.id);
  });
  row.addEventListener('mousedown', (event) => {
    if (event.button === 1) event.preventDefault();
  });
  row.addEventListener('auxclick', (event) => {
    if (event.button === 1) openBookmark(bookmark, true);
  });
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    menuOpenedAt = Date.now();
    terra.send('terra:bookmark-menu', bookmark.id);
  });
  row.addEventListener('dragstart', (event) => {
    draggedId = bookmark.id;
    row.classList.add('dragging');
    event.dataTransfer?.setData('text/plain', bookmark.url);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => {
    draggedId = null;
    row.classList.remove('dragging');
    clearDropTargets();
  });
  return row;
}

function clearDropTargets() {
  for (const element of pop.querySelectorAll('.drop-into')) {
    element.classList.remove('drop-into');
  }
}

/** Dropping a bookmark on `element` moves it into `folderId` (null: top). */
function acceptDrop(element: HTMLElement, folderId: string | null) {
  element.addEventListener('dragover', (event) => {
    if (!draggedId) return;
    event.preventDefault();
    event.stopPropagation();
    clearDropTargets();
    element.classList.add('drop-into');
  });
  element.addEventListener('dragleave', (event) => {
    if (!element.contains(event.relatedTarget as Node)) {
      element.classList.remove('drop-into');
    }
  });
  element.addEventListener('drop', (event) => {
    if (!draggedId) return;
    event.preventDefault();
    event.stopPropagation();
    if (folderId) {
      openFolders.add(folderId);
      saveOpenFolders();
    }
    terra.send('terra:bookmark-move', draggedId, folderId);
    clearDropTargets();
  });
}

/** The text field for a new folder name (folderId null) or a rename. */
function nameField(folderId: string | null, initial: string) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pop-name';
  input.placeholder = 'Folder name';
  input.maxLength = 256;
  input.value = editing?.value ?? initial;
  input.ariaLabel = folderId ? 'Folder name' : 'New folder name';
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    editing = null;
    if (save && folderId === null) {
      void terra
        .invoke<string | null>('terra:folder-create', name || 'New folder')
        .then((id) => {
          if (id) {
            openFolders.add(id);
            saveOpenFolders();
          }
          void render();
        });
    } else if (save && name && name !== initial) {
      terra.send('terra:folder-rename', folderId, name);
    } else {
      void render();
    }
  };
  input.addEventListener('input', () => {
    if (editing) editing.value = input.value;
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => {
    if (!replacing) finish(true);
  });
  input.addEventListener('click', (event) => event.stopPropagation());
  return input;
}

function folderIcon() {
  const box = document.createElement('span');
  box.className = 'tab-icon';
  box.innerHTML = icon('folder');
  return box;
}

function folderRow(folder: BookmarkFolder, count: number) {
  const open = openFolders.has(folder.id);
  const row = baseRow('pop-folder', folderIcon(), folder.title);
  row.classList.toggle('open', open);
  row.ariaExpanded = String(open);
  row.title = `${folder.title} (${count})`;

  if (editing?.folderId === folder.id) {
    row
      .querySelector('.tab-title')!
      .replaceWith(nameField(folder.id, folder.title));
  } else {
    const countLabel = document.createElement('span');
    countLabel.className = 'pop-count';
    countLabel.textContent = String(count);
    row.append(
      countLabel,
      actionButton('pencil', 'Rename folder', () => {
        editing = { folderId: folder.id, value: folder.title };
        void render();
      }),
      actionButton('remove', 'Delete folder (keeps its bookmarks)', () => {
        openFolders.delete(folder.id);
        saveOpenFolders();
        terra.send('terra:folder-delete', folder.id);
      }),
    );
  }

  const toggle = () => {
    if (openFolders.has(folder.id)) openFolders.delete(folder.id);
    else openFolders.add(folder.id);
    saveOpenFolders();
    void render();
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (event) => {
    if (event.target !== row) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
    if (event.key === 'F2') {
      editing = { folderId: folder.id, value: folder.title };
      void render();
    }
  });
  acceptDrop(row, folder.id);
  return row;
}

function header() {
  const bar = document.createElement('div');
  bar.className = 'pop-header';
  const title = document.createElement('span');
  title.className = 'pop-title';
  title.textContent = 'Bookmarks';
  const newFolder = actionButton('folderPlus', 'New folder', () => {
    editing = { folderId: null, value: '' };
    void render();
  });
  const all = actionButton('list', 'All bookmarks', () => {
    closeBookmarksPop();
    terra.send('terra:open-bookmarks');
  });
  bar.append(title, newFolder, all);
  return bar;
}

let renderId = 0;

async function render() {
  if (pop.hidden) return;
  const id = ++renderId;
  const [bookmarks, folders] = await Promise.all([
    terra.invoke<Bookmark[]>('terra:bookmarks'),
    terra.invoke<BookmarkFolder[]>('terra:bookmark-folders'),
  ]);
  // A newer render started meanwhile, or the pop-out was closed.
  if (id !== renderId || pop.hidden) return;

  const focusedName = pop.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).closest<HTMLElement>('[data-id]')
        ?.dataset.id
    : undefined;

  const list = document.createElement('div');
  list.className = 'pop-list';
  acceptDrop(list, null);

  if (editing?.folderId === null) {
    const row = document.createElement('div');
    row.className = 'tab pop-row pop-folder editing';
    row.append(folderIcon(), nameField(null, ''));
    list.append(row);
  }

  for (const folder of folders) {
    const inside = bookmarks.filter((b) => b.folderId === folder.id);
    list.append(folderRow(folder, inside.length));
    if (openFolders.has(folder.id)) {
      if (inside.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pop-folder-empty';
        empty.textContent = 'Drag bookmarks here';
        acceptDrop(empty, folder.id);
        list.append(empty);
      }
      for (const bookmark of inside) list.append(bookmarkRow(bookmark, true));
    }
  }

  const loose = bookmarks.filter((b) => !b.folderId);
  // A line between the folders and the loose bookmarks, like after pinned tabs.
  if (folders.length && loose.length) {
    list.lastElementChild?.classList.add('pop-group-end');
  }
  for (const bookmark of loose) list.append(bookmarkRow(bookmark, false));

  if (!bookmarks.length && !folders.length && !editing) {
    const empty = document.createElement('div');
    empty.className = 'pop-empty';
    empty.textContent = 'Star a page to save it here';
    list.append(empty);
  }

  replacing = true;
  pop.replaceChildren(header(), list);
  replacing = false;
  pop.querySelector<HTMLInputElement>('.pop-name')?.focus();
  if (focusedName) {
    pop
      .querySelector<HTMLElement>(`[data-id="${CSS.escape(focusedName)}"]`)
      ?.focus();
  }
}

terra.on('terra:bookmarks-changed', () => void render());
