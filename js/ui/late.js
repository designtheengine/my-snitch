// late.js: late mode of the entry form (PRD section 5.2, build plan Phase 4).
// Logs time you forgot to log. The start comes from a chip or the exact picker, the end is
// now unless you set it, and a block can be split into several activity lines.
// The rules (overlap, fill around, split math) live in model.js. This file only draws and reacts.
//
// data: {shared, blocks, running, gap}
//   gap is {start, end, toNow} when the gap banner opened the form, or null.

import { el, clear } from './dom.js';
import { saveBlocks, getAllBlocks } from '../db.js';
import {
  createBlock, planLateSave, lastEndedBlock, moveSlider, addLine, removeLine, maxShare, displayMinutes
} from '../model.js';
import { formatDuration, formatClock12, localDate, minutesAgo } from '../time.js';
import { makeCategoryPicker, makeLabelField } from './picks.js';
import { makeTimePicker } from './timepick.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function openLate(ctx, root, data) {
  const shared = data.shared;
  const gap = data.gap;
  const tz = ctx.tzOffsetMin();
  const last = lastEndedBlock(data.blocks);

  // What the form remembers while it is open.
  let startSpec = null; // {kind: 'ago', min} or {kind: 'since'} or {kind: 'exact'}
  let endSpec = { kind: 'now' }; // {kind: 'now'} or {kind: 'exact'}
  let shares = [100];
  let pending = null; // a plan waiting for the person to confirm it
  let busy = false;
  const lines = [];

  // ------------------------------------------------------------ small helpers

  function clock(epoch) {
    return formatClock12(epoch, tz);
  }

  function dayPrefix(epoch, now) {
    if (localDate(epoch, tz) === localDate(now, tz)) return '';
    const parts = localDate(epoch, tz).split('-').map(Number);
    return parts[2] + ' ' + MONTHS[parts[1] - 1] + ', ';
  }

  // "office work, credit policy deck" or just "office work".
  function nameOf(block) {
    const first = block.lines[0];
    const cats = block.lines.map((l) => l.category).join(' / ');
    return first.label ? cats + ', ' + first.label : cats;
  }

  function rangeOf(block, now) {
    return dayPrefix(block.start_epoch, now) + clock(block.start_epoch) + ' to ' + (block.end_epoch === null ? 'now' : clock(block.end_epoch));
  }

  // ------------------------------------------------------------ start and end

  const startPicker = makeTimePicker(ctx, 'Start', () => onFormChange());
  const endPicker = makeTimePicker(ctx, 'End', () => onFormChange());
  startPicker.node.hidden = true;
  endPicker.node.hidden = true;

  function resolveStart(now) {
    if (!startSpec) return null;
    if (startSpec.kind === 'ago') return minutesAgo(now, startSpec.min);
    if (startSpec.kind === 'since') return last ? last.end_epoch : null;
    return startPicker.getEpoch();
  }

  function resolveEnd(now) {
    return endSpec.kind === 'now' ? now : endPicker.getEpoch();
  }

  // Says what the chosen times mean, and whether they can be saved.
  function describeTimes() {
    const now = ctx.nowEpoch();
    const s = resolveStart(now);
    if (s === null) return { ok: false, text: 'Choose when it started.' };
    const e = resolveEnd(now);
    if (e <= s) return { ok: false, text: 'The end must be after the start.' };
    if (e > now) return { ok: false, text: 'That end time is in the future.' };
    const endText = endSpec.kind === 'now' ? 'now' : clock(e);
    return { ok: true, text: dayPrefix(s, now) + clock(s) + ' to ' + endText + ' · ' + formatDuration(e - s), start: s, end: e };
  }

  const startRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Start' });
  const endRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'End' });

  function sameSpec(a, b) {
    return a && a.kind === b.kind && (b.kind !== 'ago' || a.min === b.min);
  }

  function timeChip(text, selected, disabled, onclick) {
    return el('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected), disabled: disabled, onclick: onclick }, text);
  }

  function renderStartChips() {
    clear(startRow);
    const options = [
      { text: '15 min ago', spec: { kind: 'ago', min: 15 } },
      { text: '30 min ago', spec: { kind: 'ago', min: 30 } },
      { text: '1 hour ago', spec: { kind: 'ago', min: 60 } },
      { text: 'Since last entry', spec: { kind: 'since' }, disabled: !last },
      { text: 'Exact time', spec: { kind: 'exact' } }
    ];
    for (const o of options) {
      startRow.append(timeChip(o.text, sameSpec(startSpec, o.spec), !!o.disabled, () => chooseStart(o.spec)));
    }
    startPicker.node.hidden = !(startSpec && startSpec.kind === 'exact');
  }

  function renderEndChips() {
    clear(endRow);
    endRow.append(
      timeChip('Now', endSpec.kind === 'now', false, () => chooseEnd({ kind: 'now' })),
      timeChip('Exact time', endSpec.kind === 'exact', false, () => chooseEnd({ kind: 'exact' }))
    );
    endPicker.node.hidden = endSpec.kind !== 'exact';
  }

  function chooseStart(spec) {
    // Opening the exact picker starts from whatever the chips meant a moment ago.
    if (spec.kind === 'exact' && !(startSpec && startSpec.kind === 'exact')) {
      const now = ctx.nowEpoch();
      const current = resolveStart(now);
      startPicker.setEpoch(current !== null ? current : now);
    }
    startSpec = spec;
    renderStartChips();
    onFormChange();
  }

  function chooseEnd(spec) {
    if (spec.kind === 'exact' && endSpec.kind !== 'exact') endPicker.setEpoch(ctx.nowEpoch());
    endSpec = spec;
    renderEndChips();
    onFormChange();
  }

  const summary = el('div', { class: 'card summary' });

  function updateSummary() {
    const d = describeTimes();
    summary.textContent = d.text;
    summary.classList.toggle('summary-bad', !d.ok && startSpec !== null);
  }

  // ------------------------------------------------------------ activity lines and split

  const linesBox = el('div', { class: 'lines' });
  const splitBtn = el('button', { type: 'button', class: 'btn btn-wide', onclick: () => addSplitLine() }, 'Split into several activities');

  function makeLine() {
    const line = {};
    line.heading = el('div', { class: 'line-title' });
    line.removeBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => removeAt(lines.indexOf(line)) }, 'Remove');
    line.headRow = el('div', { class: 'line-head', hidden: true }, [line.heading, line.removeBtn]);
    line.picker = makeCategoryPicker(ctx, shared, () => onFormChange());
    line.label = makeLabelField(shared, null);
    line.slider = el('input', { type: 'range', min: '1', max: '100', step: '1', value: '100', 'aria-label': 'Share of the block' });
    line.shareText = el('span', { class: 'share-text' });
    line.sliderRow = el('div', { class: 'slider-row', hidden: true }, [line.slider, line.shareText]);
    line.slider.addEventListener('input', () => {
      shares = moveSlider(shares, lines.indexOf(line), Number(line.slider.value));
      onFormChange();
    });
    line.node = el('div', { class: 'line' }, [
      line.headRow,
      el('div', { class: 'section-label', text: 'Category' }),
      line.picker.node,
      el('div', { class: 'section-label', text: 'Label' }),
      line.label.node,
      line.sliderRow
    ]);
    return line;
  }

  // Draws the headings, sliders and minutes. The live minutes always add up to the block's minutes.
  function refreshLines() {
    const split = lines.length > 1;
    linesBox.classList.toggle('split', split);
    splitBtn.textContent = split ? 'Add another line' : 'Split into several activities';
    const d = describeTimes();
    const mins = d.ok ? displayMinutes(d.end - d.start, shares) : null;
    lines.forEach((l, i) => {
      l.heading.textContent = 'Line ' + (i + 1);
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
      setMsg('That is as many lines as a block can hold.');
      return;
    }
    const line = makeLine();
    lines.push(line);
    linesBox.append(line.node);
    onFormChange();
  }

  function removeAt(index) {
    if (lines.length <= 1 || index < 0) return;
    shares = removeLine(shares, index);
    const gone = lines.splice(index, 1)[0];
    shared.pickers = shared.pickers.filter((p) => p !== gone.picker);
    gone.node.remove();
    onFormChange();
  }

  // ------------------------------------------------------------ quick fill

  const sameBtn = el('button', { type: 'button', class: 'chip', disabled: !last, onclick: () => fillSameAsBefore() }, 'Same as before');
  const sameNote = el('div', {
    class: 'muted',
    text: last ? nameOf({ lines: [last.lines[0]] }) : 'Nothing is logged before this yet.'
  });

  // Fills line 1 with the category and label of the last block.
  function fillSameAsBefore() {
    if (!last) return;
    const first = last.lines[0];
    const found = shared.categories.find((c) => !c.archived && c.name.toLowerCase() === first.category.toLowerCase());
    lines[0].label.setValue(first.label);
    if (found) lines[0].picker.setId(found.id);
    else onFormChange();
  }

  // ------------------------------------------------------------ messages and confirmation

  const msg = el('p', { class: 'muted msg form-msg' });
  const confirmBox = el('div', { class: 'card confirm', hidden: true });

  function setMsg(text) {
    msg.textContent = text;
  }

  function closeConfirm() {
    pending = null;
    confirmBox.hidden = true;
    clear(confirmBox);
  }

  function showConfirm(plan, now) {
    pending = plan;
    clear(confirmBox);
    confirmBox.hidden = false;
    confirmBox.append(el('div', { class: 'confirm-title', text: 'This overlaps what you already logged' }));
    for (const b of plan.swallowed) {
      confirmBox.append(el('p', { text: nameOf(b) + ' (' + rangeOf(b, now) + ') is covered by your entry. It stays exactly as it is.' }));
    }
    for (const t of plan.trims) {
      const what = nameOf(t.older) + ' (' + rangeOf(t.older, now) + ')';
      if (t.kind === 'starts-inside') confirmBox.append(el('p', { text: what + ' will be shortened to end at ' + clock(t.trimmed.end_epoch) + '.' }));
      else confirmBox.append(el('p', { text: what + ' will start at ' + clock(t.trimmed.start_epoch) + ' instead.' }));
    }
    const parts = plan.newBlocks.map((b) => clock(b.start_epoch) + ' to ' + clock(b.end_epoch));
    confirmBox.append(
      el('p', { text: 'Your entry is saved as ' + (parts.length === 1 ? 'one block: ' : parts.length + ' blocks: ') + parts.join(', ') + '.' }),
      el('div', { class: 'btn-row' }, [
        el('button', { type: 'button', class: 'btn', onclick: () => { closeConfirm(); updateSave(); } }, 'Go back'),
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => commit(plan) }, 'Confirm and save')
      ])
    );
  }

  function refusalText(block, now) {
    if (block.end_epoch === null) {
      return 'That time falls inside what is running now (' + nameOf(block) + ', since ' + clock(block.start_epoch) + '). Stop it first, or pick an earlier end.';
    }
    return 'That time sits inside ' + nameOf(block) + ' (' + rangeOf(block, now) + '). Pick different times.';
  }

  // ------------------------------------------------------------ saving

  const saveBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: () => save() }, 'Save');

  function updateSave() {
    const everyCategory = lines.every((l) => l.picker.getId() !== null);
    saveBtn.disabled = busy || pending !== null || !everyCategory || !describeTimes().ok;
  }

  // Called after anything the person changes. A plan waiting for confirmation no longer fits.
  function onFormChange() {
    if (pending) closeConfirm();
    setMsg('');
    updateSummary();
    refreshLines();
    updateSave();
  }

  function setBusy(value) {
    busy = value;
    updateSave();
  }

  async function save() {
    if (busy) return;
    const now = ctx.nowEpoch();
    const d = describeTimes();
    if (!d.ok) {
      setMsg(d.text);
      return;
    }
    setBusy(true);
    try {
      const lineData = lines.map((l, i) => ({ category: l.picker.getCategory().name, label: l.label.getValue(), share_pct: shares[i] }));
      // Read every block again, so a stale screen can never save over a change made meanwhile.
      const fresh = await getAllBlocks(ctx.db);
      const candidate = createBlock({
        block_id: ctx.newId(),
        start_epoch: d.start,
        end_epoch: d.end,
        tz_offset_min: tz,
        day: ctx.dayFor(d.start),
        lines: lineData,
        entry_mode: 'late',
        now: now
      });
      const plan = planLateSave(candidate, fresh, now, { makeId: () => ctx.newId(), dayFor: (epoch) => ctx.dayFor(epoch) });
      if (plan.refused) {
        setMsg(refusalText(plan.refused, now));
        setBusy(false);
        return;
      }
      if (plan.newBlocks.length === 0) {
        setMsg('Everything between those times is already logged.');
        setBusy(false);
        return;
      }
      if (plan.trims.length > 0 || plan.swallowed.length > 0) {
        showConfirm(plan, now);
        setBusy(false);
        return;
      }
      await commit(plan);
    } catch (err) {
      ctx.warn('Could not save. Nothing was changed. Try again.');
      setBusy(false);
    }
  }

  // Saves the trimmed older blocks and the new blocks in one step: all of it, or none of it.
  async function commit(plan) {
    busy = true;
    saveBtn.disabled = true;
    try {
      const items = plan.trims
        .map((t) => ({ block: t.trimmed, bumpLabels: false }))
        .concat(plan.newBlocks.map((b) => ({ block: b })));
      await saveBlocks(ctx.db, items, { now: ctx.nowEpoch() });
    } catch (err) {
      ctx.warn('Could not save. Nothing was changed. Try again.');
      busy = false;
      closeConfirm();
      updateSave();
      return;
    }
    await ctx.show('home');
  }

  // ------------------------------------------------------------ opening state and layout

  const first = makeLine();
  lines.push(first);
  linesBox.append(first.node);

  // The gap banner opens the form with the gap filled in. The end stays "now" when the gap runs up to now.
  if (gap) {
    startSpec = { kind: 'exact' };
    startPicker.setEpoch(gap.start);
    if (!gap.toNow) {
      endSpec = { kind: 'exact' };
      endPicker.setEpoch(gap.end);
    }
  }

  renderStartChips();
  renderEndChips();
  updateSummary();
  refreshLines();
  updateSave();

  root.append(
    el('div', { class: 'head' }, [el('h2', { class: 'title', text: 'Missed something' })]),
    el('div', { class: 'section-label', text: 'Started' }),
    startRow,
    startPicker.node,
    el('div', { class: 'section-label', text: 'Ended' }),
    endRow,
    endPicker.node,
    summary,
    el('div', { class: 'section-label', text: 'What you did' }),
    el('div', { class: 'chip-row' }, [sameBtn]),
    sameNote,
    linesBox,
    el('div', { class: 'spacer' }),
    splitBtn,
    msg,
    confirmBox,
    el('div', { class: 'spacer' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      saveBtn
    ])
  );
}
