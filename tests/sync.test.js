import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLock, blocksToSend, buildBatches, requestBody, settleBatch, sendBatch, runSync, friendlyError, BATCH_ROWS
} from '../js/sync.js';
import { saveBlock, saveBlocks, removeBlock, applySwitch, saveNight } from '../js/db.js';
import { syncLock } from '../js/sync.js';
import { createBlock, editBlock, markSynced, markAttempted, outgoingRows } from '../js/model.js';
import { newNight, updateNight, nightRoles, blocksFor } from '../js/sleep.js';
import { epochFromLocal } from '../js/time.js';

const IST = 330;
const t = (h, m = 0, date = '2026-10-14') => epochFromLocal(date, h, m, 0, IST);
const one = (cat, label) => [{ category: cat, label: label, share_pct: 100 }];

function block(id, startH, endH, over = {}) {
  return Object.assign(
    createBlock({
      block_id: id, start_epoch: t(startH), end_epoch: endH === null ? null : t(endH), tz_offset_min: IST,
      day: '2026-10-14', lines: one('admin', 'x'), entry_mode: 'late', now: t(startH)
    }),
    over
  );
}

// A fake Sheet. It answers like the script: saved for new row_ids, skipped for ones it holds.
function fakeSheet() {
  const held = new Set();
  const calls = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body);
    if (body.key !== 'GOOD') return { json: async () => ({ ok: false, error: 'bad_key' }) };
    const saved = [];
    const skipped = [];
    for (const r of body.rows) (held.has(r.row_id) ? skipped : saved).push(r.row_id);
    for (const id of saved) held.add(id);
    return { json: async () => ({ ok: true, saved: saved, skipped: skipped }) };
  };
  return { fetchFn: fetchFn, calls: calls, held: held };
}

const base = (extra) => Object.assign({ url: 'u', key: 'GOOD', appVersion: 'v17', syncId: 's-1', nights: [] }, extra);

// ---------------------------------------------------------------- what gets sent

test('only dirty, ended blocks are sent, oldest first', () => {
  const a = block('a', 9, 10);
  const b = block('b', 7, 8);
  const running = block('r', 11, null);
  const clean = markSynced(block('c', 12, 13), 1);
  const list = blocksToSend([a, running, clean, b], []);
  assert.deepEqual(list.map((x) => x.block_id), ['b', 'a']);
});

test('a deletion version of a synced block is sent', () => {
  const synced = markSynced(block('d', 9, 10), 1);
  const del = Object.assign({}, synced, { is_deleted: true, dirty: 1, version: 2 });
  const rows = outgoingRows(del);
  assert.equal(blocksToSend([del], []).length, 1);
  assert.equal(rows[0].is_deleted, true);
  assert.equal(rows[0].row_id, 'd:2:0');
});

test('night blocks wait until the wake is logged, then go with their role', () => {
  let n = 0;
  const makeId = () => 'n' + ++n;
  let night = newNight({ bedEpoch: t(23, 0, '2026-10-13'), offsetMin: IST, autoClosed: false, makeId: makeId });
  const open = blocksFor(night, {}, { now: t(23, 0, '2026-10-13') }).save;
  assert.equal(blocksToSend(open, [night]).length, 0);
  night = updateNight(night, { asleep_epoch: t(23, 30, '2026-10-13'), wake_epoch: t(7), wake_offset_min: IST });
  const made = blocksFor(night, Object.fromEntries(open.map((b) => [b.block_id, b])), { now: t(7) }).save;
  assert.equal(blocksToSend(made, [night]).length, 2);
  const roles = nightRoles([night]);
  assert.equal(roles[night.bed_block_id], 'before_sleep');
  assert.equal(roles[night.sleep_block_id], 'sleep');
  const rows = buildBatches(blocksToSend(made, [night]), roles)[0].rows;
  assert.deepEqual(rows.map((r) => r.night_role).sort(), ['before_sleep', 'sleep']);
});

