// model.js: pure block rules for my snitch.
// No DOM, no storage. Functions take a block and return a new one. They never change the input.
// A block record has the fields in technical spec section 4.1.

import { toIso } from './time.js';
import { MAX_LABEL } from './labels.js';

export const SCHEMA_VERSION = 1;
export const ENTRY_MODES = ['timer', 'manual', 'prompt', 'late', 'sleep'];

// ---------------------------------------------------------------- split shares

// Splits a whole number (total) across weights, in proportion, so the parts add up
// to the total exactly. Ties go to the earlier item.
export function largestRemainder(total, weights) {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('weights must add up to more than zero');
  const exact = weights.map((w) => (total * w) / sum);
  const parts = exact.map(Math.floor);
  const left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i: i, r: x - parts[i] }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; k < left; k++) parts[order[k].i]++;
  return parts;
}

// Like largestRemainder, but every part is at least 1. A part that comes out
// at 0 borrows one from the largest part. Needs total >= weights.length.
export function fitShares(total, weights) {
  const parts = largestRemainder(total, weights);
  for (let k = 0; k < parts.length; k++) {
    while (parts[k] < 1) {
      let big = 0;
      for (let j = 1; j < parts.length; j++) if (parts[j] > parts[big]) big = j;
      parts[big]--;
      parts[k]++;
    }
  }
  return parts;
}

// The highest value one slider can reach when there are n lines.
export function maxShare(n) {
  return 100 - (n - 1);
}

// Moves one slider to a new value. The other lines share what is left, in proportion
// to their current shares. The total stays 100 and no line drops below 1.
export function moveSlider(shares, index, value) {
  const n = shares.length;
  if (n === 1) return [100];
  const v = Math.min(Math.max(Math.round(value), 1), maxShare(n));
  const others = [];
  shares.forEach((s, i) => {
    if (i !== index) others.push({ s: s, i: i });
  });
  const alloc = fitShares(100 - v, others.map((o) => o.s));
  const out = new Array(n);
  out[index] = v;
  others.forEach((o, k) => {
    out[o.i] = alloc[k];
  });
  return out;
}

// Adds a line. The new line takes a fair share, and the others shrink in proportion.
// The new line goes last.
export function addLine(shares) {
  const n = shares.length;
  if (n >= 100) throw new Error('a block cannot have more than 100 lines');
  const newShare = Math.max(1, Math.round(100 / (n + 1)));
  return fitShares(100 - newShare, shares).concat([newShare]);
}

// Removes a line. The rest grow in proportion to fill 100.
export function removeLine(shares, index) {
  if (shares.length <= 1) throw new Error('a block needs at least one line');
  const rest = shares.filter((s, i) => i !== index);
  return fitShares(100, rest);
}

// Minutes shown beside each slider. They always add up to the block's whole minutes.
// 90 minutes at 70 and 30 gives [63, 27].
export function displayMinutes(durationSec, shares) {
  return largestRemainder(Math.round(durationSec / 60), shares);
}

// Exact minutes for one line, the same way the Sheet works them out.
export function lineMinutes(durationSec, share) {
  return (durationSec * share) / 6000;
}

export function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('a block needs at least one line');
  let total = 0;
  for (const line of lines) {
    if (typeof line.category !== 'string' || line.category.trim() === '') {
      throw new Error('every line needs a category');
    }
    if (typeof line.label !== 'string') throw new Error('label must be text, empty is fine');
    if (Array.from(line.label).length > MAX_LABEL) throw new Error('label is longer than ' + MAX_LABEL + ' characters');
    if (!Number.isInteger(line.share_pct) || line.share_pct < 1 || line.share_pct > 100) {
      throw new Error('share must be a whole number from 1 to 100');
    }
    total += line.share_pct;
  }
  if (total !== 100) throw new Error('shares must add up to 100, got ' + total);
}

function copyLines(lines) {
  return lines.map((l) => ({ category: l.category, label: l.label, share_pct: l.share_pct }));
}

function sameLines(a, b) {
  return JSON.stringify(copyLines(a)) === JSON.stringify(copyLines(b));
}

// ---------------------------------------------------------------- creating blocks

function validateTimes(block) {
  if (!Number.isInteger(block.start_epoch)) throw new Error('start time is missing');
  if (block.end_epoch !== null && !Number.isInteger(block.end_epoch)) throw new Error('end time is not a number');
  if (block.end_epoch !== null && block.end_epoch <= block.start_epoch) {
    throw new Error('end must be after start');
  }
}

