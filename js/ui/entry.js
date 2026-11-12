// entry.js: the entry form (PRD section 5.2). One form for every entry task.
// It loads what every mode needs, then builds the mode asked for.
//   start:  starts a block now, or switches (this file). Built in Phase 3.
//   change: changes the category and label of the running block, the timer keeps counting (this file).
//   end:    the End screen that Stop and Switch open, with split (end.js).
//   late:   logs time you forgot to log (late.js).
//   edit:   changes a saved block (late.js), or opens the sleep check for a block of a night. Phase 7.
// Check-in has no mode of its own: it folds into late mode (decided 11 Oct 2026, log Q8).
//
// openEntry(ctx, arg): arg is a mode name such as 'start' or 'late', or an object:
//   {mode: 'late', gap: {start, end, toNow}}       the gap banner opens late mode with a gap filled in
//   {mode: 'catchup', gap}                          the gap banner after a silence over 14 hours (catchup.js)
//   {mode: 'end', next: 'stop' or 'switch'}        the End screen
//   {mode: 'start', ending: {end, lines, changed}} the start form after the End screen, for a switch
//   {mode: 'edit', blockId, back}                  a saved block from Home or History. back is 'home' or 'history'.

import { el, clear, section, backButton } from './dom.js';
import { getCategories, getAllBlocks, getAllLabels, getAllSleep, getRunningBlock, applySwitch, saveBlock } from '../db.js';
import { switchBlock, editBlock, checkBackdatedStart, startBlockAt, lastEndedBlock, MAX_BACKDATE_SEC } from '../model.js';
import { usageCounts, categoryByName } from '../categories.js';
import { formatClock12, localDate, minutesAgo } from '../time.js';
import { makeShared, makeCategoryPicker, makeLabelField } from './picks.js';
import { makeTimePicker } from './timepick.js';
import { openLate } from './late.js';
import { openEnd } from './end.js';
import { openCatchup } from './catchup.js';

