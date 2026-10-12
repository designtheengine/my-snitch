// lines.js: the activity lines of an entry form, with the split controls.
// Late mode and the End screen both use it, so a block can be split into several
// activities at the moment you log it or end it (decided 11 Oct 2026).
//
// One line is bare: a category slider and a label. Two or more lines each sit in a card
// with a share slider and live minutes. The split math lives in model.js.
//
// opts.getDuration(): the block's length in seconds, or null when it is not known yet
// opts.onChange():    runs after anything the person changes. The caller then calls refresh().
// opts.onMessage(t):  shows a short message under the form

import { el, binButton } from './dom.js';
import { moveSlider, addLine, removeLine, maxShare, displayMinutes } from '../model.js';
import { makeCategoryPicker, makeLabelField } from './picks.js';

export function makeLines(ctx, shared, opts) {
  const lines = [];
  let shares = [100];

  const node = el('div', { class: 'lines' });
  const splitBtn = el('button', { type: 'button', class: 'btn btn-wide', onclick: () => addSplitLine() }, 'Split into several activities');

  function makeLine() {
    const line = {};
    line.heading = el('div', { class: 'line-title' });
    line.removeBtn = binButton('Remove this activity', () => removeAt(lines.indexOf(line)));
    line.shareText = el('span', { class: 'share-text' });
    line.headRow = el('div', { class: 'line-head', hidden: true }, [line.heading, line.shareText, line.removeBtn]);
    line.picker = makeCategoryPicker(ctx, shared, () => opts.onChange());
    line.label = makeLabelField(shared, null);
    line.slider = el('input', { type: 'range', min: '1', max: '100', step: '1', value: '100', 'aria-label': 'Share of the block' });
    line.sliderRow = el('div', { class: 'slider-row', hidden: true }, [line.slider]);
    line.slider.addEventListener('input', () => {
      shares = moveSlider(shares, lines.indexOf(line), Number(line.slider.value));
      opts.onChange();
    });
    line.node = el('div', { class: 'line' }, [
      line.headRow,
      line.picker.node,
      line.label.node,
      line.sliderRow
    ]);
    return line;
  }

  // Draws the headings, sliders and minutes. The live minutes always add up to the block's minutes.
  function refresh() {
    const split = lines.length > 1;
    node.classList.toggle('split', split);
    splitBtn.textContent = split ? 'Add another line' : 'Split into several activities';
    const duration = opts.getDuration();
    const mins = duration !== null && duration > 0 ? displayMinutes(duration, shares) : null;
    lines.forEach((l, i) => {
      l.heading.textContent = 'Activity ' + (i + 1);
      l.headRow.hidden = !split;
      l.sliderRow.hidden = !split;
      l.slider.max = String(maxShare(lines.length)); // the limit first, so the value is never cut short
      l.slider.value = String(shares[i]);
      l.shareText.textContent = shares[i] + '%' + (mins ? ' · ' + mins[i] + ' min' : '');
    });
  }

  function addSplitLine() {
    try {
      shares = addLine(shares);
    } catch (err) {
      opts.onMessage('That is as many lines as a block can hold.');
      return;
    }
    const line = makeLine();
    lines.push(line);
    node.append(line.node);
    opts.onChange();
  }

  function removeAt(index) {
    if (lines.length <= 1 || index < 0) return;
    shares = removeLine(shares, index);
    const gone = lines.splice(index, 1)[0];
    shared.pickers = shared.pickers.filter((p) => p !== gone.picker);
    gone.node.remove();
    opts.onChange();
  }

  const first = makeLine();
  lines.push(first);
  node.append(first.node);
  refresh();

  return {
    node: node,
    splitBtn: splitBtn,
    refresh: refresh,
    // True when every line has a category.
    ready: () => lines.every((l) => l.picker.getId() !== null),
    // The lines to save: [{category, label, share_pct}]. Only call when ready() is true.
    getLines: () => lines.map((l, i) => ({ category: l.picker.getCategory().name, label: l.label.getValue(), share_pct: shares[i] })),
    // Fills line 1 from a saved line, by category name. An archived or missing category is skipped.
    prefill(categoryName, labelText) {
      const found = shared.categories.find((c) => !c.archived && c.name.toLowerCase() === String(categoryName).toLowerCase());
      first.label.setValue(labelText || '');
      if (found) first.picker.setId(found.id);
    }
  };
}
