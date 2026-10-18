// safeguards.js: the rules behind the Phase 8 safeguards. Pure logic, no screen code, so Node can test it.
// - staleUnsynced: blocks that have waited more than a day for a sync (the 24 hour banner, PRD section 9)
// - longTimer: a running block that has gone six hours without an answer (the "still doing this?" check, PRD section 11)
// - exportCsv and exportJson: the text of the two export files (Settings, decided 18 Oct 2026, Q4)
// Nothing here ever reads or writes the secret key.

import { outgoingRows } from './model.js';

export const STALE_HOURS = 24;
export const LONG_TIMER_HOURS = 6;

// How many of these unsynced blocks ended more than `hours` ago and never reached the Sheet.
// A block you edited after a sync does not count: the app keeps no "edited at" time for it, so its
// age would be a guess. Pass the unsynced list from Home, which already leaves out held night blocks.
export function staleUnsynced(unsynced, nowEpoch, hours) {
  const limit = (hours || STALE_HOURS) * 3600;
  return unsynced.filter((b) =>
    b.running !== 1 && b.end_epoch !== null && !b.is_deleted && (b.synced_version || 0) === 0 && nowEpoch - b.end_epoch > limit
  ).length;
}

// Is the running block due the "still doing this?" question? `ack` is the saved answer
// ({block_id, at}) from the last time you tapped Still going. The question comes back `hours`
// after the start, or after your last answer for this same block. Returns {seconds} or null.
export function longTimer(running, ack, nowEpoch, hours) {
  if (!running || running.end_epoch !== null) return null;
  const limit = (hours || LONG_TIMER_HOURS) * 3600;
  const from = ack && ack.block_id === running.block_id ? Math.max(running.start_epoch, ack.at) : running.start_epoch;
  return nowEpoch - from >= limit ? { seconds: nowEpoch - running.start_epoch } : null;
}

export const CSV_COLUMNS = [
  'row_id', 'block_id', 'version', 'schema_version', 'start_ts', 'end_ts', 'start_epoch', 'end_epoch',
  'day', 'category', 'label', 'share_pct', 'is_deleted', 'entry_mode', 'logged_at', 'night_role'
];

function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// One row per activity line of every block that has ended, at its current version, oldest first.
// The columns are the Sheet's raw tab without synced_at. Deleted blocks are included, marked TRUE.
// roles is {block_id: night role}, from nightRoles() in sleep.js. A running block is left out.
export function exportCsv(blocks, roles) {
  const map = roles || {};
  const rows = blocks
    .filter((b) => b.end_epoch !== null && b.running !== 1)
    .sort((a, b) => a.start_epoch - b.start_epoch)
    .flatMap((b) => outgoingRows(b, map[b.block_id]));
  return [CSV_COLUMNS.join(',')].concat(rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(','))).join('\n') + '\n';
}

// A copy for restoring later: every block record as saved, the nights, categories and label list, and two
// harmless settings. It deliberately leaves out the secret key and the script address.
export function exportJson(parts) {
  const settings = parts.settings || {};
  return JSON.stringify({
    format: 'my-snitch-export',
    exported_at: parts.exportedAt,
    app_version: parts.appVersion,
    schema_version: 1,
    settings: { theme: settings.theme, gap_threshold_min: settings.gap_threshold_min },
    blocks: parts.blocks,
    nights: parts.nights,
    categories: parts.categories,
    labels: parts.labels
  }, null, 2);
}
