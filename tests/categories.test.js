import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextColorSlot, usageCounts, chipOrder, usedCount, isLocked, categoryByName, checkName, renameChanges, LOCKED_NAMES } from '../js/categories.js';

const cat = (id, name, sort, archived) => ({ id: id, name: name, sort_order: sort, archived: !!archived, color: id });

test('colour slot: the tenth category takes slot 1, then the cycle continues (Q9)', () => {
  assert.equal(nextColorSlot(0), 1);
  assert.equal(nextColorSlot(8), 9);
  assert.equal(nextColorSlot(9), 1);
  assert.equal(nextColorSlot(10), 2);
  assert.equal(nextColorSlot(17), 9);
  assert.equal(nextColorSlot(18), 1);
});

test('usage counts ignore deleted blocks and count every line, by lowercase name', () => {
  const blocks = [
    { is_deleted: false, lines: [{ category: 'Admin' }, { category: 'learning' }] },
    { is_deleted: false, lines: [{ category: 'admin' }] },
    { is_deleted: true, lines: [{ category: 'admin' }] }
  ];
  const counts = usageCounts(blocks);
  assert.equal(counts.get('admin'), 2);
  assert.equal(counts.get('learning'), 1);
  assert.equal(counts.get('social'), undefined);
});

test('chips: most used first, ties by sort order, archived left out', () => {
  const cats = [cat(1, 'office work', 1), cat(2, 'admin', 2), cat(3, 'learning', 3), cat(4, 'old', 4, true)];
  const counts = new Map([['learning', 5], ['admin', 2], ['old', 99]]);
  const names = chipOrder(cats, counts, null).map((c) => c.name);
  assert.deepEqual(names, ['learning', 'admin', 'office work']);
});

test('chips: a category with no use and a lower sort order still comes before a later one', () => {
  const cats = [cat(1, 'a', 1), cat(2, 'b', 2), cat(3, 'c', 3)];
  const names = chipOrder(cats, new Map(), null).map((c) => c.name);
  assert.deepEqual(names, ['a', 'b', 'c']);
});

test('acceptance check 10: a category just made is pinned first, however little it is used', () => {
  const cats = [cat(1, 'office work', 1), cat(2, 'admin', 2), cat(10, 'reading', 10)];
  const counts = new Map([['office work', 40], ['admin', 12]]);
  const names = chipOrder(cats, counts, 10).map((c) => c.name);
  assert.deepEqual(names, ['reading', 'office work', 'admin']);
});

test('chips: the pin changes nothing when it is already first or unknown', () => {
  const cats = [cat(1, 'a', 1), cat(2, 'b', 2)];
  assert.deepEqual(chipOrder(cats, new Map(), 1).map((c) => c.name), ['a', 'b']);
  assert.deepEqual(chipOrder(cats, new Map(), 99).map((c) => c.name), ['a', 'b']);
});

test('chips: the input list is not changed', () => {
  const cats = [cat(2, 'b', 2), cat(1, 'a', 1)];
  chipOrder(cats, new Map(), 1);
  assert.deepEqual(cats.map((c) => c.name), ['b', 'a']);
});

// ---- Phase 8: renaming, locked names and lookup by old names

const mk = (id, name, extra = {}) => Object.assign({ id, name, archived: false, sort_order: id, color: id }, extra);

test('sleep and doomscrolling are locked, other names are not', () => {
  assert.deepEqual(LOCKED_NAMES, ['sleep', 'doomscrolling']);
  assert.equal(isLocked(mk(1, 'Sleep')), true);
  assert.equal(isLocked(mk(2, 'doomscrolling')), true);
  assert.equal(isLocked(mk(3, 'admin')), false);
});

test('renameChanges keeps the old name in previous_names', () => {
  const c = mk(3, 'admin');
  assert.deepEqual(renameChanges(c, ' admin work '), { name: 'admin work', previous_names: ['admin'] });
  assert.deepEqual(renameChanges(c, 'admin'), {});
});

test('a second rename keeps both old names, and renaming back drops the name it returns to', () => {
  const once = Object.assign(mk(3, 'admin work'), { previous_names: ['admin'] });
  assert.deepEqual(renameChanges(once, 'paperwork'), { name: 'paperwork', previous_names: ['admin', 'admin work'] });
  // Back to admin: admin is current again, and admin work stays as an earlier name, because blocks were logged under it.
  assert.deepEqual(renameChanges(once, 'admin'), { name: 'admin', previous_names: ['admin work'] });
});

test('a change of capitals only adds no previous name', () => {
  assert.deepEqual(renameChanges(mk(3, 'admin'), 'Admin'), { name: 'Admin', previous_names: [] });
});

test('checkName refuses empty names and clashes, and allows the category its own name', () => {
  const list = [mk(1, 'office work'), mk(2, 'admin')];
  assert.equal(checkName(list, '   ', 2), 'Type a name first.');
  assert.equal(checkName(list, 'Office Work', 2), 'A category with that name already exists.');
  assert.equal(checkName(list, 'ADMIN', 2), null);
  assert.equal(checkName(list, 'a name that is longer than sixty characters is still fine here ok', null), null);
});

test('categoryByName finds the current name first, then an earlier name, and can skip archived ones', () => {
  const list = [mk(1, 'admin work', { previous_names: ['admin'] }), mk(2, 'admin', { archived: false }), mk(3, 'old', { archived: true })];
  assert.equal(categoryByName(list, 'admin').id, 2);
  assert.equal(categoryByName([list[0]], 'ADMIN').id, 1);
  assert.equal(categoryByName(list, 'nothing'), null);
  assert.equal(categoryByName(list, 'old').id, 3);
  assert.equal(categoryByName(list, 'old', true), null);
});

test('usedCount adds up the earlier names, and chipOrder uses it', () => {
  const counts = new Map([['admin', 5], ['admin work', 2], ['social', 6]]);
  const renamed = mk(1, 'admin work', { previous_names: ['admin'] });
  assert.equal(usedCount(renamed, counts), 7);
  const order = chipOrder([mk(2, 'social'), renamed], counts).map((c) => c.id);
  assert.deepEqual(order, [1, 2]);
});
