import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addEntry, formatLog, LOG_MAX } from '../js/errorlog.js';
import { epochFromLocal } from '../js/time.js';

const IST = 330;
const t = (h, m = 0) => epochFromLocal('2026-10-18', h, m, 0, IST);

test('addEntry adds to the end and does not change the old list', () => {
  const a = addEntry([], { t: t(9), kind: 'sync', text: 'network' });
  const b = addEntry(a, { t: t(10), kind: 'app', text: 'x' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.equal(b[1].kind, 'app');
});

test('the log keeps only the last 50 entries', () => {
  let list = [];
  for (let i = 0; i < 60; i++) list = addEntry(list, { t: i, kind: 'app', text: 'e' + i });
  assert.equal(list.length, LOG_MAX);
  assert.equal(list[0].text, 'e10');
  assert.equal(list[49].text, 'e59');
});

test('a long text is cut, and a missing list or text does not crash', () => {
  const list = addEntry(null, { t: 1, kind: 'app', text: 'z'.repeat(500) });
  assert.equal(list[0].text.length, 200);
  const blank = addEntry([], { t: 2 });
  assert.equal(blank[0].text, '');
  assert.equal(blank[0].kind, 'app');
});

test('formatLog writes a head line and one line per entry, oldest first', () => {
  const list = addEntry(addEntry([], { t: t(9, 5), kind: 'sync', text: 'timeout' }), { t: t(9, 30), kind: 'storage', text: 'write failed' });
  const text = formatLog(list, 'v21', IST).split('\n');
  assert.equal(text[0], 'my snitch. v21 error log, 2 entries');
  assert.ok(text[1].startsWith('2026-10-18 9:05') && text[1].includes('[sync] timeout'));
  assert.ok(text[2].includes('[storage] write failed'));
});

test('an empty log says so in the head line only', () => {
  assert.equal(formatLog([], 'v21', IST), 'my snitch. v21 error log, 0 entries');
  assert.equal(formatLog(undefined, 'v21', IST), 'my snitch. v21 error log, 0 entries');
});
