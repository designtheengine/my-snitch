import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleUnsynced, longTimer, exportCsv, exportJson, CSV_COLUMNS } from '../js/safeguards.js';
import { createBlock } from '../js/model.js';
import { epochFromLocal } from '../js/time.js';

const IST = 330;
const at = (h, m = 0, date = '2026-10-18') => epochFromLocal(date, h, m, 0, IST);
const mk = (id, start, end, over = {}) =>
  Object.assign(createBlock({
    block_id: id, start_epoch: start, end_epoch: end, tz_offset_min: IST, day: '2026-10-18',
    lines: [{ category: 'admin', label: 'x', share_pct: 100 }], entry_mode: 'late', now: start
  }), over);

test('staleUnsynced counts never-synced blocks that ended over 24 hours ago', () => {
  const now = at(12);
  const old = mk('a', at(8, 0, '2026-10-16'), at(9, 0, '2026-10-16'));
  const edge = mk('b', at(11, 0, '2026-10-17'), at(12, 0, '2026-10-17'));      // exactly 24 hours: not over
  const fresh = mk('c', at(9), at(10));
  assert.equal(staleUnsynced([old, edge, fresh], now), 1);
});

test('staleUnsynced ignores edits of synced blocks, deleted blocks and running blocks', () => {
  const now = at(12);
  const edited = mk('e', at(8, 0, '2026-10-10'), at(9, 0, '2026-10-10'), { synced_version: 1, version: 2, dirty: 1 });
  const deleted = mk('d', at(8, 0, '2026-10-10'), at(9, 0, '2026-10-10'), { is_deleted: true });
  const running = mk('r', at(8, 0, '2026-10-10'), null, { running: 1 });
  assert.equal(staleUnsynced([edited, deleted, running], now), 0);
  assert.equal(staleUnsynced([], now), 0);
});

test('longTimer fires after 6 hours, not before, and never for a stopped block', () => {
  const run = mk('r', at(8), null, { running: 1 });
  assert.equal(longTimer(run, null, at(13, 59)), null);
  assert.deepEqual(longTimer(run, null, at(14)), { seconds: 6 * 3600 });
  assert.equal(longTimer(null, null, at(20)), null);
  assert.equal(longTimer(mk('s', at(8), at(9)), null, at(20)), null);
});

test('Still going quiets the question for 6 more hours, for that block only', () => {
  const run = mk('r', at(8), null, { running: 1 });
  const ack = { block_id: 'r', at: at(14, 30) };
  assert.equal(longTimer(run, ack, at(20, 29)), null);
  assert.ok(longTimer(run, ack, at(20, 30)));
  // an answer saved for some other block does not count
  assert.ok(longTimer(run, { block_id: 'other', at: at(14, 30) }, at(15)));
});

test('exportCsv has the header, one row per line, oldest first, and leaves out a running block', () => {
  const split = mk('s', at(10), at(11), { lines: [{ category: 'admin', label: 'a', share_pct: 70 }, { category: 'learning', label: 'b', share_pct: 30 }] });
  const early = mk('e', at(8), at(9));
  const running = mk('r', at(12), null, { running: 1 });
  const lines = exportCsv([split, running, early], {}).trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','));
  assert.equal(lines.length, 4);
  assert.ok(lines[1].startsWith('e:1:0,e,1'));
  assert.ok(lines[2].startsWith('s:1:0,s,1') && lines[3].startsWith('s:1:1,s,1'));
});

test('exportCsv quotes commas, quotes and new lines, and carries the night role and deletions', () => {
  const tricky = mk('t', at(8), at(9), { lines: [{ category: 'admin', label: 'a, "b"\nc', share_pct: 100 }], is_deleted: true });
  const text = exportCsv([tricky], { t: 'before_sleep' });
  assert.ok(text.includes('"a, ""b""\nc"'));
  const head = text.split('\n')[0].split(',');
  assert.equal(head[head.length - 1], 'night_role');
  assert.ok(text.includes(',TRUE,') || text.includes(',true,'));
  assert.ok(text.includes('before_sleep'));
});

test('exportJson keeps the parts, and never holds the key or the script address', () => {
  const text = exportJson({
    exportedAt: '2026-10-18T18:00:00+05:30', appVersion: 'v23',
    settings: { theme: 'dark', gap_threshold_min: 10, secret_key: 'SHOULD_NOT_APPEAR', script_url: 'https://example.invalid/x' },
    blocks: [mk('a', at(8), at(9))], nights: [], categories: [{ id: 1, name: 'admin' }], labels: [{ key: 'x', display: 'x', count: 1 }]
  });
  const data = JSON.parse(text);
  assert.equal(data.format, 'my-snitch-export');
  assert.equal(data.app_version, 'v23');
  assert.deepEqual(data.settings, { theme: 'dark', gap_threshold_min: 10 });
  assert.equal(data.blocks.length, 1);
  assert.ok(!text.includes('SHOULD_NOT_APPEAR') && !text.includes('example.invalid'));
});
