// app.js: start-up and the panels (spec section 7). One page, panels that show and hide.
// It opens the database, loads what the screens need, and passes a small "ctx" object
// to the screen files. The rules live in model.js, the storage in db.js.

import {
  openDb,
  seedCategories,
  getCategories,
  getRunningBlock,
  getDirtyBlocks,
  getBlocksByDay,
  getSetting,
  getAllSleep,
  getAllBlocks,
  saveNight,
  setSetting,
  markDelivered,
  markAttemptedBlocks
} from './db.js';
import { reportingDay, dayGaps } from './time.js';
import { wakesFrom, latestWake, heldBlockIds, openNight, unreviewedNight, planAutoClose } from './sleep.js';
import { drawHome, stopTicker } from './ui/home.js';
import { openEntry } from './ui/entry.js';
import { openSleepCheck } from './ui/sleep-view.js';
import { openSettings } from './ui/settings.js';
import { openHistory } from './ui/history.js';
import { runSync, syncLock, friendlyError, DEFAULT_SCRIPT_URL } from './sync.js';
import { addEntry } from './errorlog.js';
import { staleUnsynced, longTimer } from './safeguards.js';

// Shown at the bottom of Home. Change it together with CACHE_VERSION in sw.js on every release.
export const APP_VERSION = 'v29';

const panels = {
  home: document.getElementById('home'),
  entry: document.getElementById('entry'),
  sleep: document.getElementById('sleep'),
  settings: document.getElementById('settings'),
  history: document.getElementById('history')
};
const warnEl = document.getElementById('warn');

let ctx = null;
let current = 'home';
// Wake events from the sleep store, kept up to date by loadState, so dayFor stays a plain function.
let wakes = [];
// The Sync button's state. The note is the line under the button, and it lasts until the next tap.
let syncing = false;
let syncNote = '';

function nowEpoch() {
  return Math.floor(Date.now() / 1000);
}

// Minutes east of UTC. India is +330. The browser counts the other way round, hence the minus.
function tzOffsetMin() {
  return -new Date().getTimezoneOffset();
}

// A random id for each new block. randomUUID needs iOS 15.4, so older phones use the fallback.
function newId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The most recent wake at or before the start decides the day. With no wake yet (the first days),
// the day is the date of the start time minus four hours (spec section 6.3).
function dayFor(startEpoch) {
  return reportingDay(startEpoch, tzOffsetMin(), wakes);
}

// The local error log (spec section 12). The last 50 problems are kept in the settings store, so
// Settings can copy them. Callers pass fixed sentences and short codes, never the key. A failure to
// write the log is ignored, because the log must never cause a problem of its own.
let dbRef = null;
async function logEvent(kind, text) {
  if (!dbRef) return;
  try {
    const list = (await getSetting(dbRef, 'error_log')) || [];
    await setSetting(dbRef, 'error_log', addEntry(list, { t: nowEpoch(), kind: kind, text: text }));
  } catch (err) {
    // nothing to do
  }
}

function warn(message) {
  logEvent('warning', message);
  warnEl.textContent = message + ' (tap to hide)';
  warnEl.hidden = false;
}

warnEl.addEventListener('click', () => {
  warnEl.hidden = true;
});

