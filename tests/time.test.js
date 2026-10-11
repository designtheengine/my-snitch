import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localDate, toIso, epochFromLocal, addDays, fallbackDay, reportingDay, nightDay,
  autoCloseEpoch, findGaps, latestGap, dayGaps, minutesAgo, formatDuration, formatClock12
} from '../js/time.js';

const IST = 330;
// 29 Sep 2026, 14:00:00 India time
const t = (h, m = 0, s = 0, date = '2026-09-29') => epochFromLocal(date, h, m, s, IST);

test('epochFromLocal and toIso agree, to the second, with the offset written out', () => {
  assert.equal(toIso(t(14), IST), '2026-09-29T14:00:00+05:30');
  assert.equal(toIso(t(14, 5, 9), IST), '2026-09-29T14:05:09+05:30');
  assert.equal(toIso(t(0, 0, 0), IST), '2026-09-29T00:00:00+05:30');
});

test('toIso handles zero and negative offsets', () => {
  assert.equal(toIso(0, 0), '1970-01-01T00:00:00+00:00');
  assert.equal(toIso(0, -300), '1969-12-31T19:00:00-05:00');
});

test('localDate follows the offset across midnight', () => {
  const utcLate = epochFromLocal('2026-09-29', 22, 0, 0, 0);
  assert.equal(localDate(utcLate, 0), '2026-09-29');
  assert.equal(localDate(utcLate, IST), '2026-09-30');
});

