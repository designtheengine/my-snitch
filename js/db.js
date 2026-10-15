// db.js: IndexedDB storage for my snitch. This is the only file that touches the database.
// It only stores and fetches. The rules (versioning, split, overlap) live in model.js.
//
// The database starts at version 1. Every later change must be additive: new stores,
// new indexes, new fields. An upgrade step never deletes a store or a field.

import { bumpLabel } from './labels.js';
import { markSynced } from './model.js';
import { syncLock } from './sync.js';

export const DB_NAME = 'mysnitch';
export const DB_VERSION = 1;

// The nine starting categories take colour slots 1 to 9 in this order (spec section 6.7).
export const STARTING_CATEGORIES = [
  'office work',
  'personal work',
  'admin',
  'learning',
  'social',
  'sleep',
  'eating',
  'freshening up',
  'doomscrolling'
];

export const DEFAULT_SETTINGS = {
  theme: 'auto',
  gap_threshold_min: 5,
  schema_version: 1
};

// ---------------------------------------------------------------- plumbing

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Runs a write transaction. work(tx, setResult, fail) must start its requests right away
// and use callbacks, never await, because some iPhone versions close a transaction
// that is waited on mid-way. The returned promise settles when the transaction ends:
// it resolves with the value given to setResult, or rejects if anything failed.
// Whatever fails, nothing from the transaction is saved.
function writeTx(db, stores, work) {
  return new Promise((resolve, reject) => {
    let result;
    let failure = null;
    const tx = db.transaction(stores, 'readwrite');
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure || tx.error || new Error('transaction aborted'));
    const fail = (err) => {
      failure = err;
      try {
        tx.abort();
      } catch (e) {
        // already finished
      }
    };
    try {
      work(tx, (value) => { result = value; }, fail);
    } catch (e) {
      fail(e);
    }
  });
}

// While a sync is running, the blocks in it cannot be changed (log D56, Q11 option a). Every write that
// touches a block asks here first. The caller gets a failed result, and the screens already show
// "Nothing was changed. Try again." for that. The lock ends when the reply arrives or after 30 seconds.
function lockedWrite(blockIds) {
  if (!syncLock.blocks(blockIds, Date.now())) return null;
  const err = new Error('a sync is running, try again in a few seconds');
  err.code = 'sync_locked';
  return Promise.reject(err);
}

// Adds or bumps the label of every line, inside the given transaction.
function bumpLabelsIn(tx, lines, nowEpoch) {
  const labels = tx.objectStore('labels');
  const seen = new Set();
  for (const line of lines) {
    const probe = bumpLabel(undefined, line.label, nowEpoch);
    if (!probe || seen.has(probe.key)) continue;
    seen.add(probe.key);
    const read = labels.get(probe.key);
    read.onsuccess = () => {
      labels.put(bumpLabel(read.result, line.label, nowEpoch));
    };
  }
}

