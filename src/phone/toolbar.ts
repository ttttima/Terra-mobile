// The phone's toolbar, at the bottom where the thumb is: the tabs button,
// the address (site name, lock and refresh mirrored inside it), the ⋮
// menu. Also its suggestions, find on page and the question bar above it.
// The same behavior as the desktop's ui-toolbar.ts, for a touch screen.
import type { FindResult, Notice, Suggestion } from '../shared';
import type { PhoneState } from './brain';
import { phoneIcon } from './icons';
import { closeLayer, openLayer, showKeyboard } from './layout';

const $ = <T extends HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

const terra = window.terra;
const body = document.body;
const toolbar = $<HTMLDivElement>('#toolbar');
const address = $<HTMLInputElement>('#address');
const addressBox = $<HTMLDivElement>('#address-box');
const siteButton = $<HTMLButtonElement>('#site-button');
const reloadButton = $<HTMLButtonElement>('#reload-button');
const clearButton = $<HTMLButtonElement>('#clear-address');
const progress = $<HTMLSpanElement>('#progress');
const startPage = $<HTMLElement>('#start-page');
const startSearch = $<HTMLInputElement>('#start-search');
const startForm = $<HTMLFormElement>('#start-form');

let state: PhoneState | null = null;
let currentUrl = '';

// ---------------------------------------------------------------- address

/** The address while not editing: just the site ("chatgpt.com"). */
function shortUrl(url: string) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    return hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function showAddress() {
  const editing = document.activeElement === address;
  address.value = editing ? currentUrl : shortUrl(currentUrl);
  address.classList.toggle('empty', !currentUrl);
}

address.addEventListener('focus', () => {
  address.dataset.justFocused = '1';
  body.classList.add('editing');
  openLayer('editing', () => address.blur());
  showAddress();
  address.select();
});
address.addEventListener('blur', () => {
  body.classList.remove('editing');
  closeLayer('editing');
  showAddress();
});
// The tap that focused the field would put the caret in: keep it all
// selected, like other browsers.
address.addEventListener('mouseup', (event) => {
  if (address.dataset.justFocused) {
    event.preventDefault();
    address.select();
    delete address.dataset.justFocused;
  }
});
address.addEventListener('keydown', (event) => {
  if (suggestKeydown(event)) return;
  if (event.key === 'Enter') {
    closeSuggestions();
    window.browser.navigate(address.value);
    address.blur();
  } else if (event.key === 'Escape') {
    address.blur();
  }
});

// The field's padding is part of it too.
addressBox.addEventListener('click', (event) => {
  if (event.target === addressBox) address.focus();
});

// Keep the keyboard up: pressing the clear button mustn't take the focus.
clearButton.addEventListener('pointerdown', (event) => event.preventDefault());
clearButton.addEventListener('mousedown', (event) => event.preventDefault());
clearButton.addEventListener('click', () => {
  address.value = '';
  closeSuggestions();
  address.focus();
});

reloadButton.addEventListener('click', () => {
  if (state?.loading) window.browser.stop();
  else window.browser.reload();
});
siteButton.addEventListener('click', () => terra.send('terra:site-menu'));
$('#menu-button').addEventListener('click', () => {
  address.blur();
  terra.send('terra:main-menu');
});

window.browser.onStateChanged((next) => {
  state = next as PhoneState;
  currentUrl = state.url;
  if (document.activeElement !== address) showAddress();
  siteButton.dataset.security = state.security;
  siteButton.dataset.private = String(state.isPrivate);
  siteButton.title = state.isPrivate
    ? 'Private tab: nothing here is remembered'
    : state.security === 'insecure'
      ? 'Not secure: this site doesn’t use a private connection'
      : 'About this site';
  reloadButton.classList.toggle('loading', state.loading);
  reloadButton.title = state.loading ? 'Stop' : 'Refresh';
  reloadButton.ariaLabel = reloadButton.title;
  progress.classList.toggle('loading', state.loading && !!state.url);
  progress.style.width = `${state.loading ? Math.max(8, state.progress) : 100}%`;
});