test('addDays crosses month and year ends', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('fallback day is the local date of start minus 4 hours', () => {
  assert.equal(fallbackDay(t(3, 59, 59), IST), '2026-09-28');
  assert.equal(fallbackDay(t(4, 0, 0), IST), '2026-09-29');
  assert.equal(fallbackDay(t(23, 0, 0), IST), '2026-09-29');
});

test('reporting day: the latest wake at or before the start decides', () => {
  const wakes = [
    { epoch: t(7, 0, 0, '2026-09-28'), offset_min: IST },
    { epoch: t(7, 30, 0, '2026-09-29'), offset_min: IST }
  ];
  assert.equal(reportingDay(t(9), IST, wakes), '2026-09-29');
  assert.equal(reportingDay(t(7, 30, 0), IST, wakes), '2026-09-29');
  assert.equal(reportingDay(t(18, 0, 0, '2026-09-28'), IST, wakes), '2026-09-28');
});

test('reporting day: a block after midnight but before the next wake stays on the wake day', () => {
  const wakes = [{ epoch: t(7, 0, 0), offset_min: IST }];
  assert.equal(reportingDay(t(1, 30, 0, '2026-09-30'), IST, wakes), '2026-09-29');
});

test('reporting day: with no wake before the block, the fallback applies', () => {
  const wakes = [{ epoch: t(7, 0, 0, '2026-09-30'), offset_min: IST }];
  assert.equal(reportingDay(t(9), IST, wakes), '2026-09-29');
  assert.equal(reportingDay(t(2, 0, 0, '2026-09-30'), IST, []), '2026-09-29');
});

test('night sleep counts toward the wake day, and is provisional until the wake is logged', () => {
  const bed = t(23, 30, 0);
  const wake = t(7, 0, 0, '2026-09-30');
  assert.deepEqual(
    nightDay({ bedEpoch: bed, bedOffsetMin: IST, wakeEpoch: wake, wakeOffsetMin: IST }),
    { day: '2026-09-30', provisional: false }
  );
  assert.deepEqual(
    nightDay({ bedEpoch: bed, bedOffsetMin: IST, wakeEpoch: null, wakeOffsetMin: IST }),
    { day: '2026-09-29', provisional: true }
  );
});

test('auto-close: fires after 04:00 on a later date, only when no bed was logged', () => {
  const wake = t(7, 0, 0);
  const cutoff = t(4, 0, 0, '2026-09-30');
  const base = { wakeEpoch: wake, wakeOffsetMin: IST, bedEpoch: null };
  assert.equal(autoCloseEpoch({ ...base, nowEpoch: t(23, 0, 0) }), null);
  assert.equal(autoCloseEpoch({ ...base, nowEpoch: t(3, 59, 59, '2026-09-30') }), null);
  assert.equal(autoCloseEpoch({ ...base, nowEpoch: cutoff }), null);
  assert.equal(autoCloseEpoch({ ...base, nowEpoch: t(4, 0, 1, '2026-09-30') }), cutoff);
  assert.equal(autoCloseEpoch({ ...base, nowEpoch: t(9, 0, 0, '2026-10-02') }), cutoff);
});

test('auto-close: a bed logged after the wake means nothing to close', () => {
  const args = { wakeEpoch: t(7), wakeOffsetMin: IST, bedEpoch: t(23, 45), nowEpoch: t(9, 0, 0, '2026-09-30') };
  assert.equal(autoCloseEpoch(args), null);
});

test('auto-close: an old bed from before this wake does not count', () => {
  const args = {
    wakeEpoch: t(7), wakeOffsetMin: IST, bedEpoch: t(23, 45, 0, '2026-09-28'),
    nowEpoch: t(9, 0, 0, '2026-09-30')
  };
  assert.equal(autoCloseEpoch(args), t(4, 0, 0, '2026-09-30'));
});

test('auto-close: no wake at all means nothing to close', () => {
  assert.equal(autoCloseEpoch({ wakeEpoch: null, wakeOffsetMin: IST, bedEpoch: null, nowEpoch: t(9) }), null);
});

const blk = (a, b) => ({ start_epoch: a, end_epoch: b, is_deleted: false });

test('gaps: finds holes longer than the threshold, in time order', () => {
  const blocks = [blk(t(8), t(9)), blk(t(9, 2), t(10)), blk(t(11), t(12))];
  const gaps = findGaps({ blocks, from: t(7), to: t(13), thresholdSec: 300 });
  assert.deepEqual(gaps, [
    { start: t(7), end: t(8) },
    { start: t(10), end: t(11) },
    { start: t(12), end: t(13) }
  ]);
  assert.deepEqual(latestGap(gaps), { start: t(12), end: t(13) });
});

test('gaps: a hole equal to the threshold is not a gap, one second more is', () => {
  const blocks = [blk(t(8), t(9)), blk(t(9, 5, 0), t(10))];
  assert.equal(findGaps({ blocks, from: t(8), to: t(10), thresholdSec: 300 }).length, 0);
  const wider = [blk(t(8), t(9)), blk(t(9, 5, 1), t(10))];
  assert.equal(findGaps({ blocks: wider, from: t(8), to: t(10), thresholdSec: 300 }).length, 1);
});

test('gaps: a running block covers time up to now', () => {
  const blocks = [blk(t(8), t(9)), blk(t(9), null)];
  assert.deepEqual(findGaps({ blocks, from: t(8), to: t(12), thresholdSec: 300 }), []);
});

test('gaps: overlapping and nested blocks do not create false gaps', () => {
  const blocks = [blk(t(8), t(11)), blk(t(9), t(10)), blk(t(10, 30), t(12))];
  assert.deepEqual(findGaps({ blocks, from: t(8), to: t(12), thresholdSec: 300 }), []);
});

test('gaps: deleted blocks are ignored, and blocks are clipped to the window', () => {
  const deleted = { start_epoch: t(9), end_epoch: t(10), is_deleted: true };
  const gaps = findGaps({ blocks: [blk(t(6), t(9)), deleted], from: t(7), to: t(11), thresholdSec: 300 });
  assert.deepEqual(gaps, [{ start: t(9), end: t(11) }]);
});

test('gaps: no blocks at all is one gap over the whole window; empty window is none', () => {
  assert.deepEqual(findGaps({ blocks: [], from: t(7), to: t(9), thresholdSec: 300 }), [{ start: t(7), end: t(9) }]);
  assert.deepEqual(findGaps({ blocks: [], from: t(7), to: t(7, 3), thresholdSec: 300 }), []);
  assert.equal(latestGap([]), null);
});

test('chips and formatting', () => {
  assert.equal(minutesAgo(t(14), 15), t(13, 45));
  assert.equal(formatDuration(5400), '1:30:00');
  assert.equal(formatDuration(59), '0:00:59');
  assert.equal(formatDuration(-4), '0:00:00');
  assert.equal(formatDuration(25 * 3600 + 61), '25:01:01');
  assert.equal(formatClock12(t(14, 10), IST), '2:10 pm');
  assert.equal(formatClock12(t(0, 5), IST), '12:05 am');
  assert.equal(formatClock12(t(12, 0), IST), '12:00 pm');
});

test('dayGaps: with no wake the scan starts at the first block of the day, so a fresh day reports nothing', () => {
  assert.deepEqual(dayGaps({ blocks: [], nowEpoch: t(12), thresholdSec: 300 }), []);
});

test('dayGaps: holes between blocks and after the last block are reported, the time before the first is not', () => {
  const blocks = [
    { start_epoch: t(9), end_epoch: t(10), is_deleted: false },
    { start_epoch: t(11), end_epoch: t(12), is_deleted: false }
  ];
  assert.deepEqual(dayGaps({ blocks, nowEpoch: t(13), thresholdSec: 300 }), [
    { start: t(10), end: t(11) },
    { start: t(12), end: t(13) }
  ]);
});

test('dayGaps: a wake time starts the scan earlier, and a running block covers up to now', () => {
  const blocks = [{ start_epoch: t(9), end_epoch: null, is_deleted: false }];
  assert.deepEqual(dayGaps({ blocks, nowEpoch: t(13), thresholdSec: 300, wakeEpoch: t(7) }), [{ start: t(7), end: t(9) }]);
  assert.deepEqual(dayGaps({ blocks, nowEpoch: t(13), thresholdSec: 300 }), []);
});

test('dayGaps: a gap at or under the threshold is not reported', () => {
  const blocks = [{ start_epoch: t(9), end_epoch: t(10), is_deleted: false }];
  assert.deepEqual(dayGaps({ blocks, nowEpoch: t(10, 5), thresholdSec: 300 }), []);
  assert.equal(dayGaps({ blocks, nowEpoch: t(10, 5, 1), thresholdSec: 300 }).length, 1);
});
