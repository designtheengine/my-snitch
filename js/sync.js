// sync.js: the rules for sending blocks to the Sheet (PRD section 8, spec section 9).
// Pure logic. The network call is passed in (fetchFn), so every rule here is tested in Node.
// db.js stores, app.js wires the Sync button. This file decides what to send, sends it in
// batches, and says which blocks the Sheet confirmed.

import { outgoingRows, isSyncEligible } from './model.js';
import { heldBlockIds, nightRoles } from './sleep.js';

// The Apps Script web address is public on purpose (log D19). Every call needs the secret key.
export const DEFAULT_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbycNn0l5bvxvsIT1u780SnBJmvwtExPJpni_HDTBPsQqYN6x2_HVZVqsXQ7nh42yKRGjA/exec';

export const BATCH_ROWS = 200;
export const LOCK_MS = 30000; // how long a running sync may hold its blocks
export const REQUEST_MS = 25000; // one request gives up before the lock does

// ---------------------------------------------------------------- the edit lock (log D56, Q11 option a)

// While a sync runs, the blocks in it cannot be edited or deleted, until the reply comes back or
// 30 seconds pass. That closes both gaps found in Phase 2: an edit that never reaches the Sheet, and
// a deleted block whose rows are already on their way. db.js asks the lock before every block write.
export function createLock(timeoutMs) {
  const limit = timeoutMs === undefined ? LOCK_MS : timeoutMs;
  let ids = null;
  let since = 0;
  function acquire(blockIds, nowMs) {
    ids = new Set(blockIds);
    since = nowMs;
  }
  function release() {
    ids = null;
  }
  function expired(nowMs) {
    return ids !== null && nowMs - since >= limit;
  }
  function blocks(blockIds, nowMs) {
    if (ids === null || expired(nowMs)) return false;
    return blockIds.some((id) => ids.has(id));
  }
  return { acquire: acquire, release: release, expired: expired, blocks: blocks };
}

export const syncLock = createLock();

// ---------------------------------------------------------------- what to send

// Dirty blocks that have ended, leaving out the running block and the blocks of a night whose
// wake is not logged. A deletion version is a normal dirty block, so it is sent too.
export function blocksToSend(blocks, nights) {
  const held = heldBlockIds(nights);
  return blocks
    .filter((b) => isSyncEligible(b, { wakeLogged: !held.has(b.block_id) }))
    .sort((a, b) => a.start_epoch - b.start_epoch || (a.block_id < b.block_id ? -1 : 1));
}

// Groups whole blocks into batches of at most `size` rows. A block is never split across two
// batches, so the reply for a batch always covers complete blocks.
// Each batch is {sent: [{block_id, version, row_ids}], rows: [...]}.
export function buildBatches(list, roles, size) {
  const limit = size === undefined ? BATCH_ROWS : size;
  const batches = [];
  let cur = { sent: [], rows: [] };
  for (const block of list) {
    const rows = outgoingRows(block, roles[block.block_id]);
    if (cur.rows.length > 0 && cur.rows.length + rows.length > limit) {
      batches.push(cur);
      cur = { sent: [], rows: [] };
    }
    cur.sent.push({ block_id: block.block_id, version: block.version, row_ids: rows.map((r) => r.row_id) });
    cur.rows.push(...rows);
  }
  if (cur.rows.length > 0) batches.push(cur);
  return batches;
}

// The JSON the script receives (spec section 9.2).
export function requestBody(args) {
  return {
    key: args.key,
    schema_version: 1,
    app_version: args.appVersion,
    sync_id: args.syncId,
    batch_no: args.batchNo,
    batch_total: args.batchTotal,
    rows: args.rows
  };
}

// Which blocks of a batch the Sheet confirmed. A row counts as delivered if it was saved or
// skipped as a duplicate. A block counts only when every one of its rows did.
export function settleBatch(batch, reply) {
  if (!reply || reply.ok !== true) return [];
  const done = new Set([].concat(reply.saved || [], reply.skipped || []));
  return batch.sent
    .filter((s) => s.row_ids.every((id) => done.has(id)))
    .map((s) => ({ block_id: s.block_id, version: s.version }));
}

