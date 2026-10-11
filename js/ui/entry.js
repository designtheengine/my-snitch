// entry.js: the entry form (PRD section 5.2). One form for every entry task.
// Phase 3 builds the start and switch mode. Late and edit modes come later.
// Check-in has no mode of its own: it folds into late mode (decided 11 Oct 2026, log Q8).

import { el, clear, catStyle } from './dom.js';
import { getCategories, getAllBlocks, getAllLabels, getRunningBlock, addCategory, applySwitch } from '../db.js';
import { switchBlock } from '../model.js';
import { MAX_LABEL, normalizeLabel, labelKey, suggest } from '../labels.js';
import { usageCounts, chipOrder, nextColorSlot } from '../categories.js';

export async function openEntry(ctx, mode) {
  const root = ctx.panels.entry;
  clear(root);

  let categories, blocks, labelRecords, running;
  try {
    [categories, blocks, labelRecords, running] = await Promise.all([
      getCategories(ctx.db),
      getAllBlocks(ctx.db),
      getAllLabels(ctx.db),
      getRunningBlock(ctx.db)
    ]);
  } catch (err) {
    ctx.warn('Could not read your saved data. Close the app and open it again.');
    await ctx.show('home');
    return;
  }

  // What the form remembers while it is open.
  const f = {
    categories: categories,
    counts: usageCounts(blocks),
    labelRecords: labelRecords,
    selectedId: null,
    pinnedId: null
  };

  // ------------------------------------------------------------ category slider

  const chipsRow = el('div', { class: 'chips', role: 'group', 'aria-label': 'Category' });

  function renderChips() {
    const keep = chipsRow.scrollLeft;
    clear(chipsRow);
    chipsRow.append(el('button', { type: 'button', class: 'chip chip-new', onclick: toggleNewBox }, '+ new'));
    for (const c of chipOrder(f.categories, f.counts, f.pinnedId)) {
      chipsRow.append(
        el('button', {
          type: 'button',
          class: 'chip',
          style: catStyle(c.color),
          'aria-pressed': String(c.id === f.selectedId),
          onclick: () => {
            f.selectedId = c.id;
            renderChips();
            updateStart();
          }
        }, [el('span', { class: 'dot' }), el('span', { class: 'name', text: c.name })])
      );
    }
    chipsRow.scrollLeft = keep;
  }

  // "+ new" opens a small name box. Typing in the label box never makes a category.
  const nameInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'New category name',
    autocomplete: 'off',
    'aria-label': 'New category name'
  });
  const newMsg = el('p', { class: 'muted msg' });
  const newBox = el('div', { class: 'newbox', hidden: true }, [
    nameInput,
    newMsg,
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => closeNewBox() }, 'Cancel'),
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => addNewCategory() }, 'Add')
    ])
  ]);

  function toggleNewBox() {
    if (newBox.hidden) {
      newBox.hidden = false;
      nameInput.focus();
    } else {
      closeNewBox();
    }
  }

  function closeNewBox() {
    newBox.hidden = true;
    nameInput.value = '';
    newMsg.textContent = '';
  }

  async function addNewCategory() {
    const name = nameInput.value.trim();
    if (!name) {
      newMsg.textContent = 'Type a name first.';
      return;
    }
    if (f.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      newMsg.textContent = 'A category with that name already exists.';
      return;
    }
    try {
      const made = await addCategory(ctx.db, name, nextColorSlot(f.categories.length), ctx.nowEpoch());
      f.categories = await getCategories(ctx.db);
      ctx.state.categories = f.categories;
      f.pinnedId = made.id;
      f.selectedId = made.id;
    } catch (err) {
      newMsg.textContent = 'Could not save the category. Nothing was changed.';
      return;
    }
    closeNewBox();
    chipsRow.scrollLeft = 0;
    renderChips();
    chipsRow.scrollLeft = 0;
    updateStart();
  }

  // ------------------------------------------------------------ label with suggestions

  const labelInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Label (optional)',
    autocomplete: 'off',
    autocorrect: 'off',
    'aria-label': 'Label'
  });
  const counter = el('span', { class: 'muted', text: '0/' + MAX_LABEL });
  const sugBox = el('div', { class: 'suggest', hidden: true });

  function renderSuggestions() {
    clear(sugBox);
    const typed = labelInput.value;
    const hits = suggest(f.labelRecords, typed).filter((r) => r.key !== labelKey(typed));
    sugBox.hidden = hits.length === 0;
    for (const r of hits) {
      sugBox.append(
        el('button', {
          type: 'button',
          class: 'suggest-item',
          text: r.display,
          onclick: () => {
            labelInput.value = r.display;
            counter.textContent = Array.from(r.display).length + '/' + MAX_LABEL;
            renderSuggestions();
          }
        })
      );
    }
  }

  labelInput.addEventListener('input', () => {
    const chars = Array.from(labelInput.value);
    if (chars.length > MAX_LABEL) labelInput.value = chars.slice(0, MAX_LABEL).join('');
    counter.textContent = Array.from(labelInput.value).length + '/' + MAX_LABEL;
    renderSuggestions();
  });

  labelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !startBtn.disabled) startNow();
  });

  // ------------------------------------------------------------ start or switch

  const startBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true }, running ? 'Switch' : 'Start');
  startBtn.addEventListener('click', () => startNow());

  function updateStart() {
    startBtn.disabled = f.selectedId === null;
  }

  async function startNow() {
    const chosen = f.categories.find((c) => c.id === f.selectedId);
    if (!chosen) return;
    startBtn.disabled = true;
    try {
      const now = ctx.nowEpoch();
      // Read the running block again, so a stale screen can never leave two running.
      const current = await getRunningBlock(ctx.db);
      const lines = [{ category: chosen.name, label: normalizeLabel(labelInput.value), share_pct: 100 }];
      const made = switchBlock(
        current || null,
        { block_id: ctx.newId(), tz_offset_min: ctx.tzOffsetMin(), day: ctx.dayFor(now), lines: lines },
        now
      );
      await applySwitch(ctx.db, made.previous, made.next, { now: now });
    } catch (err) {
      ctx.warn('Could not save. Nothing was changed. Try again.');
      updateStart();
      return;
    }
    await ctx.show('home');
  }

  // ------------------------------------------------------------ layout

  const subtitle = running
    ? el('p', { class: 'muted', text: 'This stops ' + running.lines.map((l) => l.category).join(' / ') + ' at the same moment.' })
    : null;

  renderChips();
  updateStart();

  root.append(
    el('div', { class: 'head' }, [el('h2', { class: 'title', text: running ? 'Switch to' : 'Start' })]),
    // append() prints a null as the word "null", so an empty subtitle is left out of the list.
    ...(subtitle ? [subtitle] : []),
    el('div', { class: 'section-label', text: 'Category' }),
    chipsRow,
    newBox,
    el('div', { class: 'section-label', text: 'Label' }),
    labelInput,
    el('div', { class: 'field-foot' }, [el('span'), counter]),
    sugBox,
    el('div', { class: 'spacer' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      startBtn
    ])
  );
}
