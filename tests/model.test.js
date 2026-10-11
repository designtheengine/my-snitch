import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  largestRemainder, fitShares, maxShare, moveSlider, addLine, removeLine,
  displayMinutes, lineMinutes, validateLines, createBlock, editBlock, deleteBlock,
  markSynced, isSyncEligible, outgoingRows, elapsedSeconds, stopBlock, switchBlock,
  findOverlaps, trimOlder, SCHEMA_VERSION
} from '../js/model.js';
import { epochFromLocal } from '../js/time.js';

const IST = 330;
const t = (h, m = 0, s = 0, date = '2026-09-29') => epochFromLocal(date, h, m, s, IST);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const one = (category = 'office work', label = 'credit policy deck') => [{ category, label, share_pct: 100 }];

function make(over = {}) {
  return createBlock(Object.assign({
    block_id: 'b1', start_epoch: t(14), end_epoch: t(15, 30), tz_offset_min: IST,
    day: '2026-09-29', lines: one(), entry_mode: 'manual', now: t(15, 31)
  }, over));
}
// A block as it looks after a successful sync of version v.
const syncedAt = (block, v) => markSynced(block, v);

// ------------------------------------------------------------ split math

test('largestRemainder: parts add up exactly, ties go to the earlier item', () => {
  assert.deepEqual(largestRemainder(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(largestRemainder(10, [1, 1]), [5, 5]);
  assert.deepEqual(largestRemainder(0, [3, 4]), [0, 0]);
  assert.deepEqual(largestRemainder(5, []), []);
  assert.throws(() => largestRemainder(5, [0, 0]));
});

test('90 minutes at 70 and 30 shows 63 and 27 (acceptance check 3)', () => {
  assert.deepEqual(displayMinutes(90 * 60, [70, 30]), [63, 27]);
  assert.equal(lineMinutes(90 * 60, 70), 63);
  assert.equal(lineMinutes(90 * 60, 30), 27);
});

test('displayed minutes always add up to the block minutes', () => {
  for (const mins of [1, 7, 45, 61, 90, 133, 479]) {
    for (const shares of [[100], [50, 50], [70, 30], [33, 33, 34], [1, 1, 98], [20, 20, 20, 20, 20], [97, 1, 1, 1]]) {
      assert.equal(sum(displayMinutes(mins * 60, shares)), mins, mins + ' min at ' + shares);
    }
  }
});

test('exact line minutes use real seconds, not the rounded display', () => {
  assert.equal(lineMinutes(100 * 60 + 30, 50), 50.25);
});

test('moveSlider: others share the rest in proportion', () => {
  assert.deepEqual(moveSlider([50, 30, 20], 0, 70), [70, 18, 12]);
  assert.deepEqual(moveSlider([70, 30], 0, 40), [40, 60]);
  assert.deepEqual(moveSlider([100], 0, 30), [100]);
});

test('moveSlider: clamps to 1 and to 100 minus the other lines', () => {
  assert.deepEqual(moveSlider([50, 50], 0, 100), [99, 1]);
  assert.deepEqual(moveSlider([50, 30, 20], 1, 0), [71, 1, 28]);
  assert.equal(moveSlider([34, 33, 33], 0, 500)[0], maxShare(3));
  assert.equal(maxShare(5), 96);
});

test('moveSlider keeps the total at 100 and every line at 1 or more, for every move (acceptance check 4)', () => {
  const starts = {
    2: [[50, 50], [99, 1], [1, 99], [70, 30]],
    3: [[34, 33, 33], [98, 1, 1], [1, 1, 98], [50, 30, 20], [1, 98, 1]],
    4: [[25, 25, 25, 25], [97, 1, 1, 1], [1, 1, 1, 97]],
    5: [[20, 20, 20, 20, 20], [96, 1, 1, 1, 1], [40, 30, 20, 9, 1], [1, 1, 96, 1, 1]]
  };
  let moves = 0;
  for (const n of Object.keys(starts)) {
    for (const shares of starts[n]) {
      assert.equal(sum(shares), 100);
      for (let i = 0; i < shares.length; i++) {
        for (let v = 1; v <= maxShare(shares.length); v++) {
          const out = moveSlider(shares, i, v);
          assert.equal(out.length, shares.length);
          assert.equal(sum(out), 100, 'sum for ' + shares + ' line ' + i + ' to ' + v);
          assert.equal(out[i], v);
          assert.ok(out.every((x) => Number.isInteger(x) && x >= 1), 'min 1 for ' + shares + ' line ' + i + ' to ' + v);
          moves++;
        }
      }
    }
  }
  assert.ok(moves > 1000);
});

test('a chain of random slider moves never breaks the total', () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let shares = [100];
  for (let step = 0; step < 400; step++) {
    const r = rand();
    if (r < 0.15 && shares.length < 8) shares = addLine(shares);
    else if (r < 0.25 && shares.length > 1) shares = removeLine(shares, Math.floor(rand() * shares.length));
    else shares = moveSlider(shares, Math.floor(rand() * shares.length), 1 + Math.floor(rand() * 100));
    assert.equal(sum(shares), 100);
    assert.ok(shares.every((x) => Number.isInteger(x) && x >= 1));
  }
});

test('addLine gives the new line a fair share; removeLine refills to 100', () => {
  assert.deepEqual(addLine([100]), [50, 50]);
  assert.deepEqual(addLine([70, 30]), [47, 20, 33]);
  assert.deepEqual(removeLine([47, 20, 33], 2), [70, 30]);
  assert.deepEqual(removeLine([50, 50], 0), [100]);
  assert.throws(() => removeLine([100], 0));
  const ninetyNine = Array(99).fill(1);
  ninetyNine[0] = 2;
  const hundred = addLine(ninetyNine);
  assert.equal(hundred.length, 100);
  assert.equal(sum(hundred), 100);
  assert.throws(() => addLine(hundred));
});

test('fitShares never leaves a part below 1', () => {
  assert.deepEqual(fitShares(3, [100, 1, 1]), [1, 1, 1]);
  assert.ok(fitShares(10, [1000, 1, 1, 1]).every((x) => x >= 1));
});

test('validateLines rejects bad input', () => {
  assert.doesNotThrow(() => validateLines(one()));
  assert.throws(() => validateLines([]));
  assert.throws(() => validateLines([{ category: '', label: '', share_pct: 100 }]));
  assert.throws(() => validateLines([{ category: 'admin', label: '', share_pct: 60 }]));
  assert.throws(() => validateLines([{ category: 'admin', label: '', share_pct: 50.5 }, { category: 'admin', label: '', share_pct: 49.5 }]));
  assert.throws(() => validateLines([{ category: 'admin', label: 'x'.repeat(61), share_pct: 100 }]));
  assert.doesNotThrow(() => validateLines([{ category: 'admin', label: '', share_pct: 100 }]));
});

// ------------------------------------------------------------ creating

test('a new block is version 1, never synced, dirty', () => {
  const b = make();
  assert.equal(b.version, 1);
  assert.equal(b.synced_version, 0);
  assert.equal(b.dirty, 1);
  assert.equal(b.running, 0);
  assert.equal(b.is_deleted, false);
  assert.equal(b.logged_at, t(15, 31));
});

test('createBlock rejects missing id, unknown mode, and end before start', () => {
  assert.throws(() => make({ block_id: '' }));
  assert.throws(() => make({ entry_mode: 'telepathy' }));
  assert.throws(() => make({ end_epoch: t(13) }));
  assert.throws(() => make({ end_epoch: t(14) }));
});

test('createBlock copies the lines, so later changes to the input do not leak in', () => {
  const lines = one();
  const b = make({ lines });
  lines[0].label = 'changed';
  assert.equal(b.lines[0].label, 'credit policy deck');
});

// ------------------------------------------------------------ versioning table (spec section 5)

test('edit, never synced: changed in place, version stays 1', () => {
  const b = make();
  const e = editBlock(b, { end_epoch: t(15) });
  assert.equal(e.end_epoch, t(15));
  assert.equal(e.version, 1);
  assert.equal(e.synced_version, 0);
  assert.equal(e.dirty, 1);
  assert.equal(b.end_epoch, t(15, 30), 'the input block is untouched');
});

test('edit, synced and unchanged since: version goes up by one, dirty again', () => {
  const b = syncedAt(make(), 1);
  assert.equal(b.dirty, 0);
  const e = editBlock(b, { end_epoch: t(15) });
  assert.equal(e.version, 2);
  assert.equal(e.synced_version, 1);
  assert.equal(e.dirty, 1);
});

test('edit again before sync: repeated edits collapse into one new version', () => {
  const b = syncedAt(make(), 1);
  const e1 = editBlock(b, { end_epoch: t(15) });
  const e2 = editBlock(e1, { end_epoch: t(14, 45) });
  const e3 = editBlock(e2, { lines: one('admin', 'inbox') });
  assert.equal(e1.version, 2);
  assert.equal(e2.version, 2);
  assert.equal(e3.version, 2);
  assert.equal(e3.end_epoch, t(14, 45));
  assert.equal(e3.lines[0].category, 'admin');
});

test('after a version 2 sync, the next edit makes version 3', () => {
  let b = syncedAt(make(), 1);
  b = editBlock(b, { end_epoch: t(15) });
  b = syncedAt(b, 2);
  assert.equal(b.dirty, 0);
  assert.equal(editBlock(b, { end_epoch: t(14, 50) }).version, 3);
});

test('an edit that changes nothing creates no version', () => {
  const b = syncedAt(make(), 1);
  assert.equal(editBlock(b, { end_epoch: t(15, 30) }), b);
  assert.equal(editBlock(b, { lines: one() }), b);
  assert.equal(editBlock(b, {}), b);
});

test('edit rules: only known fields, valid values, never a deleted block', () => {
  const b = make();
  assert.throws(() => editBlock(b, { version: 9 }));
  assert.throws(() => editBlock(b, { entry_mode: 'late' }));
  assert.throws(() => editBlock(b, { end_epoch: t(13) }));
  assert.throws(() => editBlock(b, { lines: [{ category: 'admin', label: '', share_pct: 90 }] }));
  const gone = deleteBlock(syncedAt(b, 1)).block;
  assert.throws(() => editBlock(gone, { end_epoch: t(15) }));
});

test('delete, never synced: the record is removed and nothing is ever sent', () => {
  const b = make();
  assert.deepEqual(deleteBlock(b), { action: 'remove', block_id: 'b1' });
  assert.deepEqual(deleteBlock(editBlock(b, { end_epoch: t(15) })), { action: 'remove', block_id: 'b1' });
});

test('delete, synced: a deletion version is saved', () => {
  const b = syncedAt(make(), 1);
  const r = deleteBlock(b);
  assert.equal(r.action, 'update');
  assert.equal(r.block.is_deleted, true);
  assert.equal(r.block.version, 2);
  assert.equal(r.block.dirty, 1);
  assert.equal(r.block.lines.length, 1);
});

test('delete a synced block that already has an unsynced edit: still version 2, not 3', () => {
  const b = editBlock(syncedAt(make(), 1), { end_epoch: t(15) });
  const r = deleteBlock(b);
  assert.equal(r.block.version, 2);
  assert.equal(r.block.is_deleted, true);
});

test('deleting twice does nothing the second time', () => {
  const r1 = deleteBlock(syncedAt(make(), 1));
  const r2 = deleteBlock(r1.block);
  assert.equal(r2.action, 'none');
});

test('markSynced: clean after the version sent, still dirty if the block moved on meanwhile', () => {
  const b = make();
  const clean = markSynced(b, 1);
  assert.equal(clean.synced_version, 1);
  assert.equal(clean.dirty, 0);
  const moved = editBlock(syncedAt(b, 1), { end_epoch: t(15) });
  const lateAck = markSynced(moved, 1);
  assert.equal(lateAck.synced_version, 1);
  assert.equal(lateAck.dirty, 1);
  assert.equal(markSynced(lateAck, 2).dirty, 0);
});

test('markSynced never moves synced_version backwards', () => {
  const b = Object.assign(make(), { version: 3, synced_version: 3, dirty: 0 });
  assert.equal(markSynced(b, 2).synced_version, 3);
});

test('a block deleted after sync stays deleted, and its deletion version syncs once', () => {
  const del = deleteBlock(syncedAt(make(), 1)).block;
  const done = markSynced(del, 2);
  assert.equal(done.dirty, 0);
  assert.equal(done.is_deleted, true);
});

// ------------------------------------------------------------ sync eligibility and rows

test('running blocks are never eligible; night sleep waits for the wake', () => {
  const running = make({ end_epoch: null, entry_mode: 'timer' });
  assert.equal(isSyncEligible(running), false);
  const done = make();
  assert.equal(isSyncEligible(done), true);
  assert.equal(isSyncEligible(syncedAt(done, 1)), false);
  const night = make({ entry_mode: 'sleep' });
  assert.equal(isSyncEligible(night, { wakeLogged: false }), false);
  assert.equal(isSyncEligible(night, { wakeLogged: true }), true);
  assert.equal(isSyncEligible(make({ entry_mode: 'late' }), { wakeLogged: false }), true);
});

test('outgoing rows: one per line, deterministic ids, ISO times with offset', () => {
  const lines = [
    { category: 'office work', label: 'credit policy deck', share_pct: 70 },
    { category: 'doomscrolling', label: '', share_pct: 30 }
  ];
  const b = make({ lines });
  const rows = outgoingRows(b);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.row_id), ['b1:1:0', 'b1:1:1']);
  assert.equal(rows[0].start_ts, '2026-09-29T14:00:00+05:30');
  assert.equal(rows[0].end_ts, '2026-09-29T15:30:00+05:30');
  assert.equal(rows[0].logged_at, '2026-09-29T15:31:00+05:30');
  assert.equal(rows[0].start_epoch, t(14));
  assert.equal(rows[0].day, '2026-09-29');
  assert.equal(rows[0].share_pct, 70);
  assert.equal(rows[1].category, 'doomscrolling');
  assert.equal(rows[1].label, '');
  assert.equal(rows[0].schema_version, SCHEMA_VERSION);
  assert.equal(rows[0].is_deleted, false);
  assert.equal(rows[0].entry_mode, 'manual');
});