// ---------------------------------------------------------------- sending

// One POST. text/plain avoids a browser preflight request, which Apps Script cannot answer
// (proven in Phase 0, Proof C). Never throws: a failure comes back as {ok: false, error}.
export async function sendBatch(url, body, fetchFn, timeoutMs) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => {
    if (controller) controller.abort();
  }, timeoutMs === undefined ? REQUEST_MS : timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined
    });
    const data = await res.json();
    if (!data || typeof data !== 'object') return { ok: false, error: 'bad_reply' };
    return data;
  } catch (err) {
    return { ok: false, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

// A plain sentence for each failure.
export function friendlyError(code) {
  if (code === 'network') return 'Could not reach the Sheet. Nothing was lost. Try again on a better connection.';
  if (code === 'bad_key') return 'The Sheet refused the key. Use Change key to enter it again.';
  if (code === 'busy') return 'The Sheet was busy. Try again in a moment.';
  if (code === 'timeout') return 'The Sheet took too long to answer. Nothing was marked as synced. Try again.';
  return 'The sync did not finish. Nothing was lost. Try again.';
}

// Runs one tap of the Sync button.
//   args: blocks, nights (everything stored), url, key, appVersion, syncId, fetchFn,
//         lock (default syncLock), nowMs (function, default Date.now), size, requestMs,
//         onAttempt (optional, async: called with [{block_id, version}] before the first request)
// It takes the lock for every block it sends, and leaves it held. The caller saves the delivered
// blocks as synced and THEN calls lock.release(), so nothing can slip in between.
// Returns {status, delivered, blockCount, error}
//   status 'nothing': nothing to send, no request was made, so the script logs no row (spec 10.5)
//   status 'ok':      every batch was confirmed
//   status 'failed':  stopped at an error. delivered holds the blocks of earlier confirmed batches.
// A timeout counts as a failed sync and delivers nothing, because after the lock ends an edit may
// have slipped in. Everything is sent again next time, and the script skips rows it already holds.
export async function runSync(args) {
  const lock = args.lock || syncLock;
  const nowMs = args.nowMs || (() => Date.now());
  const list = blocksToSend(args.blocks, args.nights);
  if (list.length === 0) return { status: 'nothing', delivered: [], blockCount: 0, error: null };
  const batches = buildBatches(list, nightRoles(args.nights), args.size);
  lock.acquire(list.map((b) => b.block_id), nowMs());
  // Before anything leaves the phone, the app notes which versions are about to be sent (log Q17). If the
  // note cannot be saved, nothing is sent, so a lost reply can never hide an edit.
  if (args.onAttempt) {
    try {
      await args.onAttempt(list.map((b) => ({ block_id: b.block_id, version: b.version })));
    } catch (err) {
      return { status: 'failed', delivered: [], blockCount: list.length, error: 'attempt' };
    }
  }
  const delivered = [];
  for (let i = 0; i < batches.length; i++) {
    const body = requestBody({
      key: args.key,
      appVersion: args.appVersion,
      syncId: args.syncId,
      batchNo: i + 1,
      batchTotal: batches.length,
      rows: batches[i].rows
    });
    const reply = await sendBatch(args.url, body, args.fetchFn, args.requestMs);
    if (lock.expired(nowMs())) return { status: 'failed', delivered: [], blockCount: list.length, error: 'timeout' };
    if (!reply.ok) return { status: 'failed', delivered: delivered, blockCount: list.length, error: reply.error || 'bad_reply' };
    const got = settleBatch(batches[i], reply);
    if (got.length !== batches[i].sent.length) {
      return { status: 'failed', delivered: delivered.concat(got), blockCount: list.length, error: 'bad_reply' };
    }
    delivered.push(...got);
  }
  return { status: 'ok', delivered: delivered, blockCount: list.length, error: null };
}