test('night_role: not tracked gives one plain sleep block, no wake gives no roles, ordinary blocks are empty', () => {
  let n = 0;
  const makeId = () => 'm' + ++n;
  const night = updateNight(newNight({ bedEpoch: t(23, 0, '2026-10-13'), offsetMin: IST, autoClosed: false, makeId: makeId }),
    { wake_epoch: t(7), wake_offset_min: IST });
  const roles = nightRoles([night]);
  assert.equal(roles[night.bed_block_id], 'sleep');
  assert.equal(roles[night.sleep_block_id], undefined);
  const open = newNight({ bedEpoch: t(23), offsetMin: IST, autoClosed: false, makeId: makeId });
  assert.deepEqual(nightRoles([open]), {});
  assert.equal(outgoingRows(block('o', 9, 10))[0].night_role, '');
});

test('a split block becomes one row per line, with row ids block:version:line', () => {
  const split = Object.assign(block('s', 9, 10), {
    lines: [
      { category: 'admin', label: 'a', share_pct: 70 },
      { category: 'personal work', label: 'b', share_pct: 30 }
    ]
  });
  const rows = outgoingRows(split);
  assert.deepEqual(rows.map((r) => r.row_id), ['s:1:0', 's:1:1']);
  assert.deepEqual(rows.map((r) => r.share_pct), [70, 30]);
});

// ---------------------------------------------------------------- batching

test('batches keep whole blocks together and respect the row limit', () => {
  const two = (id, h) => Object.assign(block(id, h, h + 1), {
    lines: [{ category: 'admin', label: '', share_pct: 50 }, { category: 'learning', label: '', share_pct: 50 }]
  });
  const list = [two('a', 1), two('b', 3), two('c', 5)];
  const batches = buildBatches(list, {}, 5);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches.map((b) => b.rows.length), [4, 2]);
  assert.deepEqual(batches[0].sent.map((s) => s.block_id), ['a', 'b']);
  assert.equal(BATCH_ROWS, 200);
});

test('the request body matches the spec', () => {
  const body = requestBody({ key: 'K', appVersion: 'v17', syncId: 's-9', batchNo: 2, batchTotal: 3, rows: [] });
  assert.deepEqual(Object.keys(body), ['key', 'schema_version', 'app_version', 'sync_id', 'batch_no', 'batch_total', 'rows']);
  assert.equal(body.batch_no, 2);
});

test('settleBatch: saved and skipped both count, a half-confirmed block does not', () => {
  const batch = {
    sent: [
      { block_id: 'a', version: 1, row_ids: ['a:1:0'] },
      { block_id: 'b', version: 2, row_ids: ['b:2:0', 'b:2:1'] }
    ]
  };
  const reply = { ok: true, saved: ['a:1:0', 'b:2:0'], skipped: [] };
  assert.deepEqual(settleBatch(batch, reply), [{ block_id: 'a', version: 1 }]);
  const full = { ok: true, saved: ['b:2:0'], skipped: ['a:1:0', 'b:2:1'] };
  assert.equal(settleBatch(batch, full).length, 2);
  assert.deepEqual(settleBatch(batch, { ok: false, error: 'bad_key' }), []);
});

// ---------------------------------------------------------------- the whole run

test('a sync delivers every block, and syncing twice sends nothing the second time (check 6)', async () => {
  const sheet = fakeSheet();
  const blocks = [block('a', 9, 10), block('b', 11, 12)];
  const lock = createLock();
  const first = await runSync(base({ blocks: blocks, fetchFn: sheet.fetchFn, lock: lock }));
  assert.equal(first.status, 'ok');
  assert.equal(first.delivered.length, 2);
  assert.equal(sheet.held.size, 2);
  const marked = blocks.map((b) => markSynced(b, first.delivered.find((d) => d.block_id === b.block_id).version));
  lock.release();
  const second = await runSync(base({ blocks: marked, fetchFn: sheet.fetchFn, lock: lock }));
  assert.equal(second.status, 'nothing');
  assert.equal(sheet.calls.length, 1);
});