window.browser.onFocusAddress(() => {
  // On a new tab, type into the big search box in the middle instead.
  const target = startPage.hidden ? address : startSearch;
  if (document.activeElement === target) return;
  target.focus();
  target.select();
  showKeyboard();
});

// ---------------------------------------------------------------- swipe tabs

let swipeTabs = true;
window.browser.onSettingsChanged((settings) => {
  swipeTabs = settings.scrollTabs;
  searchSuggestions = settings.searchSuggestions;
});

/**
 * "Swipe through tabs": the address follows the finger sideways; far
 * enough and the next (left) or previous (right) tab opens.
 */
{
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let sliding = false;
  addressBox.addEventListener('pointerdown', (event) => {
    if (!swipeTabs || body.classList.contains('editing')) return;
    if (event.pointerType === 'mouse') return;
    tracking = true;
    sliding = false;
    startX = event.clientX;
    startY = event.clientY;
  });
  addressBox.addEventListener('pointermove', (event) => {
    if (!tracking) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!sliding) {
      if (Math.abs(dy) > 16) tracking = false;
      else if (Math.abs(dx) > 12) {
        sliding = true;
        addressBox.classList.add('dragging');
        addressBox.setPointerCapture(event.pointerId);
      }
      return;
    }
    addressBox.style.transform = `translateX(${dx / 2}px)`;
  });
  const end = (event: PointerEvent, cancelled: boolean) => {
    if (!tracking) return;
    tracking = false;
    if (!sliding) return;
    sliding = false;
    addressBox.classList.remove('dragging');
    addressBox.style.transform = '';
    const dx = event.clientX - startX;
    if (!cancelled && Math.abs(dx) > 64) {
      terra.send('terra:scroll-tabs', dx < 0 ? 1 : -1);
    }
  };
  addressBox.addEventListener('pointerup', (event) => end(event, false));
  addressBox.addEventListener('pointercancel', (event) => end(event, true));
}

// ---------------------------------------------------------------- new tab page

startForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!startSearch.value.trim()) return;
  closeSuggestions();
  window.browser.navigate(startSearch.value);
  startSearch.value = '';
  startSearch.blur();
});
startSearch.addEventListener('keydown', (event) => {
  if (suggestKeydown(event)) return;
  if (event.key === 'Escape') startSearch.value = '';
});
startSearch.addEventListener('focus', () =>
  openLayer('start-search', () => startSearch.blur()),
);
startSearch.addEventListener('blur', () => closeLayer('start-search'));

// ---------------------------------------------------------------- suggestions

const suggestPanel = $<HTMLDivElement>('#suggest');
const suggestList = $<HTMLUListElement>('#suggest-list');

const KIND_ICONS: Record<Suggestion['kind'], string> = {
  search: 'search',
  url: 'globe',
  tab: 'tab',
  bookmark: 'star',
  history: 'clock',
};

let input: HTMLInputElement | null = null;
let items: Suggestion[] = [];
let selected = -1;
/** What the user typed, without the inline completion. */
let typed = '';
let request = 0;
let searchSuggestions = false;

/** Over the page above the toolbar, or under the new tab page's box. */
function position() {
  if (!input) return;
  const fromStart = input === startSearch;
  suggestPanel.classList.toggle('from-start', fromStart);
  const style = suggestPanel.style;
  if (fromStart) {
    // Under the box, 8px apart; placed inside the panel, which starts
    // under the status bar.
    const form = startForm.getBoundingClientRect();
    const area = $('#page-area').getBoundingClientRect();
    const panel = suggestPanel.getBoundingClientRect();
    style.setProperty('--suggest-top', `${form.bottom + 8 - panel.top}px`);
    style.setProperty('--suggest-left', `${form.left - panel.left}px`);
    style.setProperty('--suggest-width', `${form.width}px`);
    style.setProperty(
      '--suggest-max',
      `${Math.max(0, area.bottom - form.bottom - 16)}px`,
    );
    style.setProperty('--suggest-bottom', '0px');
  } else {
    const top = toolbar.getBoundingClientRect().top;
    style.setProperty('--suggest-bottom', `${innerHeight - top}px`);
  }
}

