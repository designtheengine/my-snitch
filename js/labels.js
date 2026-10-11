// labels.js: pure label rules and suggestions for my snitch.
// A label is free text, capped at 60 characters. Suggestions come from earlier labels.

export const MAX_LABEL = 60;

// Trim, then cap at 60 characters. Counts whole characters, so an emoji is never cut in half.
export function normalizeLabel(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  return Array.from(text).slice(0, MAX_LABEL).join('').trim();
}

// The lowercase key that identifies a label in the labels store.
export function labelKey(raw) {
  return normalizeLabel(raw).toLowerCase();
}

// records: [{key, display, count, last_used}]
// Matches that start with the typed text come first, then matches that contain it.
// Within each group: most used first, then most recent. Top five by default.
// Nothing typed means no suggestions.
export function suggest(records, query, limit = 5) {
  const q = labelKey(query);
  if (!q) return [];
  const rank = (a, b) => b.count - a.count || b.last_used - a.last_used || (a.key < b.key ? -1 : 1);
  const starts = [];
  const contains = [];
  for (const r of records) {
    if (r.key.startsWith(q)) starts.push(r);
    else if (r.key.includes(q)) contains.push(r);
  }
  starts.sort(rank);
  contains.sort(rank);
  return starts.concat(contains).slice(0, limit);
}

// The record to save after a label is used. Returns null for an empty label.
// existing is the current record for that key, or undefined.
export function bumpLabel(existing, raw, nowEpoch) {
  const display = normalizeLabel(raw);
  if (!display) return null;
  return {
    key: display.toLowerCase(),
    display: display,
    count: (existing ? existing.count : 0) + 1,
    last_used: nowEpoch
  };
}

// Lists show an empty label as "(no label)".
export function displayLabel(label) {
  return label ? label : '(no label)';
}

// Lists cut long labels with "...". The full text shows on tap.
export function truncateForList(label, maxChars) {
  const chars = Array.from(label || '');
  if (chars.length === 0) return '(no label)';
  if (chars.length <= maxChars) return label;
  return chars.slice(0, maxChars).join('').trimEnd() + '...';
}