test('nothing to send makes no request at all', async () => {
  let called = false;
  const res = await runSync(base({ blocks: [markSynced(block('a', 9, 10), 1)], fetchFn: async () => { called = true; } }));
  assert.equal(res.status, 'nothing');
  assert.equal(called, false);
});

test('a retry after a lost reply sends the same row ids and the Sheet skips them, so no duplicates (check 6)', async () => {
  const sheet = fakeSheet();
  const blocks = [block('a', 9, 10)];
  // The Sheet saved the row, but the reply never arrived.
  const lostReply = async (u, o) => { await sheet.fetchFn(u, o); throw new Error('connection dropped'); };
  const lock = createLock();
  const failed = await runSync(base({ blocks: blocks, fetchFn: lostReply, lock: lock }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'network');
  assert.deepEqual(failed.delivered, []);
  lock.release();
  const retry = await runSync(base({ blocks: blocks, fetchFn: sheet.fetchFn, lock: lock }));
  assert.equal(retry.status, 'ok');
  assert.equal(sheet.held.size, 1);
  assert.equal(sheet.calls[1].rows[0].row_id, sheet.calls[0].rows[0].row_id);
});

test('a wrong key is refused and nothing is marked synced (check 12)', async () => {
  const sheet = fakeSheet();
  const res = await runSync(base({ blocks: [block('a', 9, 10)], key: 'WRONG', fetchFn: sheet.fetchFn, lock: createLock() }));
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'bad_key');
  assert.deepEqual(res.delivered, []);
  assert.match(friendlyError('bad_key'), /refused the key/);
});

test('airplane mode: the network failure leaves everything unsynced (check 5)', async () => {
  const res = await runSync(base({
    blocks: [block('a', 9, 10)], fetchFn: async () => { throw new TypeError('Load failed'); }, lock: createLock()
  }));
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'network');
  assert.deepEqual(res.delivered, []);
});

test('a broken reply is a failure, not a crash', async () => {
  const bad = await sendBatch('u', {}, async () => ({ json: async () => { throw new Error('not json'); } }));
  assert.deepEqual(bad, { ok: false, error: 'network' });
  const odd = await sendBatch('u', {}, async () => ({ json: async () => null }));
  assert.deepEqual(odd, { ok: false, error: 'bad_reply' });
});

test('a failure in the second batch keeps the first batch as delivered', async () => {
  const sheet = fakeSheet();
  let n = 0;
  const flaky = async (u, o) => {
    n++;
    if (n === 2) throw new Error('dropped');
    return sheet.fetchFn(u, o);
  };
  const blocks = [block('a', 1, 2), block('b', 3, 4)];
  const res = await runSync(base({ blocks: blocks, fetchFn: flaky, lock: createLock(), size: 1 }));
  assert.equal(res.status, 'failed');
  assert.deepEqual(res.delivered, [{ block_id: 'a', version: 1 }]);
  assert.equal(sheet.calls.length, 1);
});

test('a night\'s blocks that are still held are never sent', async () => {
  let n = 0;
  const makeId = () => 'h' + ++n;
  const night = newNight({ bedEpoch: t(23), offsetMin: IST, autoClosed: false, makeId: makeId });
  const made = blocksFor(night, {}, { now: t(23) }).save;
  const res = await runSync(base({ blocks: made, nights: [night], fetchFn: async () => { throw new Error('should not be called'); } }));
  assert.equal(res.status, 'nothing');
});

// ---------------------------------------------------------------- sent but not confirmed (log Q17)

test('onAttempt is told what is about to be sent, before the first request', async () => {
  const order = [];
  const sheet = fakeSheet();
  const res = await runSync(base({
    blocks: [block('a', 9, 10), block('b', 11, 12)],
    lock: createLock(),
    fetchFn: async (u, o) => { order.push('request'); return sheet.fetchFn(u, o); },
    onAttempt: async (sending) => { order.push('attempt:' + sending.map((s) => s.block_id + 'v' + s.version).join(',')); }
  }));
  assert.equal(res.status, 'ok');
  assert.deepEqual(order, ['attempt:av1,bv1', 'request']);
});