test('retrying a sync produces the same row ids (safe to repeat)', () => {
  const b = make({ lines: [{ category: 'a', label: '', share_pct: 60 }, { category: 'b', label: '', share_pct: 40 }] });
  assert.deepEqual(outgoingRows(b).map((r) => r.row_id), outgoingRows(b).map((r) => r.row_id));
});

test('an edited block makes new ids at the higher version; the old ids stay with version 1', () => {
  const b = syncedAt(make(), 1);
  const e = editBlock(b, { end_epoch: t(15) });
  assert.deepEqual(outgoingRows(b).map((r) => r.row_id), ['b1:1:0']);
  assert.deepEqual(outgoingRows(e).map((r) => r.row_id), ['b1:2:0']);
});

test('an edit that drops a line sends fewer rows at the new version', () => {
  const three = make({
    lines: [
      { category: 'a', label: '', share_pct: 50 },
      { category: 'b', label: '', share_pct: 30 },
      { category: 'c', label: '', share_pct: 20 }
    ]
  });
  const two = editBlock(syncedAt(three, 1), {
    lines: [{ category: 'a', label: '', share_pct: 60 }, { category: 'b', label: '', share_pct: 40 }]
  });
  assert.equal(outgoingRows(three).length, 3);
  assert.equal(outgoingRows(two).length, 2);
  assert.equal(two.version, 2);
});