export async function openEntry(ctx, arg) {
  const opts = typeof arg === 'string' || !arg ? { mode: arg || 'start' } : arg;
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

  const shared = makeShared(categories, usageCounts(blocks), labelRecords);
  running = running || null;

  if (opts.mode === 'edit') {
    const back = opts.back === 'history' ? 'history' : 'home';
    const target = blocks.find((b) => b.block_id === opts.blockId);
    if (!target || target.is_deleted || target.running === 1) {
      await ctx.show(back);
      return;
    }
    // The blocks of a night are drawn from one night record, so they are edited together in the sleep check,
    // which redraws both (spec section 6.8).
    if (target.entry_mode === 'sleep') {
      const nights = await getAllSleep(ctx.db);
      const night = nights.find((n) => n.bed_block_id === target.block_id || n.sleep_block_id === target.block_id);
      if (night && night.wake_epoch !== null) {
        await ctx.show('sleep', { nightId: night.night_id, back: back });
        return;
      }
      ctx.warn('That block belongs to a night that is still open. Tap Woke up first.');
      await ctx.show(back);
      return;
    }
    openLate(ctx, root, { shared: shared, blocks: blocks, running: running, gap: null, edit: target, back: back });
    return;
  }
  if (opts.mode === 'catchup') {
    openCatchup(ctx, root, { gap: opts.gap || null });
    return;
  }
  if (opts.mode === 'late') {
    openLate(ctx, root, { shared: shared, blocks: blocks, running: running, gap: opts.gap || null });
    return;
  }
  if (opts.mode === 'end') {
    await openEnd(ctx, root, { shared: shared, running: running, next: opts.next === 'switch' ? 'switch' : 'stop' });
    return;
  }

  // ------------------------------------------------------------ start, switch and change

  const isChange = opts.mode === 'change';
  if (isChange && !running) {
    await ctx.show('home');
    return;
  }
  const ending = !isChange && opts.ending ? opts.ending : null;
  const tz = ctx.tzOffsetMin();

  const submitText = isChange ? 'Save' : running ? 'Switch' : 'Start';
  const startBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true }, submitText);

  // ------------------------------------------------------------ the Started card (v38, log D108)
  // Only a plain Start has it. A Switch must begin exactly when the old block ends, and Change leaves the start
  // alone. Pick when the activity really began, and the timer runs from that time. "Now" is the default, and it
  // takes the same path as before. Any other choice is checked against the blocks you already logged.
  const showStarted = !isChange && !running && !ending;
  const last = lastEndedBlock(blocks);
  let startSpec = { kind: 'now' }; // {kind: 'now'}, {kind: 'ago', min}, {kind: 'since'} or {kind: 'exact'}
  const startPicker = showStarted ? makeTimePicker(ctx, 'Start', () => drawStarted()) : null;
  const startedRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Started' });
  const startedSummary = el('div', { class: 'summary' });
  const startedNote = el('p', { class: 'muted', hidden: true, text: 'Your last entry ended over 14 hours ago. Use Catch up on Home for that stretch.' });
  if (startPicker) startPicker.node.hidden = true;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = (epoch) => formatClock12(epoch, tz);
  function dayPrefix(epoch, now) {
    if (localDate(epoch, tz) === localDate(now, tz)) return '';
    const parts = localDate(epoch, tz).split('-').map(Number);
    return parts[2] + ' ' + MONTHS[parts[1] - 1] + ', ';
  }
  // "office work, credit policy deck" or just "office work".
  function nameOf(block) {
    const cats = block.lines.map((l) => l.category).join(' / ');
    return block.lines[0].label ? cats + ', ' + block.lines[0].label : cats;
  }
  function rangeOf(block, now) {
    return dayPrefix(block.start_epoch, now) + clock(block.start_epoch) + ' to ' + (block.end_epoch === null ? 'now' : clock(block.end_epoch));
  }

  // 80 minutes reads "1 h 20 min", 12 minutes reads "12 min".
  function howLong(sec) {
    const m = Math.round(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
  }

  function resolveStart(now) {
    if (startSpec.kind === 'now') return now;
    if (startSpec.kind === 'ago') return minutesAgo(now, startSpec.min);
    if (startSpec.kind === 'since') return last ? last.end_epoch : null;
    return startPicker.getEpoch();
  }

  // Says what the chosen start means and whether it can be saved. list is the blocks to check against.
  function describeStart(now, list) {
    if (startSpec.kind === 'now') return { ok: true, at: now, text: 'Starts now.' };
    const s = resolveStart(now);
    if (s === null) return { ok: false, text: 'Choose when it started.' };
    const check = checkBackdatedStart(s, list, now);
    if (check.ok) return { ok: true, at: s, text: dayPrefix(s, now) + clock(s) + ' to now · ' + howLong(now - s) };
    if (check.reason === 'future') return { ok: false, text: 'That start is in the future.' };
    if (check.reason === 'too_old') return { ok: false, text: 'That is more than 14 hours ago. Use Missed something or Catch up for that stretch.' };
    return { ok: false, text: 'That start overlaps ' + nameOf(check.block) + ' (' + rangeOf(check.block, now) + '). Pick a start after it ends.' };
  }

  function sameSpec(a, b) {
    return a.kind === b.kind && (b.kind !== 'ago' || a.min === b.min);
  }

  function startedChip(text, spec, disabled) {
    return el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(sameSpec(startSpec, spec)),
      disabled: disabled,
      onclick: () => chooseStarted(spec)
    }, text);
  }

  function chooseStarted(spec) {
    // Opening the exact wheels starts from whatever the chip meant a moment ago.
    if (spec.kind === 'exact' && startSpec.kind !== 'exact') {
      const now = ctx.nowEpoch();
      const current = resolveStart(now);
      startPicker.setEpoch(current !== null ? current : now);
    }
    startSpec = spec;
    drawStarted();
  }

  function drawStarted() {
    const now = ctx.nowEpoch();
    const sinceAge = last ? now - last.end_epoch : null;
    const sinceOk = last !== null && sinceAge >= 0 && sinceAge <= MAX_BACKDATE_SEC;
    clear(startedRow);
    startedRow.append(
      startedChip('Now', { kind: 'now' }, false),
      startedChip('15 min ago', { kind: 'ago', min: 15 }, false),
      startedChip('30 min ago', { kind: 'ago', min: 30 }, false),
      startedChip('1 hour ago', { kind: 'ago', min: 60 }, false),
      startedChip('Since last entry', { kind: 'since' }, !sinceOk),
      startedChip('Exact time', { kind: 'exact' }, false)
    );
    startPicker.node.hidden = startSpec.kind !== 'exact';
    startedNote.hidden = !(last !== null && sinceAge > MAX_BACKDATE_SEC);
    const d = describeStart(now, blocks);
    startedSummary.textContent = d.text;
    startedSummary.classList.toggle('summary-bad', !d.ok);
    updateStart();
  }

  function updateStart() {
    const startedBad = showStarted && !describeStart(ctx.nowEpoch(), blocks).ok;
    startBtn.disabled = picker.getId() === null || startedBad;
  }

  const picker = makeCategoryPicker(ctx, shared, updateStart);
  const label = makeLabelField(shared, () => {
    if (!startBtn.disabled) go();
  });

  startBtn.addEventListener('click', () => go());

  function go() {
    return isChange ? saveChange() : startNow();
  }

  // Changes the category and label of the running block. The start time is untouched,
  // so the timer carries on from where it was.
  async function saveChange() {
    const chosen = picker.getCategory();
    if (!chosen) return;
    startBtn.disabled = true;
    try {
      const current = await getRunningBlock(ctx.db);
      if (current) {
        const lines = [{ category: chosen.name, label: label.getValue(), share_pct: 100 }];
        await saveBlock(ctx.db, editBlock(current, { lines: lines }), { now: ctx.nowEpoch() });
      }
    } catch (err) {
      ctx.warn('Could not save. Nothing was changed. Try again.');
      updateStart();
      return;
    }
    await ctx.show('home');
  }

  async function startNow() {
    const chosen = picker.getCategory();
    if (!chosen) return;
    startBtn.disabled = true;
    try {
      // A start earlier than now (log D108). The blocks are read again, so a block saved since this screen opened
      // is still respected, and a block that began running meanwhile is refused as an overlap.
      if (showStarted && startSpec.kind !== 'now') {
        const now = ctx.nowEpoch();
        const d = describeStart(now, await getAllBlocks(ctx.db));
        if (!d.ok) {
          startedSummary.textContent = d.text;
          startedSummary.classList.add('summary-bad');
          updateStart();
          return;
        }
        const lines = [{ category: chosen.name, label: label.getValue(), share_pct: 100 }];
        const earlier = startBlockAt({ block_id: ctx.newId(), tz_offset_min: tz, day: ctx.dayFor(d.at), lines: lines }, d.at, now);
        await applySwitch(ctx.db, null, earlier, { now: now });
        await ctx.show('home');
        return;
      }
      // After the End screen the new block starts at the moment Switch was tapped, so no time falls between them.
      const at = ending ? ending.end : ctx.nowEpoch();
      // Read the running block again, so a stale screen can never leave two running.
      const current = await getRunningBlock(ctx.db);
      const lines = [{ category: chosen.name, label: label.getValue(), share_pct: 100 }];
      const made = switchBlock(
        current || null,
        { block_id: ctx.newId(), tz_offset_min: tz, day: ctx.dayFor(at), lines: lines },
        at,
        ending ? ending.lines : undefined
      );
      await applySwitch(ctx.db, made.previous, made.next, { now: ctx.nowEpoch(), bumpEnded: !!(ending && ending.changed) });
    } catch (err) {
      ctx.warn('Could not save. Nothing was changed. Try again.');
      updateStart();
      return;
    }
    await ctx.show('home');
  }

  // ------------------------------------------------------------ layout

  let subtitle = null;
  if (isChange) subtitle = el('p', { class: 'muted', text: 'The timer keeps counting. Only the category and label change.' });
  else if (ending) subtitle = el('p', { class: 'muted', text: 'This ends ' + running.lines.map((l) => l.category).join(' / ') + ' at ' + formatClock12(ending.end, tz) + '.' });
  else if (running) subtitle = el('p', { class: 'muted', text: 'This stops ' + running.lines.map((l) => l.category).join(' / ') + ' at the same moment.' });

  if (isChange) {
    const first = running.lines[0];
    label.setValue(first.label);
    const found = categoryByName(shared.categories, first.category, true);
    if (found) picker.setId(found.id);
  }
  if (showStarted) drawStarted();
  else updateStart();

  root.append(
    el('div', { class: 'head page-head head-back' }, [
      backButton(() => ctx.show('home')),
      el('h2', { class: 'title', text: isChange ? 'Change' : running ? 'Switch to' : 'Start' })
    ]),
    // append() prints a null as the word "null", so an empty subtitle is left out of the list.
    ...(subtitle ? [el('p', { class: 'muted start-note', text: subtitle.textContent })] : []),
    section(1, 'Category', [picker.node]),
    section(2, 'Label', [label.node]),
    // Left out of the list when there is no card, because append() prints a null as the word "null" (log I4).
    ...(showStarted
      ? [section(3, 'Started', [
          el('p', { class: 'muted', text: 'Forgot to tap Start? Pick when it really began. The timer runs from that time.' }),
          startedRow,
          startPicker.node,
          startedSummary,
          startedNote
        ])]
      : []),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      startBtn
    ])
  );
}