// args: block_id, start_epoch, end_epoch (null for a running block), tz_offset_min,
// day, lines, entry_mode, now (epoch seconds, becomes logged_at)
export function createBlock(args) {
  if (!args.block_id) throw new Error('block_id is missing');
  if (!ENTRY_MODES.includes(args.entry_mode)) throw new Error('unknown entry mode: ' + args.entry_mode);
  validateLines(args.lines);
  const end = args.end_epoch === undefined ? null : args.end_epoch;
  const block = {
    block_id: args.block_id,
    version: 1,
    synced_version: 0,
    dirty: 1,
    start_epoch: args.start_epoch,
    end_epoch: end,
    tz_offset_min: args.tz_offset_min,
    day: args.day,
    lines: copyLines(args.lines),
    is_deleted: false,
    entry_mode: args.entry_mode,
    logged_at: args.now,
    running: end === null ? 1 : 0
  };
  validateTimes(block);
  return block;
}

// ---------------------------------------------------------------- versioning

const EDITABLE = ['start_epoch', 'end_epoch', 'tz_offset_min', 'day', 'lines'];

// The bump rule (spec section 5): a block that matches what the Sheet holds gets a new
// version. A block that is already ahead of the Sheet keeps its version, so repeated
// edits collapse into one. A block never synced stays at version 1.
function bumped(block) {
  if (block.synced_version >= 1 && block.version === block.synced_version) {
    return block.synced_version + 1;
  }
  return block.version;
}

// changes may hold start_epoch, end_epoch, tz_offset_min, day and lines.
// If nothing really changes, the same block comes back and no version is created.
export function editBlock(block, changes) {
  if (block.is_deleted) throw new Error('a deleted block cannot be edited');
  for (const key of Object.keys(changes)) {
    if (!EDITABLE.includes(key)) throw new Error('field cannot be edited: ' + key);
  }
  const next = Object.assign({}, block, changes);
  if (changes.lines) {
    validateLines(changes.lines);
    next.lines = copyLines(changes.lines);
  } else {
    next.lines = copyLines(block.lines);
  }
  validateTimes(next);
  const unchanged =
    next.start_epoch === block.start_epoch &&
    next.end_epoch === block.end_epoch &&
    next.tz_offset_min === block.tz_offset_min &&
    next.day === block.day &&
    sameLines(next.lines, block.lines);
  if (unchanged) return block;
  next.running = next.end_epoch === null ? 1 : 0;
  next.dirty = 1;
  next.version = bumped(block);
  return next;
}

// Returns {action, ...}
//   remove: never synced, so the record goes and nothing is ever sent. Carries block_id.
//   update: synced, so a deletion version is saved. Carries block.
//   none:   already deleted.
export function deleteBlock(block) {
  if (block.synced_version === 0) return { action: 'remove', block_id: block.block_id };
  if (block.is_deleted) return { action: 'none', block: block };
  const next = Object.assign({}, block, { is_deleted: true, dirty: 1, running: 0 });
  next.lines = copyLines(block.lines);
  next.version = bumped(block);
  return { action: 'update', block: next };
}

// After the Sheet confirms versionSent. The block stays dirty if it moved on meanwhile.
export function markSynced(block, versionSent) {
  const synced = Math.max(block.synced_version, versionSent);
  return Object.assign({}, block, {
    synced_version: synced,
    dirty: block.version > synced ? 1 : 0
  });
}

// Running blocks are never synced. Night sleep blocks wait until the wake is logged.
export function isSyncEligible(block, opts) {
  const wakeLogged = opts && opts.wakeLogged !== undefined ? opts.wakeLogged : true;
  if (block.dirty !== 1) return false;
  if (block.running === 1 || block.end_epoch === null) return false;
  if (block.entry_mode === 'sleep' && !wakeLogged) return false;
  return true;
}

