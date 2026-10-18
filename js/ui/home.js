// home.js: the Home view (PRD section 5.1). It only draws and reacts to taps.
// Phase 3 built the status card, the sync bar and the unsynced list.
// Stop and Switch open the End screen (split at the moment a block ends). Change edits the running block.
// Phase 4 added the "missed something" button and the gap banner. Phase 5 added the sleep control
// and the "review last night" banner. Phase 7 made rows tappable (edit mode) and added the History link.

import { el, clear, catStyle } from './dom.js';
import { elapsedSeconds, displayMinutes } from '../model.js';
import { formatDuration, formatClock12, localDate, latestGap, sinceText, LONG_GAP_SEC } from '../time.js';
import { truncateForList } from '../labels.js';
import { categoryByName } from '../categories.js';
import { sleepTap } from './sleep-view.js';

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
  // A renamed category is still found by its earlier names, so old blocks keep their colour.
  const found = categoryByName(ctx.state.categories, name, false);
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
      el('div', { class: 'card-heading', text: 'What are you doing?' }),
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
    ? 'Nothing logged since ' + sinceText(gap.start, gap.end, tz)
    : 'Nothing logged from ' + formatClock12(gap.start, tz) + ' to ' + formatClock12(gap.end, tz);
  const others = gaps.length - 1;
  // After a silence over 14 hours the tap opens a choice (night or activities), not one huge block (v33).
  const long = gap.toNow && gap.end - gap.start > LONG_GAP_SEC;
  const sub = others > 0 ? (others === 1 ? '1 earlier gap today' : others + ' earlier gaps today') : long ? 'Tap to catch up' : 'Tap to fill it in';
  const open = () => ctx.show('entry', long ? { mode: 'catchup', gap: gap } : { mode: 'late', gap: gap });
  return el('button', { type: 'button', class: 'banner', onclick: open }, [
    el('div', { class: 'banner-title', text: text }),
    el('div', { class: 'banner-sub', text: sub })
  ]);
}

// Two fixed icons, written here as strings and never built from user text.
const MOON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/></svg>';

function sleepButton(icon, text, onclick) {
  const b = el('button', { type: 'button', class: 'btn btn-primary btn-sleep', onclick: onclick });
  b.innerHTML = icon;
  b.append(el('span', { text: text }));
  return b;
}

// The small sleep control in the corner (PRD section 5.4). One solid blue button for the next step:
// Going to bed when no night is open, then Woke up. There is no Fell asleep button, because nobody
// taps a phone while falling asleep. The morning check asks about it instead (decided 12 Oct 2026).
function sleepControl(ctx) {
  const night = ctx.state.openNight;
  if (!night) return el('div', { class: 'sleep-ctl' }, [sleepButton(MOON, 'Going to bed', () => sleepTap(ctx, 'bed'))]);
  return el('div', { class: 'sleep-ctl' }, [sleepButton(SUN, 'Woke up', () => sleepTap(ctx, 'wake'))]);
}

// Shown when never-synced blocks have waited over 24 hours (PRD section 9). One tap runs the sync, which opens
// Settings when no key is saved yet.
function staleBanner(ctx) {
  const n = ctx.state.stale;
  if (!n) return null;
  return el('button', { type: 'button', class: 'banner', onclick: () => ctx.sync() }, [
    el('div', { class: 'banner-title', text: n === 1 ? '1 block has waited over a day' : n + ' blocks have waited over a day' }),
    el('div', { class: 'banner-sub', text: ctx.state.hasKey ? 'Tap to sync now' : 'Tap to set up syncing' })
  ]);
}

// Shown when the running block has gone 6 hours without an answer (PRD section 11). Still going quiets it for 6 more
// hours. Stop opens the usual End screen. A block that ran too long can be shortened afterwards by editing it.
function longTimerBanner(ctx) {
  const lt = ctx.state.longTimer;
  const running = ctx.state.running;
  if (!lt || !running) return null;
  return el('div', { class: 'banner' }, [
    el('div', { class: 'banner-title', text: 'Still doing this?' }),
    el('div', { class: 'banner-sub', text: running.lines.map((l) => l.category).join(' / ') + ' has been running for ' + formatDuration(lt.seconds) + '.' }),
    el('div', { class: 'btn-row banner-actions' }, [
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => ctx.ackLongTimer() }, 'Still going'),
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('entry', { mode: 'end', next: 'stop' }) }, 'Stop')
    ])
  ]);
}

// Shown after a wake that nobody has reviewed yet. One tap opens the morning check.
function reviewBanner(ctx) {
  const night = ctx.state.unreviewed;
  if (!night) return null;
  return el('button', { type: 'button', class: 'banner', onclick: () => ctx.show('sleep', { nightId: night.night_id }) }, [
    el('div', { class: 'banner-title', text: 'Review last night' }),
    el('div', { class: 'banner-sub', text: night.auto_closed ? 'Auto-closed at 4:00 am. Tap to check the times.' : 'Tap to check bed, asleep and wake times.' })
  ]);
}

// The sync tile (v35, replaces the sync card). A narrow icon tile beside Missed something. It is solid blue
// once a key is saved, and opens Settings until then (the same job "Set up" did). While a sync runs the
// icon turns. The note about the last tap sits as one small line under the two tiles. The count and the
// last sync time moved into the Unsynced heading, and Change key lives in Settings only.
const SYNC_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.5-4.2L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.5 4.2L20 15"/><path d="M20 20v-5h-5"/></svg>';

