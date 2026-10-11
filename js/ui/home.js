// home.js: the Home view (PRD section 5.1). It only draws and reacts to taps.
// Phase 3 built the status card, the sync bar and the unsynced list.
// Stop and Switch open the End screen (split at the moment a block ends). Change edits the running block.
// Phase 4 added the "missed something" button and the gap banner. The sleep control arrives in Phase 5.

import { el, clear, catStyle } from './dom.js';
import { elapsedSeconds, displayMinutes } from '../model.js';
import { formatDuration, formatClock12, localDate, latestGap } from '../time.js';
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
  return el('div', { class: 'card' }, [
    el('div', { class: 'status-line' }, [
      el('span', { class: 'dot', style: catStyle(slotFor(ctx, first.category)) }),
      el('span', { text: names })
    ]),
    el('div', { class: 'status-label muted', text: (first.label ? first.label : '(no label)') + ' · since ' + formatClock12(running.start_epoch, running.tz_offset_min) }),
    el('div', { class: 'timer', id: 'timer', text: formatDuration(elapsedSeconds(running, ctx.nowEpoch())) }),
    // Stop and Switch open the End screen, where the block can be split. Change fixes the category
    // or label of the running block and the timer keeps counting.
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => ctx.show('entry', { mode: 'end', next: 'stop' }) }, 'Stop'),
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('entry', { mode: 'end', next: 'switch' }) }, 'Switch'),
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('entry', 'change') }, 'Change')
    ])
  ]);
}

// The button beside the status card (PRD section 5.1) that opens late mode.
function missedButton(ctx) {
  return el('button', { type: 'button', class: 'btn btn-wide missed', onclick: () => ctx.show('entry', 'late') }, 'Missed something');
}

// Shown only when untracked time exists. One tap opens late mode with the latest gap filled in.
function gapBanner(ctx) {
  const gaps = ctx.state.gaps;
  const gap = latestGap(gaps);
  if (!gap) return null;
  const tz = ctx.tzOffsetMin();
  const text = gap.toNow
    ? 'Nothing logged since ' + formatClock12(gap.start, tz)
    : 'Nothing logged from ' + formatClock12(gap.start, tz) + ' to ' + formatClock12(gap.end, tz);
  const others = gaps.length - 1;
  const sub = others > 0 ? (others === 1 ? '1 earlier gap today' : others + ' earlier gaps today') : 'Tap to fill it in';
  return el('button', { type: 'button', class: 'banner', onclick: () => ctx.show('entry', { mode: 'late', gap: gap }) }, [
    el('div', { class: 'banner-title', text: text }),
    el('div', { class: 'banner-sub', text: sub })
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
  const split = block.lines.length > 1;
  // A split block still shows as one row. Its title joins the labels, and its second line
  // lists every activity with its minutes, so nothing is hidden. The Sheet gets one row per line.
  const labels = block.lines.map((l) => l.label).filter((t) => t !== '');
  const title = split ? truncateForList(labels.join(' / '), 40) : truncateForList(first.label, 40);
  // Minutes add up to the block's minutes (the same split math as the entry form).
  const mins = split ? displayMinutes(block.end_epoch - block.start_epoch, block.lines.map((l) => l.share_pct)) : null;
  const names = split ? block.lines.map((l, i) => l.category + ' ' + mins[i] + ' min').join(' / ') : first.category;
  const range = formatClock12(block.start_epoch, tz) + ' to ' + formatClock12(block.end_epoch, tz);
  const date = localDate(block.start_epoch, tz) === today ? '' : shortDate(block.start_epoch, tz) + ', ';
  const sub = names + ' \u00b7 ' + date + range + ' \u00b7 ' + formatDuration(block.end_epoch - block.start_epoch);
  return el('li', { class: 'row' }, [
    el('span', { class: 'dot', style: catStyle(slotFor(ctx, first.category)) }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title', text: title }),
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
  // append() prints a null as the word "null" (log I4), so an absent banner is left out of the list.
  const banner = gapBanner(ctx);
  root.append(
    el('div', { class: 'head' }, [el('h1', { class: 'title', text: 'my snitch.' })]),
    statusCard(ctx),
    missedButton(ctx),
    ...(banner ? [banner] : []),
    syncBar(ctx),
    unsyncedList(ctx),
    el('p', { class: 'muted foot', text: 'app ' + ctx.version })
  );
  if (ctx.state.running) startTicker(ctx);
}