test('a deletion version sends rows flagged is_deleted', () => {
  const rows = outgoingRows(deleteBlock(syncedAt(make(), 1)).block);
  assert.equal(rows[0].is_deleted, true);
  assert.equal(rows[0].row_id, 'b1:2:0');
});

test('a running block cannot be turned into rows', () => {
  assert.throws(() => outgoingRows(make({ end_epoch: null, entry_mode: 'timer' })));
});

// ------------------------------------------------------------ timer

test('elapsed time is now minus the saved start, so it stays right when the app was closed', () => {
  const run = make({ end_epoch: null, entry_mode: 'timer', start_epoch: t(14) });
  assert.equal(run.running, 1);
  assert.equal(elapsedSeconds(run, t(14, 0, 30)), 30);
  assert.equal(elapsedSeconds(run, t(16, 30, 0)), 2.5 * 3600);
  assert.equal(elapsedSeconds(run, t(13)), 0);
  assert.equal(elapsedSeconds(make(), t(23)), 90 * 60, 'a finished block uses its own end');
});

test('stop closes the block in place, still version 1, no longer running', () => {
  const run = make({ end_epoch: null, entry_mode: 'timer' });
  const r = stopBlock(run, t(14, 20));
  assert.equal(r.action, 'update');
  assert.equal(r.block.end_epoch, t(14, 20));
  assert.equal(r.block.running, 0);
  assert.equal(r.block.version, 1);
  assert.equal(r.block.dirty, 1);
});

