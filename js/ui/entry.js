// entry.js: the entry form (PRD section 5.2). One form for every entry task.
// It loads what every mode needs, then builds the mode asked for.
//   start:  starts a block now, or switches (this file). Built in Phase 3.
//   change: changes the category and label of the running block, the timer keeps counting (this file).
//   end:    the End screen that Stop and Switch open, with split (end.js).
//   late:   logs time you forgot to log (late.js).
//   edit:   Phase 7.
// Check-in has no mode of its own: it folds into late mode (decided 11 Oct 2026, log Q8).
//
// openEntry(ctx, arg): arg is a mode name such as 'start' or 'late', or an object:
//   {mode: 'late', gap: {start, end, toNow}}       the gap banner opens late mode with a gap filled in
//   {mode: 'end', next: 'stop' or 'switch'}        the End screen
//   {mode: 'start', ending: {end, lines, changed}} the start form after the End screen, for a switch

import { el, clear } from './dom.js';
import { getCategories, getAllBlocks, getAllLabels, getRunningBlock, applySwitch, saveBlock } from '../db.js';
import { switchBlock, editBlock } from '../model.js';
import { usageCounts } from '../categories.js';
import { formatClock12 } from '../time.js';
import { makeShared, makeCategoryPicker, makeLabelField } from './picks.js';
import { openLate } from './late.js';
import { openEnd } from './end.js';

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

  function updateStart() {
    startBtn.disabled = picker.getId() === null;
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
    const found = shared.categories.find((c) => !c.archived && c.name.toLowerCase() === first.category.toLowerCase());
    if (found) picker.setId(found.id);
  }
  updateStart();

  root.append(
    el('div', { class: 'head' }, [el('h2', { class: 'title', text: isChange ? 'Change' : running ? 'Switch to' : 'Start' })]),
    // append() prints a null as the word "null", so an empty subtitle is left out of the list.
    ...(subtitle ? [subtitle] : []),
    picker.node,
    label.node,
    el('div', { class: 'spacer' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      startBtn
    ])
  );
}