// One row per line. The row_id is block_id:version:line_index, so a retry after a
// failed sync produces the same ids and the script skips rows it already holds.
// role is the block's part in a night: 'before_sleep', 'sleep' or empty for an ordinary block.
// It goes to the Sheet as the night_role column, which lets the sleep latency tab find the stretch
// between going to bed and falling asleep (log Q15, decided 15 Oct 2026).
export function outgoingRows(block, role) {
  if (block.end_epoch === null) throw new Error('a running block cannot be synced');
  const tz = block.tz_offset_min;
  return block.lines.map((line, i) => ({
    row_id: block.block_id + ':' + block.version + ':' + i,
    block_id: block.block_id,
    version: block.version,
    schema_version: SCHEMA_VERSION,
    start_ts: toIso(block.start_epoch, tz),
    end_ts: toIso(block.end_epoch, tz),
    start_epoch: block.start_epoch,
    end_epoch: block.end_epoch,
    day: block.day,
    category: line.category,
    label: line.label,
    share_pct: line.share_pct,
    is_deleted: block.is_deleted,
    entry_mode: block.entry_mode,
    logged_at: toIso(block.logged_at, tz),
    night_role: role || ''
  }));
}

// ---------------------------------------------------------------- timer

// Elapsed time is always now minus the saved start, so it stays exact when the app is closed.
export function elapsedSeconds(block, nowEpoch) {
  const end = block.end_epoch === null ? nowEpoch : block.end_epoch;
  return Math.max(0, end - block.start_epoch);
}

// Stops a running block. A running block was never synced, so it is closed in place.
// If it ran for less than a second there is nothing to keep, so it is removed.
// Returns the same shape as deleteBlock: {action: 'remove', block_id} or {action: 'update', block}.
export function stopBlock(block, nowEpoch) {
  if (block.running !== 1) throw new Error('this block is not running');
  if (nowEpoch <= block.start_epoch) return { action: 'remove', block_id: block.block_id };
  const next = Object.assign({}, block, { end_epoch: nowEpoch, running: 0, dirty: 1 });
  next.lines = copyLines(block.lines);
  return { action: 'update', block: next };
}

// Ends a running block at endEpoch with the lines the person confirmed on the End screen,
// which may be several activities with shares (decided 11 Oct 2026). Like stopBlock, a block
// that ran for under a second is removed. Returns {action: 'remove', block_id} or {action: 'update', block}.
export function finishBlock(block, endEpoch, lines) {
  if (block.running !== 1) throw new Error('this block is not running');
  if (endEpoch <= block.start_epoch) return { action: 'remove', block_id: block.block_id };
  validateLines(lines);
  const next = Object.assign({}, block, { end_epoch: endEpoch, running: 0, dirty: 1 });
  next.lines = copyLines(lines);
  return { action: 'update', block: next };
}

// Starts a new running block at "now" and closes the one that was running at the same moment.
// running may be null. newArgs: block_id, tz_offset_min, day, lines.
// endLines (optional) are the confirmed lines of the block being closed, from the End screen.
export function switchBlock(running, newArgs, nowEpoch, endLines) {
  let previous = null;
  if (running) previous = endLines ? finishBlock(running, nowEpoch, endLines) : stopBlock(running, nowEpoch);
  const next = createBlock(
    Object.assign({}, newArgs, { start_epoch: nowEpoch, end_epoch: null, entry_mode: 'timer', now: nowEpoch })
  );
  return { previous: previous, next: next };
}

// ---------------------------------------------------------------- overlap

// Compares a new or edited block (candidate) with every other block.
// A block that is still running counts as ending at nowEpoch.
// Each conflict has a kind:
//   starts-inside: the candidate starts inside an older block. Offer to shorten the older block's end.
//   ends-inside:   the candidate ends inside an older block. Offer to move the older block's start.
//   inside:        the candidate sits fully inside an older block. Refuse.
//   covers:        the candidate swallows an older block whole. Fill around it (decided 11 Oct 2026,
//                  log D29): the older block is left alone and the candidate is saved around it.
//                  See stretchesAround and planLateSave below.
// blocked is true only when a conflict is inside. A covers conflict never blocks a save.
export function findOverlaps(candidate, blocks, nowEpoch) {
  const cStart = candidate.start_epoch;
  const cEnd = candidate.end_epoch === null ? nowEpoch : candidate.end_epoch;
  const conflicts = [];
  for (const b of blocks) {
    if (b.is_deleted || b.block_id === candidate.block_id) continue;
    const bStart = b.start_epoch;
    const bEnd = b.end_epoch === null ? nowEpoch : b.end_epoch;
    if (!(cStart < bEnd && bStart < cEnd)) continue;
    let kind;
    if (bStart <= cStart && cEnd <= bEnd) kind = 'inside';
    else if (cStart <= bStart && bEnd <= cEnd) kind = 'covers';
    else if (bStart < cStart) kind = 'starts-inside';
    else kind = 'ends-inside';
    conflicts.push({ block: b, kind: kind });
  }
  const blocked = conflicts.some((c) => c.kind === 'inside');
  return { conflicts: conflicts, blocked: blocked };
}