test('stopping a block that ran under a second removes it; stopping a stopped block is an error', () => {
  const run = make({ end_epoch: null, entry_mode: 'timer' });
  assert.deepEqual(stopBlock(run, t(14)), { action: 'remove', block_id: 'b1' });
  assert.throws(() => stopBlock(make(), t(16)));
});

test('switch closes the running block at the same moment the new one starts', () => {
  const run = make({ end_epoch: null, entry_mode: 'timer', start_epoch: t(14) });
  const r = switchBlock(run, { block_id: 'b2', tz_offset_min: IST, day: '2026-09-29', lines: one('admin', 'inbox') }, t(14, 40));
  assert.equal(r.previous.action, 'update');
  assert.equal(r.previous.block.end_epoch, t(14, 40));
  assert.equal(r.next.start_epoch, t(14, 40));
  assert.equal(r.next.end_epoch, null);
  assert.equal(r.next.running, 1);
  assert.equal(r.next.entry_mode, 'timer');
});

test('switch with nothing running just starts a block', () => {
  const r = switchBlock(null, { block_id: 'b2', tz_offset_min: IST, day: '2026-09-29', lines: one() }, t(9));
  assert.equal(r.previous, null);
  assert.equal(r.next.running, 1);
});

// ------------------------------------------------------------ overlap (spec section 6.4)

