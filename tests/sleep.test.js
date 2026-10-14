import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newNight, updateNight, checkNight, desiredBlocks, blocksFor, nightConflict, planBed, planChange,
  planDiscard, planAutoClose, wakesFrom, latestWake, heldBlockIds, openNight, unreviewedNight,
  tryingLinesOf, isStaleOpenNight, STALE_OPEN_HOURS, TRYING_LABEL, SLEEP_LABEL
} from '../js/sleep.js';
import { createBlock, markSynced } from '../js/model.js';
import { reportingDay, epochFromLocal, localDate } from '../js/time.js';

const IST = 330;
const t = (h, m = 0, s = 0, date = '2026-10-12') => epochFromLocal(date, h, m, s, IST);
let n = 0;
const makeId = () => 'id' + ++n;

function night(over = {}) {
  n = 0;
  return Object.assign(newNight({ bedEpoch: t(23), offsetMin: IST, autoClosed: false, makeId }), over);
}
const byId = (blocks) => Object.fromEntries(blocks.map((b) => [b.block_id, b]));

test('a new night starts at bed, with a provisional day and three ids', () => {
  const x = night();
  assert.equal(x.bed_epoch, t(23));
  assert.equal(x.wake_epoch, null);
  assert.equal(x.day, '2026-10-12');
  assert.notEqual(x.bed_block_id, x.sleep_block_id);
  assert.equal(x.reviewed, false);
});

test('the day follows the wake: bed on the 12th, wake on the 13th counts toward the 13th', () => {
  const x = updateNight(night(), { wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  assert.equal(x.day, '2026-10-13');
});

test('before the asleep tap there is one running trying-to-sleep block', () => {
  const d = desiredBlocks(night());
  assert.equal(d.length, 1);
  assert.equal(d[0].end, null);
  assert.equal(d[0].lines[0].label, TRYING_LABEL);
});

test('with bed, asleep and wake there are two closed blocks that meet at the asleep time', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 40), wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const d = desiredBlocks(x);
  assert.equal(d.length, 2);
  assert.equal(d[0].end, d[1].start);
  assert.equal(d[0].lines[0].label, TRYING_LABEL);
  assert.equal(d[1].lines[0].label, SLEEP_LABEL);
  assert.equal(d[1].end, t(7, 0, 0, '2026-10-13'));
});

test('asleep unknown after the wake: one sleep block from bed to wake', () => {
  const x = updateNight(night(), { wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const d = desiredBlocks(x);
  assert.equal(d.length, 1);
  assert.equal(d[0].lines[0].label, SLEEP_LABEL);
  assert.equal(d[0].lines[0].category, 'sleep');
});

test('asleep at the same second as bed makes no trying block', () => {
  const x = updateNight(night(), { asleep_epoch: t(23) });
  const d = desiredBlocks(x);
  assert.equal(d.length, 1);
  assert.equal(d[0].lines[0].label, SLEEP_LABEL);
  assert.equal(d[0].end, null);
});

test('the stretch before sleep can be relabelled as doomscrolling and keeps its label', () => {
  const x = updateNight(night(), {
    asleep_epoch: t(23, 45),
    trying_lines: [{ category: 'doomscrolling', label: TRYING_LABEL, share_pct: 100 }]
  });
  const d = desiredBlocks(x);
  assert.equal(d[0].lines[0].category, 'doomscrolling');
  assert.equal(d[0].lines[0].label, TRYING_LABEL);
  assert.equal(d[1].lines[0].category, 'sleep');
});

test('the stretch before sleep can hold a mix of activities with shares', () => {
  const mix = [
    { category: 'social', label: 'talking', share_pct: 50 },
    { category: 'doomscrolling', label: '', share_pct: 40 },
    { category: 'sleep', label: TRYING_LABEL, share_pct: 10 }
  ];
  const x = updateNight(night(), { asleep_epoch: t(23, 50), trying_lines: mix });
  const made = blocksFor(x, {}, { now: t(23, 51) }).save;
  const before = made.find((b) => b.block_id === x.bed_block_id);
  assert.equal(before.lines.length, 3);
  assert.equal(before.lines.reduce((a, l) => a + l.share_pct, 0), 100);
  assert.equal(before.end_epoch, t(23, 50));
});

test('a night saved by v13 with one category (trying_category) still reads as one line', () => {
  const old = Object.assign(night(), { trying_category: 'doomscrolling' });
  delete old.trying_lines;
  assert.deepEqual(tryingLinesOf(old), [{ category: 'doomscrolling', label: TRYING_LABEL, share_pct: 100 }]);
});

test('changing the lines of a synced night makes a new version of the before-sleep block only', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30), wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const made = blocksFor(x, {}, { now: t(7, 1, 0, '2026-10-13') }).save.map((b) => markSynced(b, 1));
  const later = updateNight(x, { trying_lines: [{ category: 'social', label: 'talking', share_pct: 100 }] });
  const again = blocksFor(later, byId(made), { now: t(8, 0, 0, '2026-10-13') }).save;
  const before = again.find((b) => b.block_id === x.bed_block_id);
  const slept = again.find((b) => b.block_id === x.sleep_block_id);
  assert.equal(before.version, 2);
  assert.equal(slept.version, 1);
});