function render() {
  suggestList.replaceChildren(
    ...items.map((item, index) => {
      const row = document.createElement('li');
      row.className = 'suggest-item';
      row.role = 'option';
      row.ariaSelected = String(index === selected);
      row.classList.toggle('selected', index === selected);
      row.innerHTML = phoneIcon(KIND_ICONS[item.kind]);
      const text = document.createElement('span');
      text.className = 'suggest-text';
      const title = document.createElement('span');
      title.className = 'suggest-title';
      title.textContent = item.title;
      const detail = document.createElement('span');
      detail.className = 'suggest-detail';
      detail.textContent = item.detail;
      text.append(title, detail);
      row.append(text);
      // Keep the keyboard up while choosing.
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => choose(item));
      return row;
    }),
  );
  suggestPanel.hidden = items.length === 0;
  position();
}

export function closeSuggestions() {
  request++;
  items = [];
  selected = -1;
  suggestPanel.hidden = true;
}

async function update(target: HTMLInputElement, deleting: boolean) {
  input = target;
  typed = target.value;
  const query = typed.trim();
  if (!query) {
    closeSuggestions();
    return;
  }
  const id = ++request;
  const result = await terra.invoke<{
    suggestions: Suggestion[];
    complete: string;
  }>('terra:suggest', query);
  if (id !== request || document.activeElement !== target) return;

  items = result.suggestions;
  selected = -1;
  // Inline completion: "git" -> "github.com" with "hub.com" selected.
  const caretAtEnd = target.selectionStart === target.value.length;
  if (
    !deleting &&
    caretAtEnd &&
    result.complete &&
    result.complete.startsWith(typed.toLowerCase()) &&
    typed === typed.trimStart()
  ) {
    target.value = typed + result.complete.slice(typed.length);
    target.setSelectionRange(typed.length, target.value.length);
  }
  render();

  if (!searchSuggestions) return;
  const remote = await terra.invoke<Suggestion[]>(
    'terra:suggest-remote',
    query,
  );
  if (id !== request || !remote.length) return;
  const known = new Set(items.map((item) => item.value));
  items = [...items, ...remote.filter((item) => !known.has(item.value))].slice(
    0,
    8,
  );
  render();
}

function choose(item: Suggestion) {
  const target = input;
  closeSuggestions();
  if (item.kind === 'tab') terra.send('terra:switch-tab', Number(item.value));
  else window.browser.navigate(item.value);
  if (target) {
    target.value = '';
    target.blur();
  }
}

/** Keys from a hardware keyboard, like on the desktop. */
function suggestKeydown(event: KeyboardEvent): boolean {
  if (suggestPanel.hidden || !input) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    selected =
      ((selected + step + 1 + items.length + 1) % (items.length + 1)) - 1;
    const item = items[selected];
    input.value =
      !item || item.kind === 'tab'
        ? typed
        : item.kind === 'search'
          ? item.title
          : item.value;
    render();
    return true;
  }
  if (event.key === 'Enter' && selected >= 0) {
    event.preventDefault();
    choose(items[selected]);
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    if (input.value !== typed) input.value = typed;
    closeSuggestions();
    return true;
  }
  return false;
}

for (const target of [address, startSearch]) {
  target.addEventListener('input', (event) => {
    const type = (event as InputEvent).inputType ?? '';
    void update(target, type.startsWith('delete'));
  });
  target.addEventListener('blur', () => {
    if (input === target) closeSuggestions();
  });
}