const blockAt = (id, a, b, over = {}) => make(Object.assign({ block_id: id, start_epoch: a, end_epoch: b }, over));
const NOW = t(18);

test('overlap: touching blocks do not conflict', () => {
  const older = blockAt('old', t(10), t(11));
  const r = findOverlaps(blockAt('new', t(11), t(12)), [older], NOW);
  assert.deepEqual(r, { conflicts: [], blocked: false });
});

test('overlap: new block starts inside an older one', () => {
  const older = blockAt('old', t(10), t(12));
  const r = findOverlaps(blockAt('new', t(11), t(13)), [older], NOW);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'starts-inside');
  assert.equal(r.blocked, false);
});

test('overlap: new block ends inside an older one', () => {
  const older = blockAt('old', t(10), t(12));
  const r = findOverlaps(blockAt('new', t(9), t(11)), [older], NOW);
  assert.equal(r.conflicts[0].kind, 'ends-inside');
  assert.equal(r.blocked, false);
});

test('overlap: new block fully inside an older one is refused, including an identical span', () => {
  const older = blockAt('old', t(10), t(12));
  assert.equal(findOverlaps(blockAt('new', t(10, 30), t(11)), [older], NOW).conflicts[0].kind, 'inside');
  assert.equal(findOverlaps(blockAt('new', t(10), t(12)), [older], NOW).blocked, true);
  assert.equal(findOverlaps(blockAt('new', t(10), t(11)), [older], NOW).blocked, true);
});