async function loadState(db) {
  const now = nowEpoch();
  // The nights come first, because every day below depends on the wake times.
  const nights = await getAllSleep(db);
  wakes = wakesFrom(nights);
  const held = heldBlockIds(nights);
  const [categories, running, dirty, lastSyncedAt, dayBlocks, gapMin, key, ack] = await Promise.all([
    getCategories(db),
    getRunningBlock(db),
    getDirtyBlocks(db),
    getSetting(db, 'last_synced_at'),
    getBlocksByDay(db, dayFor(now)),
    getSetting(db, 'gap_threshold_min'),
    getSetting(db, 'secret_key'),
    getSetting(db, 'long_timer_ack')
  ]);
  // Blocks still running are never synced, so they are not in the list. Neither are the blocks of a
  // night whose wake is not logged yet: they wait until the day they count toward is known.
  // A deleted block that the Sheet holds stays in the list until its deletion is sent (Phase 7), so the
  // unsynced count is honest. It shows a "deleted" tag and cannot be tapped.
  const unsynced = dirty
    .filter((b) => b.running !== 1 && b.end_epoch !== null && !held.has(b.block_id))
    .sort((a, b) => b.start_epoch - a.start_epoch);
  // The gap banner reads today's blocks plus the running one, which may have started on an earlier day.
  const gapBlocks = running && !dayBlocks.some((b) => b.block_id === running.block_id) ? dayBlocks.concat([running]) : dayBlocks;
  const gaps = dayGaps({ blocks: gapBlocks, nowEpoch: now, thresholdSec: gapMin * 60, wakeEpoch: latestWake(nights) }).map((g) => ({
    start: g.start,
    end: g.end,
    toNow: g.end === now
  }));
  return {
    categories: categories,
    running: running || null,
    unsynced: unsynced,
    gaps: gaps,
    openNight: openNight(nights),
    unreviewed: unreviewedNight(nights),
    // The safeguards (Phase 8): blocks that waited over 24 hours, and a timer that ran 6 hours unanswered.
    stale: staleUnsynced(unsynced, now),
    longTimer: longTimer(running, ack || null, now),
    lastSyncedAt: lastSyncedAt || null,
    // Only whether a key exists goes into the state, never the key itself.
    hasKey: !!key,
    syncing: syncing,
    syncNote: syncNote
  };
}

async function refresh() {
  ctx.state = await loadState(ctx.db);
  if (current === 'home') drawHome(ctx);
}

async function show(name, arg) {
  current = name;
  for (const key of Object.keys(panels)) panels[key].hidden = key !== name;
  stopTicker();
  try {
    if (name === 'home') await refresh();
    else if (name === 'entry') await openEntry(ctx, arg || 'start');
    else if (name === 'sleep') await openSleepCheck(ctx, panels.sleep, arg);
    else if (name === 'settings') await openSettings(ctx, panels.settings);
    else if (name === 'history') await openHistory(ctx, panels.history, arg);
  } catch (err) {
    console.error(err);
    logEvent('screen', 'could not open ' + name + ': ' + (err && err.message ? err.message : 'unknown'));
    warn('Something went wrong reading your saved data.');
  }
  window.scrollTo(0, 0);
}

// "Still going" on the long timer check: saves the answer for this block, so the question waits 6 more hours.
async function ackLongTimer() {
  const running = ctx.state.running;
  if (!running) return;
  try {
    await setSetting(ctx.db, 'long_timer_ack', { block_id: running.block_id, at: nowEpoch() });
  } catch (err) {
    warn('Could not save your answer. Nothing was changed. Try again.');
    return;
  }
  await refresh();
}

function setSyncNote(text) {
  syncNote = text;
}