// The trimmed version of the older block, after the person accepts the offer.
// It follows the normal edit rules, so a synced block gets a new version.
// A moved start can change the older block's reporting day, so pass dayFor (start epoch in,
// day text out) and the day is worked out again in the same edit.
export function trimOlder(older, kind, candidate, nowEpoch, dayFor) {
  if (kind === 'starts-inside') return editBlock(older, { end_epoch: candidate.start_epoch });
  if (kind === 'ends-inside') {
    const newStart = candidate.end_epoch === null ? nowEpoch : candidate.end_epoch;
    const changes = { start_epoch: newStart };
    if (typeof dayFor === 'function') changes.day = dayFor(newStart);
    return editBlock(older, changes);
  }
  throw new Error('this overlap cannot be trimmed: ' + kind);
}

// ---------------------------------------------------------------- fill around (D29)

// The stretches of the span startEpoch to endEpoch that no swallowed block covers, in time order.
// A stretch of zero length is never returned. A running swallowed block counts as ending now.
export function stretchesAround(startEpoch, endEpoch, swallowed, nowEpoch) {
  const spans = swallowed
    .map((b) => ({
      s: Math.max(b.start_epoch, startEpoch),
      e: Math.min(b.end_epoch === null ? nowEpoch : b.end_epoch, endEpoch)
    }))
    .filter((x) => x.e > x.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out = [];
  let cursor = startEpoch;
  for (const sp of spans) {
    if (sp.s > cursor) out.push({ start_epoch: cursor, end_epoch: sp.s });
    if (sp.e > cursor) cursor = sp.e;
  }
  if (endEpoch > cursor) out.push({ start_epoch: cursor, end_epoch: endEpoch });
  return out;
}

// Works out everything a late entry will do, without saving anything.
//   candidate: a block from createBlock (a new late entry, never saved yet)
//   blocks:    every block on the phone
//   opts.makeId: gives a new block_id, used for every stretch after the first
//   opts.dayFor: start epoch in, reporting day text out
// Returns:
//   refused:    the older block the entry sits fully inside, or null. Nothing else is filled in then.
//   trims:      [{older, kind, trimmed}] for each partial overlap. The person is offered each trim.
//   swallowed:  older blocks the entry covers whole. They are never changed.
//   newBlocks:  one block per stretch no swallowed block covers, same lines and shares in each.
//               The first stretch keeps the candidate's block_id.
export function planLateSave(candidate, blocks, nowEpoch, opts) {
  const found = findOverlaps(candidate, blocks, nowEpoch);
  const inside = found.conflicts.find((c) => c.kind === 'inside');
  if (inside) return { refused: inside.block, trims: [], swallowed: [], newBlocks: [] };
  const trims = [];
  const swallowed = [];
  for (const c of found.conflicts) {
    if (c.kind === 'covers') swallowed.push(c.block);
    else trims.push({ older: c.block, kind: c.kind, trimmed: trimOlder(c.block, c.kind, candidate, nowEpoch, opts.dayFor) });
  }
  const end = candidate.end_epoch === null ? nowEpoch : candidate.end_epoch;
  const stretches = stretchesAround(candidate.start_epoch, end, swallowed, nowEpoch);
  const newBlocks = stretches.map((s, i) =>
    createBlock({
      block_id: i === 0 ? candidate.block_id : opts.makeId(),
      start_epoch: s.start_epoch,
      end_epoch: s.end_epoch,
      tz_offset_min: candidate.tz_offset_min,
      day: opts.dayFor(s.start_epoch),
      lines: candidate.lines,
      entry_mode: candidate.entry_mode,
      now: candidate.logged_at
    })
  );
  return { refused: null, trims: trims, swallowed: swallowed, newBlocks: newBlocks };
}

// ---------------------------------------------------------------- late logging helpers

// The block that ended last, ignoring deleted blocks and the running one.
// "Since my last entry" starts at its end, and "same as before" copies its first line.
export function lastEndedBlock(blocks) {
  let best = null;
  for (const b of blocks) {
    if (b.is_deleted || b.end_epoch === null || b.end_epoch === undefined) continue;
    if (best === null || b.end_epoch > best.end_epoch) best = b;
  }
  return best;
}