test('overlap: a new block that swallows an older one whole is refused', () => {
  const older = blockAt('old', t(10, 30), t(11));
  const r = findOverlaps(blockAt('new', t(10), t(12)), [older], NOW);
  assert.equal(r.conflicts[0].kind, 'covers');
  assert.equal(r.blocked, true);
});

test('overlap: one new block can touch two older blocks, one at each end', () => {
  const a = blockAt('a', t(9), t(10, 30));
  const b = blockAt('b', t(11, 30), t(13));
  const r = findOverlaps(blockAt('new', t(10), t(12)), [a, b], NOW);
  assert.deepEqual(r.conflicts.map((c) => c.kind), ['starts-inside', 'ends-inside']);
  assert.equal(r.blocked, false);
});

test('overlap: a block does not conflict with itself or with deleted blocks', () => {
  const same = blockAt('x', t(10), t(12));
  assert.equal(findOverlaps(same, [same], NOW).conflicts.length, 0);
  const gone = Object.assign(blockAt('g', t(10), t(12)), { is_deleted: true });
  assert.equal(findOverlaps(blockAt('new', t(10), t(12)), [gone], NOW).conflicts.length, 0);
});

test('overlap: a running block counts as ending now', () => {
  const run = blockAt('run', t(17), null, { entry_mode: 'timer' });
  assert.equal(findOverlaps(blockAt('new', t(17, 30), t(17, 45)), [run], NOW).conflicts[0].kind, 'inside');
  assert.equal(findOverlaps(blockAt('new', t(16), t(17, 30)), [run], NOW).conflicts[0].kind, 'ends-inside');
});

test('trimOlder shortens or moves the older block, and a synced one gets a new version', () => {
  const older = syncedAt(blockAt('old', t(10), t(12)), 1);
  const startsInside = blockAt('new', t(11), t(13));
  const cut = trimOlder(older, 'starts-inside', startsInside, NOW);
  assert.equal(cut.end_epoch, t(11));
  assert.equal(cut.version, 2);
  const endsInside = blockAt('new2', t(9), t(11));
  const moved = trimOlder(older, 'ends-inside', endsInside, NOW);
  assert.equal(moved.start_epoch, t(11));
  assert.equal(moved.version, 2);
  assert.throws(() => trimOlder(older, 'inside', startsInside, NOW));
  assert.throws(() => trimOlder(older, 'covers', startsInside, NOW));
});

// ------------------------------------------------------------ the PRD edit example (section 7)

test('PRD example: block B123 shortened four days later becomes version 2 and leaves version 1 as it was', () => {
  const b123 = syncedAt(make({ block_id: 'B123', start_epoch: t(2), end_epoch: t(3, 30), entry_mode: 'timer' }), 1);
  const rowsV1 = outgoingRows(b123);
  const shortened = editBlock(b123, { end_epoch: t(3) });
  const rowsV2 = outgoingRows(shortened);
  assert.equal(rowsV1[0].end_epoch, t(3, 30));
  assert.equal(rowsV2[0].end_epoch, t(3));
  assert.equal(rowsV2[0].version, 2);
  assert.notEqual(rowsV1[0].row_id, rowsV2[0].row_id);
});
