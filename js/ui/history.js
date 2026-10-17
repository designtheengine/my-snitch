// history.js: the History view (PRD section 5.3, Phase 7).
// Home lists only unsynced blocks (decided 17 Oct 2026, D64), so this is where blocks the Sheet already holds
// show up. They are grouped by reporting day, newest day first, a few days at a time. Tapping a row opens
// edit mode, and any past block can be edited or deleted, however old (D30). An edit of a synced block is
// saved as a new version, and the original rows stay in the Sheet.
// The rows are the same ones Home draws (entryRow in home.js).
//
// openHistory(ctx, root, data): data.fresh is true when Home opened it, so the list starts at the top.
// Coming back from edit mode keeps however many days were showing.

import { el, clear } from './dom.js';
import { getAllBlocks } from '../db.js';
import { formatDuration, localDate } from '../time.js';
import { entryRow } from './home.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAGE_DAYS = 3;

// How many days are showing. It lives here, outside the function, so a trip into edit mode and back keeps it.
let shown = PAGE_DAYS;

// "2026-10-15" becomes "Thu 15 Oct 2026".
export function dayTitle(day) {
  const p = day.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  return weekday + ' ' + p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0];
}

export async function openHistory(ctx, root, data) {
  clear(root);
  if (data && data.fresh) shown = PAGE_DAYS;
  const all = await getAllBlocks(ctx.db);
  // Blocks the Sheet holds: synced at least once, not deleted, not running. A synced block with a newer version
  // waiting still counts, and carries the "edit" tag.
  const synced = all.filter((b) => b.synced_version >= 1 && !b.is_deleted && b.running !== 1 && b.end_epoch !== null);
  const byDay = new Map();
  for (const b of synced) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  const days = Array.from(byDay.keys()).sort().reverse();
  const today = localDate(ctx.nowEpoch(), ctx.tzOffsetMin());

  const body = [];
  if (days.length === 0) {
    body.push(el('div', { class: 'card empty', text: 'Nothing here yet. Blocks show up here once they are synced.' }));
  }
  for (const day of days.slice(0, shown)) {
    const blocks = byDay.get(day).sort((a, b) => b.start_epoch - a.start_epoch);
    const total = blocks.reduce((sum, b) => sum + (b.end_epoch - b.start_epoch), 0);
    body.push(
      el('div', { class: 'day-head' }, [
        el('div', { class: 'section-label', text: dayTitle(day) }),
        el('div', { class: 'muted', text: formatDuration(total) + ' logged' })
      ]),
      el('ul', { class: 'entry-list' }, blocks.map((b) =>
        entryRow(ctx, b, today, {
          showDate: false,
          onTap: () => ctx.show('entry', { mode: 'edit', blockId: b.block_id, back: 'history' })
        })
      ))
    );
  }
  if (days.length > shown) {
    const more = Math.min(PAGE_DAYS, days.length - shown);
    body.push(
      el('button', {
        type: 'button',
        class: 'btn btn-wide more-days',
        onclick: () => {
          shown += PAGE_DAYS;
          openHistory(ctx, root, null);
        }
      }, 'Show ' + more + ' more ' + (more === 1 ? 'day' : 'days'))
    );
  }

  root.append(
    el('div', { class: 'head page-head' }, [
      el('h2', { class: 'title', text: 'History' }),
      el('button', { type: 'button', class: 'btn btn-text', onclick: () => ctx.show('home') }, 'Back')
    ]),
    el('p', { class: 'muted', text: 'Blocks the Sheet already holds. Tap one to edit or delete it. The original rows stay in the Sheet.' }),
    ...body
  );
}
