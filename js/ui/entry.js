// entry.js: the entry form (PRD section 5.2). One form for every entry task.
// It loads what every mode needs, then builds the mode asked for.
//   start: starts a block now, or switches (this file). Built in Phase 3.
//   late:  logs time you forgot to log (late.js). Built in Phase 4.
//   edit:  Phase 7.
// Check-in has no mode of its own: it folds into late mode (decided 11 Oct 2026, log Q8).
//
// openEntry(ctx, arg): arg is a mode name such as 'start' or 'late', or an object
// {mode: 'late', gap: {start, end, toNow}} when the gap banner opens late mode with a gap filled in.

import { el, clear } from './dom.js';
import { getCategories, getAllBlocks, getAllLabels, getRunningBlock, applySwitch } from '../db.js';
import { switchBlock } from '../model.js';
import { usageCounts } from '../categories.js';
import { makeShared, makeCategoryPicker, makeLabelField } from './picks.js';
import { openLate } from './late.js';

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

  if (opts.mode === 'late') {
    openLate(ctx, root, { shared: shared, blocks: blocks, running: running || null, gap: opts.gap || null });
    return;
  }

  // ------------------------------------------------------------ start or switch

  const startBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true }, running ? 'Switch' : 'Start');

  function updateStart() {
    startBtn.disabled = picker.getId() === null;
  }

  const picker = makeCategoryPicker(ctx, shared, updateStart);
  const label = makeLabelField(shared, () => {
    if (!startBtn.disabled) startNow();
  });

  startBtn.addEventListener('click', () => startNow());

  async function startNow() {
    const chosen = picker.getCategory();
    if (!chosen) return;
    startBtn.disabled = true;
    try {
      const now = ctx.nowEpoch();
      // Read the running block again, so a stale screen can never leave two running.
      const current = await getRunningBlock(ctx.db);
      const lines = [{ category: chosen.name, label: label.getValue(), share_pct: 100 }];
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

  updateStart();

  root.append(
    el('div', { class: 'head' }, [el('h2', { class: 'title', text: running ? 'Switch to' : 'Start' })]),
    // append() prints a null as the word "null", so an empty subtitle is left out of the list.
    ...(subtitle ? [subtitle] : []),
    el('div', { class: 'section-label', text: 'Category' }),
    picker.node,
    el('div', { class: 'section-label', text: 'Label' }),
    label.node,
    el('div', { class: 'spacer' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      startBtn
    ])
  );
}
