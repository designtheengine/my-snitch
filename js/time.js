// time.js: pure time helpers for my snitch.
// No DOM, no storage. Every time is a whole number of seconds since 1970 (an "epoch").
// An "offset" is minutes east of UTC, so India is +330.

export const CUTOFF_HOUR = 4;
const FOUR_HOURS = CUTOFF_HOUR * 3600;

function pad(n) {
  return String(n).padStart(2, '0');
}

// The calendar date, as YYYY-MM-DD, that an epoch falls on in a given offset.
export function localDate(epoch, offsetMin) {
  return new Date((epoch + offsetMin * 60) * 1000).toISOString().slice(0, 10);
}

// ISO text with the offset written out, to the second: 2026-09-29T14:00:00+05:30
export function toIso(epoch, offsetMin) {
  const base = new Date((epoch + offsetMin * 60) * 1000).toISOString().slice(0, 19);
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  return base + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

// The epoch for a wall clock time on a calendar date in a given offset.
export function epochFromLocal(dateStr, hour, minute, second, offsetMin) {
  const parts = dateStr.split('-').map(Number);
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2], hour, minute, second);
  return ms / 1000 - offsetMin * 60;
}

export function addDays(dateStr, n) {
  const parts = dateStr.split('-').map(Number);
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + n)).toISOString().slice(0, 10);
}

// Reporting day when no wake event applies (the first days of use):
// the local date of the start time minus 4 hours.
export function fallbackDay(startEpoch, offsetMin) {
  return localDate(startEpoch - FOUR_HOURS, offsetMin);
}

// Reporting day for an ordinary block. wakes is a list of {epoch, offset_min}.
// Rule: the most recent wake at or before the start decides the day.
export function reportingDay(startEpoch, offsetMin, wakes) {
  let best = null;
  for (const w of wakes) {
    if (w.epoch <= startEpoch && (best === null || w.epoch > best.epoch)) best = w;
  }
  if (best) return localDate(best.epoch, best.offset_min);
  return fallbackDay(startEpoch, offsetMin);
}

// Reporting day for night sleep blocks. The night counts toward the day you wake up.
// Until the wake is logged the day is only provisional (the date of the bed).
export function nightDay(night) {
  if (night.wakeEpoch !== null && night.wakeEpoch !== undefined) {
    return { day: localDate(night.wakeEpoch, night.wakeOffsetMin), provisional: false };
  }
  return { day: localDate(night.bedEpoch, night.bedOffsetMin), provisional: true };
}

// Auto-close. When the current day has a wake but no bed, and the clock has passed
// 04:00 on a later calendar date, the day closes at that 04:00.
// Returns the epoch for the auto bed event, or null when nothing should happen.
//   wakeEpoch, wakeOffsetMin: the wake that opened the day
//   bedEpoch: latest bed event, or null
//   nowEpoch: the current time
export function autoCloseEpoch(args) {
  const { wakeEpoch, wakeOffsetMin, bedEpoch, nowEpoch } = args;
  if (wakeEpoch === null || wakeEpoch === undefined) return null;
  if (bedEpoch !== null && bedEpoch !== undefined && bedEpoch >= wakeEpoch) return null;
  const nextDate = addDays(localDate(wakeEpoch, wakeOffsetMin), 1);
  const cutoff = epochFromLocal(nextDate, CUTOFF_HOUR, 0, 0, wakeOffsetMin);
  return nowEpoch > cutoff ? cutoff : null;
}

// Gap finder. Scans blocks in time order between from and to, and returns every hole
// longer than thresholdSec. A running block (end_epoch null) covers time up to "to".
// Deleted blocks are ignored. Result is in time order, so the last item is the latest gap.
export function findGaps(args) {
  const { blocks, from, to, thresholdSec } = args;
  const spans = [];
  for (const b of blocks) {
    if (b.is_deleted) continue;
    const end = b.end_epoch === null || b.end_epoch === undefined ? to : b.end_epoch;
    const start = Math.max(b.start_epoch, from);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd > start) spans.push({ start, end: clippedEnd });
  }
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps = [];
  let cursor = from;
  for (const s of spans) {
    if (s.start - cursor > thresholdSec) gaps.push({ start: cursor, end: s.start });
    if (s.end > cursor) cursor = s.end;
  }
  if (to - cursor > thresholdSec) gaps.push({ start: cursor, end: to });
  return gaps;
}

export function latestGap(gaps) {
  return gaps.length ? gaps[gaps.length - 1] : null;
}

// The gaps Home reports for the current reporting day. blocks are today's blocks plus the
// running one. The scan starts at the day's wake (wakeEpoch, from Phase 5). Until a wake
// exists it starts at the first block of the day, and with no blocks at all there is
// nothing to measure from, so no gaps are reported.
export function dayGaps(args) {
  const { blocks, nowEpoch, thresholdSec } = args;
  const live = blocks.filter((b) => !b.is_deleted);
  let from = args.wakeEpoch === undefined ? null : args.wakeEpoch;
  if (from === null) {
    for (const b of live) if (from === null || b.start_epoch < from) from = b.start_epoch;
  }
  if (from === null) return [];
  return findGaps({ blocks: live, from: from, to: nowEpoch, thresholdSec: thresholdSec });
}

// Late logging chips: "started 15 / 30 / 60 minutes ago".
export function minutesAgo(nowEpoch, minutes) {
  return nowEpoch - minutes * 60;
}

// 5400 seconds becomes "1:30:00".
export function formatDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h + ':' + pad(m) + ':' + pad(s % 60);
}

// "2:10 pm"
export function formatClock12(epoch, offsetMin) {
  const d = new Date((epoch + offsetMin * 60) * 1000);
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return (h % 12 || 12) + ':' + pad(m) + ' ' + (h < 12 ? 'am' : 'pm');
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// How the gap banner says when the silence began (v31). On the same calendar day as now it is
// just the time, "3:40 pm". On an earlier day it names the weekday and counts the calendar days
// between that day and today: "Sat 3:40 pm (2 days)". The count is of calendar days, not of
// 24 hour blocks, so last night at 11:00 pm read at 8:00 am gives "(1 day)".
export function sinceText(startEpoch, nowEpoch, offsetMin) {
  const clock = formatClock12(startEpoch, offsetMin);
  const startDate = localDate(startEpoch, offsetMin);
  const nowDate = localDate(nowEpoch, offsetMin);
  if (startDate === nowDate) return clock;
  const days = Math.round((Date.parse(nowDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / 86400000);
  const weekday = WEEKDAYS[new Date(startDate + 'T00:00:00Z').getUTCDay()];
  return weekday + ' ' + clock + ' (' + days + (days === 1 ? ' day)' : ' days)');
}
