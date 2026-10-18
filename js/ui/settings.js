// settings.js: the Settings view (PRD section 5.5, Phase 8).
// Part A (v21) holds three cards: Theme, Sheet connection (the secret key, which used to live on its
// own small screen) and Error log. Categories, the gap threshold, export and the safeguards arrive in
// the next two releases. Like every screen file, it only draws and reacts to taps.

import { el, clear, section } from './dom.js';
import { getSetting, setSetting } from '../db.js';
import { formatLog } from '../errorlog.js';

const THEMES = [
  { value: 'auto', text: 'Follow phone' },
  { value: 'light', text: 'Light' },
  { value: 'dark', text: 'Dark' }
];

export async function openSettings(ctx, root) {
  clear(root);
  const theme = (await getSetting(ctx.db, 'theme')) || 'auto';
  const hasKey = !!(await getSetting(ctx.db, 'secret_key'));
  const log = (await getSetting(ctx.db, 'error_log')) || [];

  // ---- 1 Theme
  const themeMsg = el('div', { class: 'muted msg' });
  const themeRow = el('div', { class: 'btn-row' }, THEMES.map((t) =>
    el('button', {
      type: 'button',
      class: 'btn' + (t.value === theme ? ' btn-primary' : ''),
      'aria-pressed': t.value === theme ? 'true' : 'false',
      onclick: async () => {
        try {
          await setSetting(ctx.db, 'theme', t.value);
        } catch (err) {
          ctx.warn('Could not save the theme. Nothing was changed. Try again.');
          return;
        }
        await ctx.applyTheme();
        await openSettings(ctx, root);
      }
    }, t.text)
  ));

  // ---- 2 Sheet connection
  const keyMsg = el('div', { class: 'muted msg' });
  const keyInput = el('input', {
    type: 'password',
    class: 'input',
    autocomplete: 'off',
    autocapitalize: 'none',
    spellcheck: 'false',
    placeholder: hasKey ? 'A key is saved. Type a new one to replace it.' : 'Paste your secret key'
  });
  const keyBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => saveKey() }, 'Save key');

  async function saveKey() {
    const key = keyInput.value.trim();
    if (key === '') {
      keyMsg.textContent = 'Type or paste the key first.';
      return;
    }
    keyBtn.disabled = true;
    try {
      await setSetting(ctx.db, 'secret_key', key);
    } catch (err) {
      ctx.warn('Could not save the key. Nothing was changed. Try again.');
      keyBtn.disabled = false;
      return;
    }
    ctx.setSyncNote('Key saved. Tap Sync to send your blocks.');
    await ctx.show('home');
  }

  // ---- 3 Error log
  const logMsg = el('div', { class: 'muted msg' });
  const logText = formatLog(log, ctx.version, ctx.tzOffsetMin());
  const logBox = el('textarea', { class: 'input log-box', readonly: true, rows: '6', hidden: true });
  logBox.value = logText;
  const copyBtn = el('button', {
    type: 'button',
    class: 'btn',
    onclick: async () => {
      // The copy needs the phone's permission. If it is refused, the text is shown and selected,
      // so a long press can copy it by hand. Unproven in the installed app until tested (log, Phase 8).
      try {
        await navigator.clipboard.writeText(logText);
        logMsg.textContent = 'Copied. Paste it into your chat.';
        logBox.hidden = true;
      } catch (err) {
        logBox.hidden = false;
        logBox.focus();
        logBox.select();
        logMsg.textContent = 'The phone did not allow a copy. The text is selected below. Press and hold it, then tap Copy.';
      }
    }
  }, 'Copy log');

  root.append(
    el('div', { class: 'head page-head' }, [
      el('h2', { class: 'title', text: 'Settings' }),
      el('button', { type: 'button', class: 'btn btn-text', onclick: () => ctx.show('home') }, 'Back')
    ]),
    section(1, 'Theme', [
      el('p', { class: 'muted', text: 'Follow phone uses light or dark the way your phone is set.' }),
      themeRow,
      themeMsg
    ]),
    section(2, 'Sheet connection', [
      el('p', { class: 'muted', text: 'This is the key stored in your Apps Script under the name SECRET. It stays on this phone and is never shown again.' }),
      keyInput,
      keyMsg,
      el('div', { class: 'btn-row' }, [keyBtn])
    ]),
    section(3, 'Error log', [
      el('p', { class: 'muted', text: log.length === 0 ? 'Nothing has gone wrong. The last 50 problems would show up here.' : log.length + (log.length === 1 ? ' problem is' : ' problems are') + ' saved. Copy them to paste into a chat. The log never holds your key.' }),
      el('div', { class: 'btn-row' }, [copyBtn]),
      logBox,
      logMsg
    ])
  );
}
