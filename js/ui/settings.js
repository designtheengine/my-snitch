// settings.js: the Settings view (PRD section 5.5, Phase 8).
// v21 built Theme, Sheet connection (the secret key, which used to live on its own small screen) and
// Error log. v22 adds Categories and Gap threshold. Export and the safeguards arrive in the next release.
// Like every screen file, it only draws and reacts to taps. The rules are in categories.js.

import { el, clear, section } from './dom.js';
import { getSetting, setSetting, getCategories, addCategory, updateCategory } from '../db.js';
import { formatLog } from '../errorlog.js';
import { catStyle } from './dom.js';
import { nextColorSlot, isLocked, checkName, renameChanges } from '../categories.js';

const THEMES = [
  { value: 'auto', text: 'Follow phone' },
  { value: 'light', text: 'Light' },
  { value: 'dark', text: 'Dark' }
];

const GAP_CHOICES = [5, 10, 15, 30];

// openSettings starts the screen with every editor closed. After any change the screen draws itself
// again with the same ui object, so an editor you opened stays open until you save or cancel.
export async function openSettings(ctx, root) {
  await draw(ctx, root, { editing: null, adding: false, color: 1, msg: '' });
}

async function draw(ctx, root, ui) {
  clear(root);
  const again = () => draw(ctx, root, ui);
  const categories = await getCategories(ctx.db);
  const gap = await getSetting(ctx.db, 'gap_threshold_min');
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
        await again();
      }
    }, t.text)
  ));

  // ---- 2 Categories
  const active = categories.filter((c) => !c.archived);
  const archived = categories.filter((c) => c.archived);
  const catMsg = el('div', { class: 'muted msg', text: ui.msg });

  function swatches() {
    return el('div', { class: 'swatch-row' }, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      el('button', {
        type: 'button',
        class: 'swatch',
        style: catStyle(n),
        'aria-label': 'Colour ' + n,
        'aria-pressed': ui.color === n ? 'true' : 'false',
        onclick: () => {
          ui.color = n;
          again();
        }
      })
    ));
  }

  // The editor opens under the row you tapped. nameBox keeps what you typed while the colour changes.
  function editor(c) {
    const locked = isLocked(c);
    const nameBox = el('input', { type: 'text', class: 'input', value: c.name, autocomplete: 'off', disabled: locked });
    if (ui.draftName !== undefined) nameBox.value = ui.draftName;
    nameBox.addEventListener('input', () => { ui.draftName = nameBox.value; });
    const save = async () => {
      const fresh = await getCategories(ctx.db);
      const err = locked ? null : checkName(fresh, nameBox.value, c.id);
      if (err) { ui.msg = err; await again(); return; }
      const changes = Object.assign({}, locked ? {} : renameChanges(c, nameBox.value), ui.color !== c.color ? { color: ui.color } : {});
      try {
        if (Object.keys(changes).length > 0) await updateCategory(ctx.db, c.id, changes);
      } catch (e) {
        ctx.warn('Could not save the category. Nothing was changed. Try again.');
        return;
      }
      ui.editing = null; ui.draftName = undefined; ui.msg = '';
      await again();
    };
    const archive = async () => {
      try {
        await updateCategory(ctx.db, c.id, { archived: true });
      } catch (e) {
        ctx.warn('Could not archive the category. Nothing was changed. Try again.');
        return;
      }
      ui.editing = null; ui.draftName = undefined; ui.msg = '';
      await again();
    };
    return el('div', { class: 'cat-editor' }, [
      ...(locked ? [el('p', { class: 'muted', text: 'The app relies on this name, so only the colour can change.' })] : []),
      nameBox,
      swatches(),
      el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn btn-primary', onclick: save }, 'Save'),
        ...(locked ? [] : [el('button', { type: 'button', class: 'btn', onclick: archive }, 'Archive')]),
        el('button', { type: 'button', class: 'btn btn-text', onclick: () => { ui.editing = null; ui.draftName = undefined; ui.msg = ''; again(); } }, 'Cancel')
      ])
    ]);
  }

  function catRow(c) {
    return el('li', { class: 'cat-item' }, [
      el('button', {
        type: 'button',
        class: 'cat-row',
        onclick: () => { ui.editing = ui.editing === c.id ? null : c.id; ui.color = c.color; ui.draftName = undefined; ui.msg = ''; again(); }
      }, [el('span', { class: 'dot', style: catStyle(c.color) }), el('span', { class: 'cat-name', text: c.name }), el('span', { class: 'muted', text: isLocked(c) ? 'name fixed' : 'edit' })]),
      ...(ui.editing === c.id ? [editor(c)] : [])
    ]);
  }

  const addBox = el('input', { type: 'text', class: 'input', placeholder: 'New category name', autocomplete: 'off' });
  const addArea = ui.adding
    ? el('div', { class: 'cat-editor' }, [
        addBox,
        swatches(),
        el('div', { class: 'btn-row' }, [
          el('button', {
            type: 'button',
            class: 'btn btn-primary',
            onclick: async () => {
              const fresh = await getCategories(ctx.db);
              const err = checkName(fresh, addBox.value, null);
              if (err) { ui.msg = err; await again(); return; }
              try {
                await addCategory(ctx.db, addBox.value, ui.color, ctx.nowEpoch());
              } catch (e) {
                ctx.warn('Could not add the category. Nothing was changed. Try again.');
                return;
              }
              ui.adding = false; ui.msg = '';
              await again();
            }
          }, 'Add'),
          el('button', { type: 'button', class: 'btn btn-text', onclick: () => { ui.adding = false; ui.msg = ''; again(); } }, 'Cancel')
        ])
      ])
    : el('button', { type: 'button', class: 'btn btn-wide', onclick: () => { ui.adding = true; ui.editing = null; ui.color = nextColorSlot(categories.length); ui.msg = ''; again(); } }, 'Add a category');

  const restoreRows = archived.map((c) =>
    el('li', { class: 'cat-item' }, [
      el('div', { class: 'cat-row' }, [
        el('span', { class: 'dot', style: catStyle(c.color) }),
        el('span', { class: 'cat-name', text: c.name }),
        el('button', {
          type: 'button',
          class: 'btn btn-small',
          onclick: async () => {
            try {
              await updateCategory(ctx.db, c.id, { archived: false });
            } catch (e) {
              ctx.warn('Could not restore the category. Nothing was changed. Try again.');
              return;
            }
            await again();
          }
        }, 'Restore')
      ])
    ])
  );

  // ---- 3 Gap threshold
  const gapRow = el('div', { class: 'btn-row' }, GAP_CHOICES.map((n) =>
    el('button', {
      type: 'button',
      class: 'btn' + (n === gap ? ' btn-primary' : ''),
      'aria-pressed': n === gap ? 'true' : 'false',
      onclick: async () => {
        try {
          await setSetting(ctx.db, 'gap_threshold_min', n);
        } catch (e) {
          ctx.warn('Could not save the gap length. Nothing was changed. Try again.');
          return;
        }
        await again();
      }
    }, n + ' min')
  ));

  // ---- 4 Sheet connection
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

  // ---- 5 Error log
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
    section(2, 'Categories', [
      el('p', { class: 'muted', text: 'Tap a category to rename it, change its colour or archive it. Old blocks keep the name they were logged with.' }),
      el('ul', { class: 'cat-list' }, active.map(catRow)),
      catMsg,
      addArea,
      ...(archived.length > 0 ? [el('div', { class: 'section-label', text: 'Archived' }), el('ul', { class: 'cat-list' }, restoreRows)] : [])
    ]),
    section(3, 'Gap threshold', [
      el('p', { class: 'muted', text: 'The gap banner on Home shows only for holes at least this long.' }),
      gapRow
    ]),
    section(4, 'Sheet connection', [
      el('p', { class: 'muted', text: 'This is the key stored in your Apps Script under the name SECRET. It stays on this phone and is never shown again.' }),
      keyInput,
      keyMsg,
      el('div', { class: 'btn-row' }, [keyBtn])
    ]),
    section(5, 'Error log', [
      el('p', { class: 'muted', text: log.length === 0 ? 'Nothing has gone wrong. The last 50 problems would show up here.' : log.length + (log.length === 1 ? ' problem is' : ' problems are') + ' saved. Copy them to paste into a chat. The log never holds your key.' }),
      el('div', { class: 'btn-row' }, [copyBtn]),
      logBox,
      logMsg
    ])
  );
}
