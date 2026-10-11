import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextColorSlot, usageCounts, chipOrder } from '../js/categories.js';

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
