// errorlog.js: the rules for the local error log (spec section 12, Phase 8).
// The app keeps the last 50 problems on the phone: a failed sync, a failed save, a screen that
// would not open. Settings has a Copy log button, so you can paste them into a chat.
// Pure logic, no screen code, so Node can test it. The log never holds the secret key: callers
// pass only fixed sentences and short error codes.

import { localDate, formatClock12 } from './time.js';

export const LOG_MAX = 50;
const TEXT_MAX = 200;

// Returns a new list with the entry added at the end. The oldest entries fall off past LOG_MAX.
export function addEntry(list, entry, max) {
  const limit = max || LOG_MAX;
  const clean = {
    t: Number(entry.t) || 0,
    kind: String(entry.kind || 'app').slice(0, 20),
    text: String(entry.text === undefined || entry.text === null ? '' : entry.text).slice(0, TEXT_MAX)
  };
  const next = (Array.isArray(list) ? list : []).concat([clean]);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

// Plain text for the Copy button, oldest first, one line per entry.
export function formatLog(list, appVersion, tzOffsetMin) {
  const entries = Array.isArray(list) ? list : [];
  const head = 'my snitch. ' + appVersion + ' error log, ' + entries.length + (entries.length === 1 ? ' entry' : ' entries');
  if (entries.length === 0) return head;
  const lines = entries.map((e) => localDate(e.t, tzOffsetMin) + ' ' + formatClock12(e.t, tzOffsetMin) + ' [' + e.kind + '] ' + e.text);
  return head + '\n' + lines.join('\n');
}