function syncRow(ctx) {
  const hasKey = ctx.state.hasKey;
  const busy = ctx.state.syncing;
  const label = busy ? 'Syncing' : hasKey ? 'Sync' : 'Set up syncing';
  const sync = el('button', {
    type: 'button',
    class: 'btn sync-tile' + (hasKey ? ' btn-primary' : '') + (busy ? ' spinning' : ''),
    'aria-label': label,
    title: label,
    disabled: busy,
    onclick: () => ctx.sync()
  });
  sync.innerHTML = SYNC_ICON;
  const note = ctx.state.syncNote || (hasKey ? '' : 'Enter your Sheet key to start syncing.');
  return [
    el('div', { class: 'action-row' }, [sync, missedButton(ctx)]),
    ...(note ? [el('div', { class: 'muted msg sync-note', text: note })] : [])
  ];
}

// One row of a block list. Home lists the unsynced blocks and History lists the synced ones, with this same row.
// opts.onTap: what a tap does (edit mode). Leave it out for a row that does nothing, such as a pending deletion.
// opts.showDate: false hides the date in the row, for History, where a day heading already says it.
export function entryRow(ctx, block, today, opts) {
  const options = opts || {};
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
  const date = options.showDate === false || localDate(block.start_epoch, tz) === today ? '' : shortDate(block.start_epoch, tz) + ', ';
  const when = date + formatClock12(block.start_epoch, tz) + ' \u00b7 ' + formatDuration(block.end_epoch - block.start_epoch);
  // A block the Sheet already holds, with a newer version waiting, is an "edit". A deleted one waits to send its deletion.
  const tag = block.is_deleted ? 'deleted' : block.synced_version >= 1 && block.dirty === 1 ? 'edit' : null;
  const tappable = typeof options.onTap === 'function' && !block.is_deleted;
  return el('li', {
    class: 'row' + (tappable ? ' row-tap' : ''),
    role: tappable ? 'button' : null,
    tabindex: tappable ? '0' : null,
    onclick: tappable ? options.onTap : null,
    onkeydown: tappable ? (e) => { if (e.key === 'Enter' || e.key === ' ') options.onTap(); } : null
  }, [
    el('span', { class: 'dot', style: catStyle(slotFor(ctx, first.category)) }),
    // One line (v24): category, then the label, with the start time and length on the right.
    el('div', { class: 'row-main' }, [
      el('span', { class: 'row-title', text: names }),
      title ? el('span', { class: 'row-sub', text: ' \u00b7 ' + title }) : null
    ]),
    el('span', { class: 'row-when', text: when }),
    tag ? el('span', { class: 'tag', text: tag }) : null
  ]);
}

function unsyncedList(ctx) {
  const list = ctx.state.unsynced;
  // The label row carries the way into History, where synced blocks live (decided 17 Oct 2026, D64).
  const wrap = el('div', {}, [
    el('div', { class: 'list-head' }, [
      el('div', { class: 'section-label', text: 'Unsynced \u00b7 ' + list.length + ' \u00b7 last synced ' + (ctx.state.lastSyncedAt ? formatClock12(ctx.state.lastSyncedAt, ctx.tzOffsetMin()) : 'never') }),
      el('button', { type: 'button', class: 'btn btn-text key-link', onclick: () => ctx.show('history', { fresh: true }) }, 'History')
    ])
  ]);
  if (list.length === 0) {
    wrap.append(el('div', { class: 'card empty', text: 'Nothing waiting. Blocks you stop will show up here.' }));
    return wrap;
  }
  const today = localDate(ctx.nowEpoch(), ctx.tzOffsetMin());
  // Tapping a row edits the block (Phase 7, D35). The edit screen returns to Home.
  const tap = (b) => () => ctx.show('entry', { mode: 'edit', blockId: b.block_id, back: 'home' });
  wrap.append(el('ul', { class: 'entry-list' }, list.map((b) => entryRow(ctx, b, today, { onTap: tap(b) }))));
  return wrap;
}

const GEAR = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

// The app icon next to the title (v27). Two pictures sit here and the CSS shows one of them (v28):
// the blue square in light mode, and a white square with a blue "s" in dark mode, where the blue
// square vanished into the dark page. The empty alt text tells a screen reader to skip both,
// because the title says it all.
function brandMark() {
  return el('div', { class: 'brand-wrap' }, [
    el('img', { class: 'brand-icon brand-icon-light', src: 'icons/icon-192.png', alt: '', width: '28', height: '28' }),
    el('img', { class: 'brand-icon brand-icon-dark', src: 'icons/icon-header-dark.png', alt: '', width: '28', height: '28' }),
    el('h1', { class: 'brand', text: 'my snitch.' })
  ]);
}

function headerRight(ctx) {
  const gear = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Settings', title: 'Settings', onclick: () => ctx.show('settings') });
  gear.innerHTML = GEAR;
  return el('div', { class: 'head-right' }, [sleepControl(ctx), gear]);
}

export function drawHome(ctx) {
  const root = ctx.panels.home;
  stopTicker();
  clear(root);
  // append() prints a null as the word "null" (log I4), so an absent banner is left out of the list.
  const banner = gapBanner(ctx);
  const review = reviewBanner(ctx);
  const stale = staleBanner(ctx);
  const longT = longTimerBanner(ctx);
  root.append(
    el('div', { class: 'head' }, [brandMark(), headerRight(ctx)]),
    ...(review ? [review] : []),
    ...(stale ? [stale] : []),
    ...(longT ? [longT] : []),
    statusCard(ctx),
    ...(banner ? [banner] : []),
    ...syncRow(ctx),
    unsyncedList(ctx)
  );
  if (ctx.state.running) startTicker(ctx);
}
