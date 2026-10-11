import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LABEL, normalizeLabel, labelKey, suggest, bumpLabel, displayLabel, truncateForList
} from '../js/labels.js';

const rec = (display, count, last_used) => ({ key: display.toLowerCase(), display, count, last_used });

test('normalize trims and caps at 60 characters', () => {
  assert.equal(normalizeLabel('  credit policy deck  '), 'credit policy deck');
  assert.equal(normalizeLabel(null), '');
  assert.equal(normalizeLabel(undefined), '');
  assert.equal(Array.from(normalizeLabel('x'.repeat(100))).length, MAX_LABEL);
});

test('the cap counts whole characters, so an emoji is never cut in half', () => {
  const long = '😀'.repeat(70);
  const out = normalizeLabel(long);
  assert.equal(Array.from(out).length, 60);
  assert.equal(out, '😀'.repeat(60));
});

test('key is lowercase and trimmed', () => {
  assert.equal(labelKey('  Credit Policy '), 'credit policy');
});

test('suggest: prefix matches come before contains, each ranked by use then recency', () => {
  const records = [
    rec('policy review', 9, 100),
    rec('credit policy deck', 3, 50),
    rec('credit memo', 3, 80),
    rec('credit cards', 7, 10),
    rec('old credit note', 20, 5)
  ];
  const out = suggest(records, 'cred').map((r) => r.display);
  assert.deepEqual(out, ['credit cards', 'credit memo', 'credit policy deck', 'old credit note']);
});

test('suggest: matching is case-insensitive and also finds text inside a label', () => {
  const out = suggest([rec('Weekly Sync', 1, 1), rec('team sync', 2, 1)], 'SYNC').map((r) => r.display);
  assert.deepEqual(out, ['team sync', 'Weekly Sync']);
});

test('suggest: nothing typed gives nothing, and the list is limited to five', () => {
  assert.deepEqual(suggest([rec('a', 1, 1)], ''), []);
  assert.deepEqual(suggest([rec('a', 1, 1)], '   '), []);
  const many = Array.from({ length: 9 }, (_, i) => rec('task ' + i, i, i));
  assert.equal(suggest(many, 'task').length, 5);
  assert.equal(suggest(many, 'task', 3).length, 3);
});

test('bump: a new label starts at 1, an existing one adds 1 and takes the newest spelling', () => {
  assert.deepEqual(bumpLabel(undefined, ' Deck ', 100), { key: 'deck', display: 'Deck', count: 1, last_used: 100 });
  assert.deepEqual(
    bumpLabel({ key: 'deck', display: 'deck', count: 4, last_used: 100 }, 'DECK', 200),
    { key: 'deck', display: 'DECK', count: 5, last_used: 200 }
  );
});

test('bump: an empty label saves nothing', () => {
  assert.equal(bumpLabel(undefined, '   ', 1), null);
  assert.equal(bumpLabel(undefined, '', 1), null);
});

test('list display: empty shows (no label), long labels end in ...', () => {
  assert.equal(displayLabel(''), '(no label)');
  assert.equal(displayLabel('deck'), 'deck');
  assert.equal(truncateForList('', 10), '(no label)');
  assert.equal(truncateForList('short', 10), 'short');
  assert.equal(truncateForList('a very long label indeed', 10), 'a very lon...');
  assert.equal(truncateForList('abc def ghi', 4), 'abc...');
});
