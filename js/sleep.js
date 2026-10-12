// sleep.js: the sleep rules for my snitch. (PRD section 5.4, spec sections 4.4 and 6.3.)
// No screens and no storage, so every rule here is tested in Node.
//
// One record per night holds three moments: bed, fell asleep, woke up. From that record the
// app derives up to two ordinary blocks, so fixing a time in the morning check redraws both:
//   "trying to sleep"  bed to asleep   (the stretch that business question 7 measures)
//   "sleep"            asleep to wake
// Both blocks carry entry_mode 'sleep', and both wait for sync until the wake is logged.

import { createBlock, editBlock, deleteBlock, stopBlock, findOverlaps } from './model.js';
import { nightDay, autoCloseEpoch } from './time.js';

export const SLEEP_CATEGORY = 'sleep';
export const DOOM_CATEGORY = 'doomscrolling';
export const TRYING_LABEL = 'trying to sleep';
export const SLEEP_LABEL = 'sleep';

// ---------------------------------------------------------------- the night record

// A new night starts at bed. makeId gives the three random ids (the night and its two blocks).
export function newNight(args) {
  const night = {
    night_id: args.makeId(),
    day: '',
    bed_epoch: args.bedEpoch,
    bed_offset_min: args.offsetMin,
    asleep_epoch: null,
    wake_epoch: null,
    wake_offset_min: null,
    auto_closed: !!args.autoClosed,
    reviewed: false,
    trying_category: SLEEP_CATEGORY,
    bed_block_id: args.makeId(),
    sleep_block_id: args.makeId()
  };
  return withDay(night);
}

// The night's reporting day follows the wake. Until the wake exists it is only provisional.
function withDay(night) {
  night.day = nightDay({
    bedEpoch: night.bed_epoch,
    bedOffsetMin: night.bed_offset_min,
    wakeEpoch: night.wake_epoch,
    wakeOffsetMin: night.wake_offset_min
  }).day;
  return night;
}

// A changed copy of the record, with its day worked out again.
export function updateNight(night, changes) {
  return withDay(Object.assign({}, night, changes));
}

// Returns a plain sentence when the times cannot work, or null when they can.
export function checkNight(night, nowEpoch) {
  const { bed_epoch: bed, asleep_epoch: asleep, wake_epoch: wake } = night;
  if (bed > nowEpoch) return 'Bed time is in the future.';
  if (asleep !== null) {
    if (asleep < bed) return 'You cannot fall asleep before going to bed.';
    if (asleep > nowEpoch) return 'Fell asleep time is in the future.';
  }
  if (wake !== null) {
    if (wake <= bed) return 'Waking up has to come after going to bed.';
    if (asleep !== null && wake <= asleep) return 'Waking up has to come after falling asleep.';
    if (wake > nowEpoch) return 'Wake time is in the future.';
  }
  return null;
}

// ---------------------------------------------------------------- the blocks a night makes

// What blocks the record asks for. A night closed by the 4:00 am rule makes none until the
// wake is logged, because nobody knows when you really went to sleep.
export function desiredBlocks(night) {
  const { bed_epoch: bed, asleep_epoch: asleep, wake_epoch: wake } = night;
  if (night.auto_closed && wake === null) return [];
  const trying = night.trying_category || SLEEP_CATEGORY;
  if (asleep === null) {
    // Fell asleep is unknown. Until the wake it is one running "trying to sleep" block.
    // After the wake it becomes one plain sleep block from bed to wake.
    if (wake === null) {
      return [{ id: night.bed_block_id, start: bed, end: null, category: trying, label: TRYING_LABEL }];
    }
    return [{ id: night.bed_block_id, start: bed, end: wake, category: SLEEP_CATEGORY, label: SLEEP_LABEL }];
  }
  const out = [];
  if (asleep > bed) out.push({ id: night.bed_block_id, start: bed, end: asleep, category: trying, label: TRYING_LABEL });
  out.push({ id: night.sleep_block_id, start: asleep, end: wake, category: SLEEP_CATEGORY, label: SLEEP_LABEL });
  return out;
}

// Turns the record into saved blocks. existing is {block_id: block} for blocks already stored.
// A block that exists is edited under the normal versioning rules, a missing one is created,
// and a block the record no longer asks for is deleted. Returns {save: [blocks], remove: [ids]}.
export function blocksFor(night, existing, opts) {
  const save = [];
  const keep = new Set();
  for (const d of desiredBlocks(night)) {
    keep.add(d.id);
    const lines = [{ category: d.category, label: d.label, share_pct: 100 }];
    const old = existing[d.id];
    if (old && !old.is_deleted) {
      save.push(editBlock(old, { start_epoch: d.start, end_epoch: d.end, day: night.day, lines: lines }));
    } else {
      save.push(createBlock({
        block_id: d.id,
        start_epoch: d.start,
        end_epoch: d.end,
        tz_offset_min: night.bed_offset_min,
        day: night.day,
        lines: lines,
        entry_mode: 'sleep',
        now: opts.now
      }));
    }
  }
  const remove = [];
  for (const id of [night.bed_block_id, night.sleep_block_id]) {
    const old = existing[id];
    if (keep.has(id) || !old || old.is_deleted) continue;
    const res = deleteBlock(old);
    if (res.action === 'remove') remove.push(id);
    else if (res.action === 'update') save.push(res.block);
  }
  return { save: save, remove: remove };
}

