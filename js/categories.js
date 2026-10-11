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

// The order of the chips in the slider, after "+ new", which the screen always puts first.
// Archived categories are left out. Most used first, ties by the saved sort order.
// A category just made with "+ new" is pinned first for the rest of that visit to the form
// (spec section 6.7), so pass its id as pinnedId. Later visits sort by use again.
export function chipOrder(categories, counts, pinnedId) {
  const list = categories.filter((c) => !c.archived);
  const used = (c) => counts.get(c.name.toLowerCase()) || 0;
  list.sort((a, b) => used(b) - used(a) || a.sort_order - b.sort_order);
  if (pinnedId !== undefined && pinnedId !== null) {
    const i = list.findIndex((c) => c.id === pinnedId);
    if (i > 0) list.unshift(list.splice(i, 1)[0]);
  }
  return list;
}