test('an auto-closed night makes no blocks until the wake is logged', () => {
  const x = night({ auto_closed: true });
  assert.deepEqual(desiredBlocks(x), []);
  const woke = updateNight(x, { wake_epoch: t(8, 0, 0, '2026-10-13'), wake_offset_min: IST });
  assert.equal(desiredBlocks(woke).length, 1);
});

test('checkNight names each problem in plain words', () => {
  const now = t(12, 0, 0, '2026-10-13');
  assert.equal(checkNight(night(), now), null);
  assert.match(checkNight(updateNight(night(), { asleep_epoch: t(22) }), now), /before going to bed/);
  assert.match(checkNight(updateNight(night(), { wake_epoch: t(22), wake_offset_min: IST }), now), /after going to bed/);
  assert.match(checkNight(updateNight(night(), { asleep_epoch: t(23, 30), wake_epoch: t(23, 20), wake_offset_min: IST }), now), /after falling asleep/);
  assert.match(checkNight(updateNight(night(), { wake_epoch: t(13, 0, 0, '2026-10-13'), wake_offset_min: IST }), now), /future/);
});

test('blocksFor creates blocks in sleep mode with the night day and the bed offset', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30) });
  const { save, remove } = blocksFor(x, {}, { now: t(23, 31) });
  assert.equal(save.length, 2);
  assert.deepEqual(remove, []);
  for (const b of save) {
    assert.equal(b.entry_mode, 'sleep');
    assert.equal(b.tz_offset_min, IST);
    assert.equal(b.version, 1);
  }
  assert.equal(save.filter((b) => b.running === 1).length, 1);
});

test('blocksFor edits existing blocks in place while they are unsynced, and keeps version 1', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30) });
  const first = blocksFor(x, {}, { now: t(23, 31) }).save;
  const woke = updateNight(x, { wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const second = blocksFor(woke, byId(first), { now: t(7, 1, 0, '2026-10-13') }).save;
  assert.equal(second.length, 2);
  for (const b of second) {
    assert.equal(b.version, 1);
    assert.equal(b.day, '2026-10-13');
    assert.equal(b.running, 0);
  }
});

test('blocksFor on a synced block makes a new version, so the Sheet keeps the original row', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30), wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const made = blocksFor(x, {}, { now: t(7, 1, 0, '2026-10-13') }).save.map((b) => markSynced(b, 1));
  const later = updateNight(x, { asleep_epoch: t(23, 50) });
  const again = blocksFor(later, byId(made), { now: t(8, 0, 0, '2026-10-13') }).save;
  assert.ok(again.every((b) => b.version === 2));
});

test('dropping the asleep time removes the sleep block record when it was never synced', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30), wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const made = blocksFor(x, {}, { now: t(7, 1, 0, '2026-10-13') }).save;
  const none = updateNight(x, { asleep_epoch: null });
  const res = blocksFor(none, byId(made), { now: t(8, 0, 0, '2026-10-13') });
  assert.equal(res.save.length, 1);
  assert.deepEqual(res.remove, [x.sleep_block_id]);
});

test('going to bed ends a running block at that very second', () => {
  const running = createBlock({
    block_id: 'r1', start_epoch: t(21), end_epoch: null, tz_offset_min: IST, day: '2026-10-12',
    lines: [{ category: 'doomscrolling', label: '', share_pct: 100 }], entry_mode: 'timer', now: t(21)
  });
  n = 0;
  const plan = planBed({ running, now: t(23, 5, 9), offsetMin: IST, makeId });
  assert.equal(plan.stop.action, 'update');
  assert.equal(plan.stop.block.end_epoch, t(23, 5, 9));
  assert.equal(plan.save[0].start_epoch, t(23, 5, 9));
  assert.equal(plan.save[0].running, 1);
});

test('going to bed with nothing running just starts the night', () => {
  n = 0;
  const plan = planBed({ running: null, now: t(23), offsetMin: IST, makeId });
  assert.equal(plan.stop, null);
  assert.equal(plan.save.length, 1);
});

test('planChange refuses bad times and changes nothing', () => {
  const x = night();
  const res = planChange(x, { asleep_epoch: t(22) }, {}, t(23, 30));
  assert.match(res.error, /before going to bed/);
  assert.equal(res.save, undefined);
});

test('planDiscard removes never-synced blocks and the record', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30) });
  const made = blocksFor(x, {}, { now: t(23, 31) }).save;
  const res = planDiscard(x, byId(made));
  assert.equal(res.remove.length, 2);
  assert.equal(res.deleteNightId, x.night_id);
});

test('auto-close: wake logged, no bed, past 04:00 the next day gives a bed at 04:00', () => {
  const woke = night({ bed_epoch: t(23, 0, 0, '2026-10-11'), wake_epoch: t(7, 0), wake_offset_min: IST, asleep_epoch: null });
  const plan = planAutoClose({ nights: [woke], running: null, now: t(9, 0, 0, '2026-10-13'), makeId });
  assert.equal(plan.night.bed_epoch, t(4, 0, 0, '2026-10-13'));
  assert.equal(plan.night.auto_closed, true);
  assert.deepEqual(plan.save, []);
});