// Opens the database, creating it on first use. name is only different in the smoke test.
export function openDb(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('blocks')) {
        const blocks = db.createObjectStore('blocks', { keyPath: 'block_id' });
        blocks.createIndex('start_epoch', 'start_epoch');
        blocks.createIndex('day', 'day');
        blocks.createIndex('dirty', 'dirty');
        blocks.createIndex('running', 'running');
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('labels')) {
        db.createObjectStore('labels', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('sleep')) {
        db.createObjectStore('sleep', { keyPath: 'night_id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('database is blocked by another open tab'));
  });
}

// Deletes a whole database. Only the smoke test uses this.
export function deleteDb(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}

// ---------------------------------------------------------------- blocks

export async function getBlock(db, blockId) {
  const tx = db.transaction('blocks', 'readonly');
  return requestToPromise(tx.objectStore('blocks').get(blockId));
}

export async function getAllBlocks(db) {
  const tx = db.transaction('blocks', 'readonly');
  return requestToPromise(tx.objectStore('blocks').getAll());
}

// Blocks whose latest version is not in the Sheet yet.
export async function getDirtyBlocks(db) {
  const tx = db.transaction('blocks', 'readonly');
  return requestToPromise(tx.objectStore('blocks').index('dirty').getAll(1));
}

// The single running block, or undefined.
export async function getRunningBlock(db) {
  const tx = db.transaction('blocks', 'readonly');
  return requestToPromise(tx.objectStore('blocks').index('running').get(1));
}

export async function getBlocksByDay(db, day) {
  const tx = db.transaction('blocks', 'readonly');
  return requestToPromise(tx.objectStore('blocks').index('day').getAll(day));
}

// Blocks that start between two epochs, from included, to excluded.
export async function getBlocksStartingBetween(db, fromEpoch, toEpoch) {
  const tx = db.transaction('blocks', 'readonly');
  const range = IDBKeyRange.bound(fromEpoch, toEpoch, false, true);
  return requestToPromise(tx.objectStore('blocks').index('start_epoch').getAll(range));
}

// Saves a block. In the same transaction, every label on its lines is added or bumped,
// so a block and its label counts are saved together or not at all.
// Pass bumpLabels false when an edit leaves the labels as they were.
export function saveBlock(db, block, opts) {
  const blocked = lockedWrite([block.block_id]);
  if (blocked) return blocked;
  const nowEpoch = opts && opts.now !== undefined ? opts.now : block.logged_at;
  const bump = !(opts && opts.bumpLabels === false);
  return writeTx(db, ['blocks', 'labels'], (tx) => {
    tx.objectStore('blocks').put(block);
    if (bump) bumpLabelsIn(tx, block.lines, nowEpoch);
  });
}

// Saves several blocks in one transaction, all or nothing. A late entry can trim older blocks
// and save new ones at once, and a half-finished result would leave the day wrong.
// items: [{block, bumpLabels}]. bumpLabels defaults to true. Trimmed older blocks pass false.
// A label shared by several new blocks (the stretches of a fill-around) is counted once.
export function saveBlocks(db, items, opts) {
  const blocked = lockedWrite(items.map((i) => i.block.block_id));
  if (blocked) return blocked;
  const nowEpoch = opts && opts.now !== undefined ? opts.now : Math.floor(Date.now() / 1000);
  return writeTx(db, ['blocks', 'labels'], (tx) => {
    const blocks = tx.objectStore('blocks');
    const lines = [];
    for (const item of items) {
      blocks.put(item.block);
      if (item.bumpLabels !== false) lines.push(...item.block.lines);
    }
    bumpLabelsIn(tx, lines, nowEpoch);
  });
}

// Removes a block record. Only for blocks that were never synced.
export function removeBlock(db, blockId) {
  const blocked = lockedWrite([blockId]);
  if (blocked) return blocked;
  return writeTx(db, 'blocks', (tx) => {
    tx.objectStore('blocks').delete(blockId);
  });
}

// Stops one running block and starts another in one transaction, so there is never
// a moment with two running blocks or none. stopResult comes from model.stopBlock,
// or is null when nothing was running. nextBlock comes from model.createBlock.
export function applySwitch(db, stopResult, nextBlock, opts) {
  const ids = [nextBlock.block_id];
  if (stopResult && stopResult.action === 'remove') ids.push(stopResult.block_id);
  if (stopResult && stopResult.action === 'update') ids.push(stopResult.block.block_id);
  const blocked = lockedWrite(ids);
  if (blocked) return blocked;
  const nowEpoch = opts && opts.now !== undefined ? opts.now : nextBlock.logged_at;
  return writeTx(db, ['blocks', 'labels'], (tx) => {
    const blocks = tx.objectStore('blocks');
    if (stopResult && stopResult.action === 'remove') blocks.delete(stopResult.block_id);
    if (stopResult && stopResult.action === 'update') blocks.put(stopResult.block);
    blocks.put(nextBlock);
    // Labels the person typed on the End screen count too. opts.bumpEnded is set only then.
    const counted = opts && opts.bumpEnded && stopResult && stopResult.action === 'update'
      ? nextBlock.lines.concat(stopResult.block.lines)
      : nextBlock.lines;
    bumpLabelsIn(tx, counted, nowEpoch);
  });
}

// After the Sheet confirms blocks. delivered is [{block_id, version}] from sync.js. Each block is marked
// as synced up to the version that was sent, and stays dirty if it moved on meanwhile (model.markSynced).
// This write is not checked against the lock, because the sync itself holds it until this is done.
export function markDelivered(db, delivered) {
  return writeTx(db, 'blocks', (tx) => {
    const store = tx.objectStore('blocks');
    for (const d of delivered) {
      const read = store.get(d.block_id);
      read.onsuccess = () => {
        if (read.result) store.put(markSynced(read.result, d.version));
      };
    }
  });
}

// ---------------------------------------------------------------- labels

export async function getAllLabels(db) {
  const tx = db.transaction('labels', 'readonly');
  return requestToPromise(tx.objectStore('labels').getAll());
}

// ---------------------------------------------------------------- categories

export async function getCategories(db) {
  const tx = db.transaction('categories', 'readonly');
  const all = await requestToPromise(tx.objectStore('categories').getAll());
  return all.sort((a, b) => a.sort_order - b.sort_order);
}

// Creates the nine starting categories the first time, and does nothing after that.
export function seedCategories(db, nowEpoch) {
  return writeTx(db, 'categories', (tx) => {
    const store = tx.objectStore('categories');
    const count = store.count();
    count.onsuccess = () => {
      if (count.result !== 0) return;
      STARTING_CATEGORIES.forEach((name, i) => {
        store.add({ name: name, archived: false, sort_order: i + 1, color: i + 1, created_at: nowEpoch });
      });
    };
  });
}

// Adds a category. Names are unique ignoring case. color is a slot number from 1 to 9.
// The colour of a tenth and later category is an open decision (Q9), so the caller picks it.
export function addCategory(db, name, color, nowEpoch) {
  const clean = String(name).trim();
  if (!clean) return Promise.reject(new Error('category name is empty'));
  if (!Number.isInteger(color) || color < 1 || color > 9) {
    return Promise.reject(new Error('colour slot must be 1 to 9'));
  }
  return writeTx(db, 'categories', (tx, setResult, fail) => {
    const store = tx.objectStore('categories');
    const read = store.getAll();
    read.onsuccess = () => {
      const all = read.result;
      if (all.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
        fail(new Error('a category named "' + clean + '" already exists'));
        return;
      }
      const top = all.reduce((m, c) => Math.max(m, c.sort_order), 0);
      const record = { name: clean, archived: false, sort_order: top + 1, color: color, created_at: nowEpoch };
      const add = store.add(record);
      add.onsuccess = () => setResult(Object.assign({ id: add.result }, record));
    };
  });
}

// Renaming, archiving and reordering all go through here. The colour slot never changes on rename.
export function updateCategory(db, id, changes) {
  return writeTx(db, 'categories', (tx, setResult, fail) => {
    const store = tx.objectStore('categories');
    const read = store.get(id);
    read.onsuccess = () => {
      if (!read.result) {
        fail(new Error('category not found'));
        return;
      }
      const next = Object.assign({}, read.result, changes, { id: read.result.id });
      store.put(next);
      setResult(next);
    };
  });
}

// ---------------------------------------------------------------- sleep

export function putSleep(db, record) {
  return writeTx(db, 'sleep', (tx) => {
    tx.objectStore('sleep').put(record);
  });
}

// Saves one sleep plan (from sleep.js) in a single transaction, all or nothing: the night record,
// its blocks, a running block that the plan ends, and any blocks or record it removes.
// Labels you typed in the morning check count for suggestions (plan.bump), but the default
// "trying to sleep" never does, because the caller leaves it out of plan.bump.
export function saveNight(db, plan) {
  const ids = plan.save.map((b) => b.block_id).concat(plan.remove);
  if (plan.stop && plan.stop.action === 'remove') ids.push(plan.stop.block_id);
  if (plan.stop && plan.stop.action === 'update') ids.push(plan.stop.block.block_id);
  const blocked = lockedWrite(ids);
  if (blocked) return blocked;
  return writeTx(db, ['blocks', 'sleep', 'labels'], (tx) => {
    const blocks = tx.objectStore('blocks');
    const stop = plan.stop;
    if (stop && stop.action === 'remove') blocks.delete(stop.block_id);
    if (stop && stop.action === 'update') blocks.put(stop.block);
    for (const b of plan.save) blocks.put(b);
    for (const id of plan.remove) blocks.delete(id);
    const nights = tx.objectStore('sleep');
    if (plan.night) nights.put(plan.night);
    if (plan.deleteNightId) nights.delete(plan.deleteNightId);
    if (plan.bump && plan.bump.lines.length) bumpLabelsIn(tx, plan.bump.lines, plan.bump.now);
  });
}

export async function getSleep(db, nightId) {
  const tx = db.transaction('sleep', 'readonly');
  return requestToPromise(tx.objectStore('sleep').get(nightId));
}

export async function getAllSleep(db) {
  const tx = db.transaction('sleep', 'readonly');
  return requestToPromise(tx.objectStore('sleep').getAll());
}

// ---------------------------------------------------------------- settings

export async function getSetting(db, key) {
  const tx = db.transaction('settings', 'readonly');
  const row = await requestToPromise(tx.objectStore('settings').get(key));
  if (row) return row.value;
  return Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key) ? DEFAULT_SETTINGS[key] : undefined;
}

export function setSetting(db, key, value) {
  return writeTx(db, 'settings', (tx) => {
    tx.objectStore('settings').put({ key: key, value: value });
  });
}