// The first older block that the night's blocks would run into, or null.
// The morning check uses it, so a night never lands on top of time you logged by hand.
export function nightConflict(night, blocks, nowEpoch) {
  const own = new Set([night.bed_block_id, night.sleep_block_id]);
  const others = blocks.filter((b) => !own.has(b.block_id));
  for (const d of desiredBlocks(night)) {
    const candidate = { block_id: d.id, start_epoch: d.start, end_epoch: d.end };
    const found = findOverlaps(candidate, others, nowEpoch);
    if (found.conflicts.length) return found.conflicts[0].block;
  }
  return null;
}

// ---------------------------------------------------------------- plans
// Each plan is {night, stop, save, remove, deleteNightId, error}. db.saveNight writes one
// plan in a single transaction. error is a sentence and means nothing should be saved.

// Going to bed. A running block ends at this very second, so no time falls between them.
export function planBed(args) {
  const night = newNight({ bedEpoch: args.now, offsetMin: args.offsetMin, autoClosed: false, makeId: args.makeId });
  const stop = args.running ? stopBlock(args.running, args.now) : null;
  const made = blocksFor(night, {}, { now: args.now });
  return { night: night, stop: stop, save: made.save, remove: made.remove };
}

// A changed night (fell asleep, woke up, or an adjustment in the morning check).
export function planChange(night, changes, existing, nowEpoch) {
  const next = updateNight(night, changes);
  const error = checkNight(next, nowEpoch);
  if (error) return { error: error };
  const made = blocksFor(next, existing, { now: nowEpoch });
  return { night: next, stop: null, save: made.save, remove: made.remove };
}

// Discarding a night, for a bed tap made by mistake. Never-synced blocks vanish, synced ones
// get a deletion version, like any delete.
export function planDiscard(night, existing) {
  const save = [];
  const remove = [];
  for (const id of [night.bed_block_id, night.sleep_block_id]) {
    const old = existing[id];
    if (!old || old.is_deleted) continue;
    const res = deleteBlock(old);
    if (res.action === 'remove') remove.push(id);
    else if (res.action === 'update') save.push(res.block);
  }
  return { night: null, stop: null, save: save, remove: remove, deleteNightId: night.night_id };
}

// The 4:00 am rule. When the day has a wake but no bed, and it is now past 04:00 on a later
// date, the day closes at that 04:00 as an auto-closed bed. A block still running from before
// then is ended at 04:00. Returns a plan, or null when nothing should happen.
export function planAutoClose(args) {
  const woken = args.nights.filter((n) => n.wake_epoch !== null);
  if (woken.length === 0) return null;
  const lastWake = woken.reduce((a, b) => (b.wake_epoch > a.wake_epoch ? b : a));
  const lastBed = args.nights.reduce((a, n) => (a === null || n.bed_epoch > a ? n.bed_epoch : a), null);
  const cutoff = autoCloseEpoch({
    wakeEpoch: lastWake.wake_epoch,
    wakeOffsetMin: lastWake.wake_offset_min,
    bedEpoch: lastBed,
    nowEpoch: args.now
  });
  if (cutoff === null) return null;
  const night = newNight({ bedEpoch: cutoff, offsetMin: lastWake.wake_offset_min, autoClosed: true, makeId: args.makeId });
  const stop = args.running && args.running.start_epoch < cutoff ? stopBlock(args.running, cutoff) : null;
  return { night: night, stop: stop, save: [], remove: [] };
}

// ---------------------------------------------------------------- reading the nights

// Wake events in the shape reportingDay in time.js wants.
export function wakesFrom(nights) {
  return nights
    .filter((n) => n.wake_epoch !== null)
    .map((n) => ({ epoch: n.wake_epoch, offset_min: n.wake_offset_min }));
}

export function latestWake(nights) {
  const wakes = wakesFrom(nights);
  return wakes.length ? Math.max(...wakes.map((w) => w.epoch)) : null;
}

// Blocks of a night whose wake is not logged yet. They wait for sync (decided 4 Oct 2026),
// so the Home list and the unsynced count leave them out.
export function heldBlockIds(nights) {
  const held = new Set();
  for (const n of nights) {
    if (n.wake_epoch === null) {
      held.add(n.bed_block_id);
      held.add(n.sleep_block_id);
    }
  }
  return held;
}

// The night that is open now (bed logged, wake not), or null.
export function openNight(nights) {
  const open = nights.filter((n) => n.wake_epoch === null);
  return open.length ? open.reduce((a, b) => (b.bed_epoch > a.bed_epoch ? b : a)) : null;
}

// The latest night with a wake that nobody has reviewed yet, or null.
export function unreviewedNight(nights) {
  const todo = nights.filter((n) => n.wake_epoch !== null && !n.reviewed);
  return todo.length ? todo.reduce((a, b) => (b.wake_epoch > a.wake_epoch ? b : a)) : null;
}
