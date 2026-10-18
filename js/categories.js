// categories.js: pure category rules for my snitch.
// No DOM, no storage. The entry form uses these to order the chips and to pick a colour.

export const SLOT_COUNT = 9;

// The colour slot for a new category (decided 11 Oct 2026, log Q9): the next slot in
// order, cycling back to slot 1 after nine. Pass the number of categories that exist now,
// archived ones included, so archiving a category never makes a slot repeat early.
export function nextColorSlot(existingCount) {
  return (existingCount % SLOT_COUNT) + 1;
}

// How often each category name appears across blocks that are not deleted.
// Keys are lowercase names. A block with two lines in one category counts that category twice.
export function usageCounts(blocks) {
  const counts = new Map();
  for (const b of blocks) {
    if (b.is_deleted) continue;
    for (const line of b.lines) {
      const key = String(line.category).toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return counts;
}

// How often a category was used, counting the names it had before a rename (spec section 6.7).
// Old blocks keep the name they were logged with, so a renamed category keeps its history in the chip order.
export function usedCount(category, counts) {
  const names = [category.name].concat(category.previous_names || []);
  let total = 0;
  for (const n of new Set(names.map((x) => String(x).toLowerCase()))) total += counts.get(n) || 0;
  return total;
}

// The order of the chips in the slider, after "+ new", which the screen always puts first.
// Archived categories are left out. Most used first, ties by the saved sort order.
// A category just made with "+ new" is pinned first for the rest of that visit to the form
// (spec section 6.7), so pass its id as pinnedId. Later visits sort by use again.
export function chipOrder(categories, counts, pinnedId) {
  const list = categories.filter((c) => !c.archived);
  list.sort((a, b) => usedCount(b, counts) - usedCount(a, counts) || a.sort_order - b.sort_order);
  if (pinnedId !== undefined && pinnedId !== null) {
    const i = list.findIndex((c) => c.id === pinnedId);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}

// Two categories the app itself depends on, by name (decided 18 Oct 2026, Phase 8). The sleep screens
// make blocks in `sleep`, and the Sheet's analysis counts rows named `doomscrolling`. Their name cannot
// change and they cannot be archived. Their colour can.
export const LOCKED_NAMES = ['sleep', 'doomscrolling'];

export function isLocked(category) {
  return LOCKED_NAMES.includes(String(category.name).toLowerCase());
}

// Finds a category from the name saved on a block. The current name wins, then any earlier name.
// activeOnly leaves out archived categories (used when the form needs a chip to select).
export function categoryByName(categories, name, activeOnly) {
  const lower = String(name).toLowerCase();
  const pool = activeOnly ? categories.filter((c) => !c.archived) : categories;
  const current = pool.find((c) => c.name.toLowerCase() === lower);
  if (current) return current;
  return pool.find((c) => (c.previous_names || []).some((n) => String(n).toLowerCase() === lower)) || null;
}

// A plain sentence if the name is not allowed, otherwise null. selfId is the category being renamed,
// so keeping its own name is fine. Names have no length limit (log D34).
export function checkName(categories, name, selfId) {
  const clean = String(name).trim();
  if (clean === '') return 'Type a name first.';
  const clash = categories.some((c) => c.id !== selfId && c.name.toLowerCase() === clean.toLowerCase());
  return clash ? 'A category with that name already exists.' : null;
}

// What to save when a category is renamed: the new name, and the old name added to previous_names so old
// blocks keep their colour and their place in the chip order. A change of capitals only is not a new name.
// Renaming back to an earlier name takes it off the list. An unchanged name returns no changes.
export function renameChanges(category, newName) {
  const clean = String(newName).trim();
  if (clean === category.name) return {};
  const prev = (category.previous_names || []).filter((n) => String(n).toLowerCase() !== clean.toLowerCase());
  const caseOnly = clean.toLowerCase() === category.name.toLowerCase();
  if (!caseOnly && !prev.some((n) => String(n).toLowerCase() === category.name.toLowerCase())) prev.push(category.name);
  return { name: clean, previous_names: prev };
}
