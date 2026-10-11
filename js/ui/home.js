// home.js: the Home view (PRD section 5.1). It only draws and reacts to taps.
// Phase 3 shows the status card, the sync bar and the unsynced list.
// The "missed something" button and the gap banner arrive in Phase 4, the sleep control in Phase 5.

import { el, clear, catStyle } from './dom.js';
import { saveBlock, removeBlock, getRunningBlock } from '../db.js';
import { stopBlock, elapsedSeconds } from '../model.js';
import { formatDuration, formatClock12, localDate } from '../time.js';
import { truncateForList } from '../labels.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

let timerId = null;

// The live timer only redraws while the screen is open. The elapsed time itself is
// always now minus the saved start, so it is exact however long the app was closed.
export function stopTicker() {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
}

function startTicker(ctx) {
  stopTicker();
  timerId = setInterval(() => {
    if (document.hidden) return;
    const node = document.getElementById('timer');
    const running = ctx.state.running;
    if (!node || !running) return;
    node.textContent = formatDuration(elapsedSeconds(running, ctx.nowEpoch()));
  }, 1000);
}

function slotFor(ctx, name) {
  const lower = String(name).toLowerCase();
  const found = ctx.state.categories.find((c) => c.name.toLowerCase() === lower);
  return found ? found.color : 9;
}

function shortDate(epoch, offsetMin) {
  const parts = localDate(epoch, offsetMin).split('-').map(Number);
  return parts[2] + ' ' + MONTHS[parts[1] - 1];
}

async function onStop(ctx, button) {
  button.disabled = true;
  try {
    const running = await getRunningBlock(ctx.db);
    if (running) {
      const result = stopBlock(running, ctx.nowEpoch());
      if (result.action === 'remove') await removeBlock(ctx.db, result.block_id);
      else await saveBlock(ctx.db, result.block, { bumpLabels: false });
    }
  } catch (err) {
    ctx.warn('Could not stop the block. Nothing was changed. Try again.');
    button.disabled = false;
    return;
  }
  await ctx.refresh();
}

function statusCard(ctx) {
  const running = ctx.state.running;
  if (!running) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'title', text: 'What are you doing?' }),
      el('div', { class: 'spacer' }),
      el('button', { type: 'button', class: 'btn btn-primary btn-wide', onclick: () => ctx.show('entry', 'start') }, 'Start')
    ]);
  }
  const first = running.lines[0];
  const names = running.lines.map((l) => l.category).join(' / ');
  const stopBtn = el('button', { type: 'button', class: 'btn btn-primary' }, 'Stop');
  stopBtn.addEventListener('click', () => onStop(ctx, stopBtn));
  return el('div', { class: 'card' }, [
    el('div', { class: 'status-line' }, [
      el('span', { class: 'dot', style: catStyle(slotFor(ctx, first.category)) }),
      el('span', { text: names })
    ]),
    el('div', { class: 'status-label muted', text: (first.label ? first.label : '(no label)') + ' · since ' + formatClock12(running.start_epoch, running.tz_offset_min) }),
    el('div', { class: 'timer', id: 'timer', text: formatDuration(elapsedSeconds(running, ctx.nowEpoch())) }),
    el('div', { class: 'btn-row' }, [
      stopBtn,
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('entry', 'start') }, 'Switch')
    ])
  ]);
}

function syncBar(ctx) {
  const last = ctx.state.lastSyncedAt;
  const lastText = last ? formatClock12(last, ctx.tzOffsetMin()) : 'never';
  const count = ctx.state.unsynced.length;
  return el('div', { class: 'card' }, [
    el('div', { class: 'sync-bar' }, [
      el('div', {}, [
        el('div', { text: count + ' unsynced' }),
        el('div', { class: 'muted', text: 'Last synced: ' + lastText })
      ]),
      el('button', { type: 'button', class: 'btn', disabled: true }, 'Sync')
    ]),
    el('div', { class: 'muted msg', text: 'Sync to your Sheet arrives in Phase 6.' })
  ]);
}

function entryRow(ctx, block, today) {
  const first = block.lines[0];
  const tz = block.tz_offset_min;
  const names = block.lines.map((l) => l.category).join(' / ');
  const range = formatClock12(block.start_epoch, tz) + ' to ' + formatClock12(block.end_epoch, tz);
  const date = localDate(block.start_epoch, tz) === today ? '' : shortDate(block.start_epoch, tz) + ', ';
  const sub = names + ' · ' + date + range + ' · ' + formatDuration(block.end_epoch - block.start_epoch);
  return el('li', { class: 'row' }, [
    el('span', { class: 'dot', style: catStyle(slotFor(ctx, first.category)) }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title', text: truncateForList(first.label, 40) }),
      el('div', { class: 'muted', text: sub })
    ]),
    block.synced_version >= 1 ? el('span', { class: 'tag', text: 'edit' }) : null
  ]);
}

function unsyncedList(ctx) {
  const list = ctx.state.unsynced;
  const wrap = el('div', {}, [el('div', { class: 'section-label', text: 'Unsynced' })]);
  if (list.length === 0) {
    wrap.append(el('div', { class: 'card empty', text: 'Nothing waiting. Blocks you stop will show up here.' }));
    return wrap;
  }
  const today = localDate(ctx.nowEpoch(), ctx.tzOffsetMin());
  wrap.append(el('ul', { class: 'entry-list' }, list.map((b) => entryRow(ctx, b, today))));
  return wrap;
}

export function drawHome(ctx) {
  const root = ctx.panels.home;
  stopTicker();
  clear(root);
  root.append(
    el('div', { class: 'head' }, [el('h1', { class: 'title', text: 'my snitch.' })]),
    statusCard(ctx),
    syncBar(ctx),
    unsyncedList(ctx),
    el('p', { class: 'muted foot', text: 'app ' + ctx.version })
  );
  if (ctx.state.running) startTicker(ctx);
}