test('if the attempt note cannot be saved, nothing is sent', async () => {
  let called = false;
  const res = await runSync(base({
    blocks: [block('a', 9, 10)],
    lock: createLock(),
    fetchFn: async () => { called = true; },
    onAttempt: async () => { throw new Error('disk full'); }
  }));
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'attempt');
  assert.equal(called, false);
});

test('a lost reply, then an edit, then a retry: the Sheet receives the edit (log Q17)', async () => {
  const sheet = fakeSheet();
  const lock = createLock();
  let b = block('a', 9, 10);
  // First tap: the Sheet saves the block, but the reply never reaches the phone.
  const lostAfterSaving = async (u, o) => {
    await sheet.fetchFn(u, o);
    throw new Error('reply lost');
  };
  const first = await runSync(base({ blocks: [b], fetchFn: lostAfterSaving, lock: lock }));
  assert.equal(first.status, 'failed');
  b = markAttempted(b, 1); // what onAttempt saves in the app
  // The block is edited before the retry.
  b = editBlock(b, { end_epoch: t(10, 30) });
  assert.equal(b.version, 2);
  const retry = await runSync(base({ blocks: [b], fetchFn: sheet.fetchFn, lock: lock }));
  assert.equal(retry.status, 'ok');
  const last = sheet.calls[sheet.calls.length - 1];
  assert.equal(last.rows[0].version, 2);
  assert.equal(last.rows[0].end_epoch, t(10, 30));
  assert.equal(sheet.held.has('a:2:0'), true, 'the edit is in the Sheet as version 2');
});

// ---------------------------------------------------------------- the lock (log D56)

test('the lock blocks only the blocks in the sync, and lets go on release', () => {
  const lock = createLock(30000);
  lock.acquire(['a', 'b'], 1000);
  assert.equal(lock.blocks(['a'], 2000), true);
  assert.equal(lock.blocks(['z'], 2000), false);
  assert.equal(lock.blocks(['z', 'b'], 2000), true);
  lock.release();
  assert.equal(lock.blocks(['a'], 2000), false);
});

test('the lock ends by itself after 30 seconds', () => {
  const lock = createLock(30000);
  lock.acquire(['a'], 0);
  assert.equal(lock.blocks(['a'], 29999), true);
  assert.equal(lock.blocks(['a'], 30000), false);
  assert.equal(lock.expired(30000), true);
});

test('while a sync holds a block, db writes to it are refused and other blocks are not', async () => {
  const b = block('a', 9, 10);
  syncLock.acquire(['a'], Date.now());
  try {
    for (const attempt of [
      () => saveBlock(null, editBlock(markSynced(b, 1), { end_epoch: t(10, 30) })),
      () => saveBlocks(null, [{ block: b }]),
      () => removeBlock(null, 'a'),
      () => applySwitch(null, { action: 'update', block: b }, block('n', 11, null)),
      () => saveNight(null, { stop: null, save: [b], remove: [] }),
      () => saveNight(null, { stop: null, save: [], remove: ['a'] })
    ]) {
      await assert.rejects(attempt, (err) => err.code === 'sync_locked');
    }
  } finally {
    syncLock.release();
  }
});

test('a slow sync times out, delivers nothing, and the blocks are sent again next time', async () => {
  let clock = 0;
  const lock = createLock(30000);
  const slow = async () => {
    clock = 31000;
    return { json: async () => ({ ok: true, saved: ['a:1:0'], skipped: [] }) };
  };
  const res = await runSync(base({ blocks: [block('a', 9, 10)], fetchFn: slow, lock: lock, nowMs: () => clock }));
  assert.equal(res.status, 'failed');
  assert.equal(res.error, 'timeout');
  assert.deepEqual(res.delivered, []);
  assert.match(friendlyError('timeout'), /too long/);
});