test('auto-close does nothing before 04:00, with a bed already logged, or with no wake yet', () => {
  const woke = night({ bed_epoch: t(23, 0, 0, '2026-10-11'), wake_epoch: t(7, 0), wake_offset_min: IST });
  assert.equal(planAutoClose({ nights: [woke], running: null, now: t(3, 0, 0, '2026-10-13'), makeId }), null);
  const withBed = night({ bed_epoch: t(23, 30) });
  assert.equal(planAutoClose({ nights: [woke, withBed], running: null, now: t(9, 0, 0, '2026-10-13'), makeId }), null);
  assert.equal(planAutoClose({ nights: [], running: null, now: t(9, 0, 0, '2026-10-13'), makeId }), null);
});

test('auto-close ends a block that was still running at 04:00, and leaves a later one alone', () => {
  const woke = night({ bed_epoch: t(23, 0, 0, '2026-10-11'), wake_epoch: t(7, 0), wake_offset_min: IST });
  const mk = (start) => createBlock({
    block_id: 'r1', start_epoch: start, end_epoch: null, tz_offset_min: IST, day: '2026-10-12',
    lines: [{ category: 'social', label: '', share_pct: 100 }], entry_mode: 'timer', now: start
  });
  const early = planAutoClose({ nights: [woke], running: mk(t(22)), now: t(9, 0, 0, '2026-10-13'), makeId });
  assert.equal(early.stop.block.end_epoch, t(4, 0, 0, '2026-10-13'));
  const late = planAutoClose({ nights: [woke], running: mk(t(6, 0, 0, '2026-10-13')), now: t(9, 0, 0, '2026-10-13'), makeId });
  assert.equal(late.stop, null);
});

test('held blocks are those of nights without a wake, and wakes feed the reporting day', () => {
  const open = night();
  const done = night({ wake_epoch: t(7, 0, 0, '2026-10-12'), wake_offset_min: IST, bed_block_id: 'x1', sleep_block_id: 'x2' });
  const held = heldBlockIds([open, done]);
  assert.ok(held.has(open.bed_block_id));
  assert.ok(!held.has('x1'));
  assert.equal(openNight([open, done]).night_id, open.night_id);
  assert.equal(latestWake([open, done]), t(7, 0, 0, '2026-10-12'));
  assert.equal(reportingDay(t(9, 0, 0, '2026-10-12'), IST, wakesFrom([done])), '2026-10-12');
  assert.equal(unreviewedNight([done]).night_id, done.night_id);
  assert.equal(unreviewedNight([Object.assign({}, done, { reviewed: true })]), null);
});

test('nightConflict finds a block the night would land on, and ignores its own blocks', () => {
  const x = updateNight(night(), { asleep_epoch: t(23, 30), wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  const mine = blocksFor(x, {}, { now: t(7, 1, 0, '2026-10-13') }).save;
  assert.equal(nightConflict(x, mine, t(8, 0, 0, '2026-10-13')), null);
  const other = createBlock({
    block_id: 'o1', start_epoch: t(2, 0, 0, '2026-10-13'), end_epoch: t(3, 0, 0, '2026-10-13'), tz_offset_min: IST,
    day: '2026-10-12', lines: [{ category: 'social', label: '', share_pct: 100 }], entry_mode: 'late', now: t(3, 1, 0, '2026-10-13')
  });
  assert.equal(nightConflict(x, mine.concat([other]), t(8, 0, 0, '2026-10-13')).block_id, 'o1');
});

test('localDate sanity for the test helper', () => {
  assert.equal(localDate(t(23), IST), '2026-10-12');
});

test('an open night is stale only after 14 hours, and only while no wake is logged', () => {
  const x = night();
  assert.equal(STALE_OPEN_HOURS, 14);
  assert.equal(isStaleOpenNight(x, x.bed_epoch + 14 * 3600), false);
  assert.equal(isStaleOpenNight(x, x.bed_epoch + 14 * 3600 + 1), true);
  assert.equal(isStaleOpenNight(x, x.bed_epoch + 8 * 3600), false);
  const woke = updateNight(x, { wake_epoch: x.bed_epoch + 8 * 3600, wake_offset_min: IST });
  assert.equal(isStaleOpenNight(woke, x.bed_epoch + 30 * 3600), false);
});

test('a wake confirmed later takes the day of the real wake, not of the tap', () => {
  const x = night();
  const real = updateNight(x, { wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST });
  assert.equal(real.day, '2026-10-13');
  const res = planChange(x, { wake_epoch: t(7, 0, 0, '2026-10-13'), wake_offset_min: IST, reviewed: true }, {}, t(18, 31, 0, '2026-10-14'));
  assert.equal(res.error, undefined);
  assert.equal(res.night.day, '2026-10-13');
  assert.equal(res.save[0].day, '2026-10-13');
  assert.equal(res.save[0].running, 0);
});
