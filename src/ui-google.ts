// "Google account" row in Settings → Navigation. Connect opens Google's own
// sign-in page in a tab; once signed in, Google keeps your searches in your
// account. main.ts reports which account is signed in.
import { SEARCH_ENGINES, type GoogleAccount, type Settings } from './shared';
import { $, terra } from './ui-common';

const text = $<HTMLElement>('#google-account-text');
const button = $<HTMLButtonElement>('#google-account');

let account: GoogleAccount | null = null;
let engine: Settings['searchEngine'] | null = null;

function render() {
  button.textContent = account ? 'Disconnect' : 'Connect';
  if (!account) {
    text.textContent = 'Sign in to keep your Google searches in your account';
  } else if (engine && engine !== 'google') {
    text.textContent = `${account.email}: searches go to ${SEARCH_ENGINES[engine].name}, so they aren't saved`;
  } else {
    text.textContent = `${account.email}: your searches are saved in your account`;
  }
}

async function refresh() {
  try {
    account = await terra.invoke<GoogleAccount | null>('terra:google-account');
  } catch {
    account = null;
  }
  render();
}

window.browser.onSettingsChanged((settings: Settings) => {
  engine = settings.searchEngine;
  render();
});
terra.on('terra:google-changed', () => void refresh());
// Signed in or out in another way (a site's own button): check on return.
window.browser.onWindowFocus((focused) => {
  if (focused) void refresh();
});
button.addEventListener('click', () =>
  terra.send(account ? 'terra:google-disconnect' : 'terra:google-connect'),
);
void refresh();
