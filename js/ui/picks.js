// picks.js: the category slider and the label field, built as parts so every activity line
// of the entry form can have its own. Phase 4 moved them here from entry.js, unchanged in look.

import { el, clear, catStyle } from './dom.js';
import { getCategories, addCategory } from '../db.js';
import { MAX_LABEL, normalizeLabel, labelKey, suggest } from '../labels.js';
import { chipOrder, nextColorSlot } from '../categories.js';

// shared: {categories, counts, labelRecords, pinnedId, pickers: []}
// One shared object per open form, so a category made in one line shows up in every line.
export function makeShared(categories, counts, labelRecords) {
  return { categories: categories, counts: counts, labelRecords: labelRecords, pinnedId: null, pickers: [] };
}

// A horizontal slider of category chips, "+ new" first, with the small name box under it.
// onChange runs whenever the selection changes. Typing in a label box never makes a category.
export function makeCategoryPicker(ctx, shared, onChange) {
  let selectedId = null;

  const chipsRow = el('div', { class: 'chips', role: 'group', 'aria-label': 'Category' });

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

  function render() {
    const keep = chipsRow.scrollLeft;
    clear(chipsRow);
    chipsRow.append(el('button', { type: 'button', class: 'chip chip-new', onclick: toggleNewBox }, '+ new'));
    for (const c of chipOrder(shared.categories, shared.counts, shared.pinnedId)) {
      chipsRow.append(
        el('button', {
          type: 'button',
          class: 'chip',
          style: catStyle(c.color),
          'aria-pressed': String(c.id === selectedId),
          onclick: () => picker.setId(c.id)
        }, [el('span', { class: 'dot' }), el('span', { class: 'name', text: c.name })])
      );
    }
    chipsRow.scrollLeft = keep;
  }

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
    if (shared.categories.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
      newMsg.textContent = 'A category with that name already exists.';
      return;
    }
    try {
      const made = await addCategory(ctx.db, name, nextColorSlot(shared.categories.length), ctx.nowEpoch());
      shared.categories = await getCategories(ctx.db);
      ctx.state.categories = shared.categories;
      shared.pinnedId = made.id;
      selectedId = made.id;
    } catch (err) {
      newMsg.textContent = 'Could not save the category. Nothing was changed.';
      return;
    }
    closeNewBox();
    chipsRow.scrollLeft = 0;
    for (const p of shared.pickers) p.render();
    chipsRow.scrollLeft = 0;
    onChange();
  }

  const picker = {
    node: el('div', {}, [chipsRow, newBox]),
    render: render,
    getId: () => selectedId,
    getCategory: () => shared.categories.find((c) => c.id === selectedId) || null,
    setId(id) {
      selectedId = id;
      render();
      onChange();
    }
  };
  shared.pickers.push(picker);
  render();
  return picker;
}

// The label box with its counter and suggestions. onEnter runs when Enter is pressed.
export function makeLabelField(shared, onEnter) {
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Label (optional)',
    autocomplete: 'off',
    autocorrect: 'off',
    'aria-label': 'Label'
  });
  const counter = el('span', { class: 'muted', text: '0/' + MAX_LABEL });
  const foot = el('div', { class: 'field-foot', hidden: true }, [counter]);
  // The suggestions float over the form instead of pushing it down (decided 11 Oct 2026).
  const sugBox = el('div', { class: 'suggest', hidden: true });

  // The counter only shows when the label is getting near the 60 character cap.
  function setCounter() {
    const n = Array.from(input.value).length;
    counter.textContent = n + '/' + MAX_LABEL;
    foot.hidden = n < 40;
  }

  function renderSuggestions() {
    clear(sugBox);
    const typed = input.value;
    const hits = suggest(shared.labelRecords, typed).filter((r) => r.key !== labelKey(typed));
    sugBox.hidden = hits.length === 0;
    for (const r of hits) {
      sugBox.append(
        el('button', {
          type: 'button',
          class: 'suggest-item',
          text: r.display,
          // Keeps the cursor in the box, so the tap is not lost to the box losing focus first.
          onpointerdown: (e) => e.preventDefault(),
          onclick: () => {
            input.value = r.display;
            setCounter();
            clear(sugBox);
            sugBox.hidden = true;
          }
        })
      );
    }
  }

  input.addEventListener('input', () => {
    const chars = Array.from(input.value);
    if (chars.length > MAX_LABEL) input.value = chars.slice(0, MAX_LABEL).join('');
    setCounter();
    renderSuggestions();
  });

  input.addEventListener('blur', () => {
    sugBox.hidden = true;
  });
  input.addEventListener('focus', () => renderSuggestions());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && onEnter) onEnter();
  });

  return {
    node: el('div', { class: 'label-field' }, [input, foot, sugBox]),
    getValue: () => normalizeLabel(input.value),
    setValue(text) {
      input.value = text;
      setCounter();
      clear(sugBox);
      sugBox.hidden = true;
    }
  };
}