// The keyboard coming up moves things: follow.
new ResizeObserver(() => {
  if (!suggestPanel.hidden) position();
}).observe($('#page-area'));

// ---------------------------------------------------------------- find

const findBar = $<HTMLDivElement>('#find-bar');
const findInput = $<HTMLInputElement>('#find-input');
const findCount = $<HTMLSpanElement>('#find-count');

function openFind() {
  closeSuggestions();
  address.blur();
  addressBox.hidden = true;
  findBar.hidden = false;
  body.classList.add('finding');
  openLayer('find', closeFind, false);
  findInput.focus();
  findInput.select();
  showKeyboard();
  if (findInput.value) terra.send('terra:find', findInput.value, true, true);
}

function closeFind() {
  if (findBar.hidden) return;
  terra.send('terra:find-stop');
  findInput.blur();
  findBar.hidden = true;
  addressBox.hidden = false;
  body.classList.remove('finding');
  closeLayer('find');
  findCount.textContent = '';
  findBar.classList.remove('no-match');
}

terra.on('terra:find-open', openFind);
terra.on('terra:find-close', closeFind);
terra.on<FindResult>('terra:find-result', ({ active, total }) => {
  const searching = findInput.value.length > 0;
  findCount.textContent = total
    ? `${active} of ${total}`
    : searching
      ? 'None'
      : '';
  findBar.classList.toggle('no-match', searching && total === 0);
});
findInput.addEventListener('input', () =>
  terra.send('terra:find', findInput.value, true, true),
);
findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && findInput.value) {
    terra.send('terra:find', findInput.value, !event.shiftKey, false);
  } else if (event.key === 'Escape') {
    closeFind();
  }
});
for (const button of ['#find-next', '#find-prev']) {
  $(button).addEventListener('mousedown', (event) => event.preventDefault());
}
$('#find-next').addEventListener('click', () =>
  terra.send('terra:find', findInput.value, true, false),
);
$('#find-prev').addEventListener('click', () =>
  terra.send('terra:find', findInput.value, false, false),
);
$('#find-close').addEventListener('click', closeFind);

// ---------------------------------------------------------------- questions

const noticeBar = $<HTMLDivElement>('#notice-bar');
const noticeText = $<HTMLSpanElement>('#notice-text');
const noticeControls = $<HTMLDivElement>('#notice-controls');

terra.on<Notice | null>('terra:notice', (notice) => {
  noticeBar.hidden = !notice;
  body.classList.toggle('notice-open', !!notice);
  if (!notice) {
    noticeControls.replaceChildren();
    return;
  }
  noticeText.textContent = notice.text;

  const inputs = (notice.fields ?? []).map((field) => {
    const element = document.createElement('input');
    element.type = field.type;
    element.name = field.name;
    element.placeholder = field.label;
    element.ariaLabel = field.label;
    element.spellcheck = false;
    element.autocapitalize = 'off';
    return element;
  });
  let choice: HTMLSelectElement | null = null;
  if (notice.choices?.length) {
    choice = document.createElement('select');
    choice.ariaLabel = 'Choose';
    for (const option of notice.choices) {
      choice.add(new Option(option.label, option.value));
    }
  }
  const answer = (action: string) => {
    const fields: Record<string, string> = {};
    for (const element of inputs) fields[element.name] = element.value;
    terra.send(
      'terra:notice-answer',
      notice.id,
      action,
      fields,
      choice?.value ?? '',
    );
  };
  const buttons = notice.actions.map((action, index) => {
    const button = document.createElement('button');
    button.className = index === 0 ? 'primary' : 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => answer(action.id));
    return button;
  });
  for (const element of inputs) {
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') answer(notice.actions[0].id);
    });
  }
  noticeControls.replaceChildren(
    ...inputs,
    ...(choice ? [choice] : []),
    ...buttons,
  );
  if (inputs[0]) {
    inputs[0].focus();
    showKeyboard();
  }
});