// One tap of the Sync button (PRD section 8). It sends every unsynced block in batches, with the
// lock from sync.js holding those blocks still, then marks the confirmed ones as synced and lets go.
async function doSync() {
  if (syncing || !ctx) return;
  const db = ctx.db;
  const key = await getSetting(db, 'secret_key');
  if (!key) {
    await show('settings');
    return;
  }
  syncing = true;
  syncNote = '';
  await refresh();
  try {
    const url = (await getSetting(db, 'script_url')) || DEFAULT_SCRIPT_URL;
    const [blocks, nights] = await Promise.all([getAllBlocks(db), getAllSleep(db)]);
    const result = await runSync({
      blocks: blocks,
      nights: nights,
      url: url,
      key: key,
      appVersion: APP_VERSION,
      syncId: 's-' + newId(),
      fetchFn: (u, o) => fetch(u, o),
      onAttempt: (sending) => markAttemptedBlocks(db, sending)
    });
    if (result.delivered.length > 0) await markDelivered(db, result.delivered);
    if (result.status === 'ok') await setSetting(db, 'last_synced_at', nowEpoch());
    if (result.status === 'nothing') syncNote = 'Nothing to sync.';
    else if (result.status === 'ok') syncNote = 'Synced ' + result.blockCount + (result.blockCount === 1 ? ' block.' : ' blocks.');
    else {
      syncNote = friendlyError(result.error);
      logEvent('sync', 'failed: ' + result.error);
    }
  } catch (err) {
    console.error(err);
    logEvent('sync', 'stopped: ' + (err && err.message ? err.message : 'unknown'));
    syncNote = 'The sync stopped. Nothing was lost. Try again.';
  } finally {
    syncLock.release();
    syncing = false;
  }
  await refresh();
}

// The theme follows the phone unless Settings forces light or dark (built in Phase 8).
async function applyTheme(db) {
  const theme = await getSetting(db, 'theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

// The 4:00 am rule (spec section 6.3, rule 4). When the app opens and the day has a wake but no bed,
// and it is past 04:00 on a later date, the day closes with an auto-closed bed at that 04:00.
async function autoClose(db) {
  try {
    const nights = await getAllSleep(db);
    const plan = planAutoClose({
      nights: nights,
      running: await getRunningBlock(db),
      now: nowEpoch(),
      makeId: newId
    });
    if (plan) await saveNight(db, plan);
  } catch (err) {
    logEvent('auto-close', err && err.message ? err.message : 'unknown');
    warn('Could not close yesterday at 4:00 am. Nothing was changed.');
  }
}

async function boot() {
  try {
    const db = await openDb();
    dbRef = db;
    await seedCategories(db, nowEpoch());
    ctx = {
      db: db,
      panels: panels,
      state: null,
      version: APP_VERSION,
      nowEpoch: nowEpoch,
      tzOffsetMin: tzOffsetMin,
      newId: newId,
      dayFor: dayFor,
      warn: warn,
      show: show,
      refresh: refresh,
      sync: doSync,
      setSyncNote: setSyncNote,
      applyTheme: () => applyTheme(db),
      ackLongTimer: ackLongTimer
    };
    await applyTheme(db);
    await autoClose(db);
    await show('home');
  } catch (err) {
    panels.home.textContent = 'Storage could not open on this phone. Close the app and open it again.';
  }
}

// Swipe right from the left edge to go back to Home, so nobody has to scroll down to Cancel
// (decided 11 Oct 2026). Only a swipe that starts within 30px of the edge counts, so the category
// strips and the share sliders keep working. It discards the form, the same as Cancel.
// Unproven on the phone: whether iOS leaves this edge swipe to the page in the installed app.
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  swipe = current !== 'home' && e.touches.length === 1 && t.clientX <= 30 ? { x: t.clientX, y: t.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!swipe || e.touches.length > 0) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = Math.abs(t.clientY - swipe.y);
  swipe = null;
  if (dx > 70 && dy < 60 && current !== 'home') show('home');
}, { passive: true });
document.addEventListener('touchcancel', () => {
  swipe = null;
}, { passive: true });

// Coming back to the app redraws Home, so the timer shows the right elapsed time at once.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !ctx) return;
  if (current === 'home') autoClose(ctx.db).then(() => refresh()).catch(() => {});
});

// Problems nobody caught go into the error log too, so Copy log can show them.
window.addEventListener('error', (e) => {
  logEvent('error', (e && e.message ? e.message : 'unknown') + (e && e.lineno ? ' (line ' + e.lineno + ')' : ''));
});
window.addEventListener('unhandledrejection', (e) => {
  logEvent('error', 'unhandled: ' + (e && e.reason && e.reason.message ? e.reason.message : 'unknown'));
});

boot();
