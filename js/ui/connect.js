// connect.js: the small Sheet connection screen (spec section 11, log Q7). The secret key is typed
// here once, on the phone, and kept in the app's settings. It is never written in the code or in
// the repository, and it is never shown again after saving. Phase 8 builds the full Settings screen
// and this panel moves into it.

import { el, clear, section } from './dom.js';
import { getSetting, setSetting } from '../db.js';

export async function openConnect(ctx, root) {
  clear(root);
  const hasKey = !!(await getSetting(ctx.db, 'secret_key'));
  const msg = el('div', { class: 'muted msg' });
  const input = el('input', {
    type: 'password',
    class: 'input',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: hasKey ? 'A key is saved. Type a new one to replace it.' : 'Paste your secret key'
  });
  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => save() }, 'Save key');
  const cancelBtn = el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel');

  async function save() {
    const key = input.value.trim();
    if (key === '') {
      msg.textContent = 'Type or paste the key first.';
      return;
    }
    saveBtn.disabled = true;
    try {
      await setSetting(ctx.db, 'secret_key', key);
    } catch (err) {
      ctx.warn('Could not save the key. Nothing was changed. Try again.');
      saveBtn.disabled = false;
      return;
    }
    ctx.setSyncNote('Key saved. Tap Sync to send your blocks.');
    await ctx.show('home');
  }

  root.append(
    el('div', { class: 'head page-head' }, [el('h2', { class: 'title', text: 'Sheet connection' })]),
    section(1, 'Secret key', [
      el('p', { class: 'muted', text: 'This is the key stored in your Apps Script under the name SECRET. It stays on this phone and is never shown again.' }),
      input,
      msg
    ]),
    el('div', { class: 'btn-row' }, [saveBtn, cancelBtn])
  );
}
