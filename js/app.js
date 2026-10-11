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
  getSetting
} from './db.js';
import { reportingDay, dayGaps } from './time.js';
import { drawHome, stopTicker } from './ui/home.js';
import { openEntry } from './ui/entry.js';

// Shown at the bottom of Home. Change it together with CACHE_VERSION in sw.js on every release.
export const APP_VERSION = 'v10';

const panels = {
  home: document.getElementById('home'),
  entry: document.getElementById('entry')
};
const warnEl = document.getElementById('warn');

let ctx = null;
let current = 'home';

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

// Phase 5 adds the wake times from the sleep store here. Until then no wake exists,
// so the day is the date of the start time minus four hours (spec section 6.3).
function dayFor(startEpoch) {
  return reportingDay(startEpoch, tzOffsetMin(), []);
}

function warn(message) {
  warnEl.textContent = message + ' (tap to hide)';
  warnEl.hidden = false;
}

warnEl.addEventListener('click', () => {
  warnEl.hidden = true;
});

async function loadState(db) {
  const now = nowEpoch();
  const [categories, running, dirty, lastSyncedAt, dayBlocks, gapMin] = await Promise.all([
    getCategories(db),
    getRunningBlock(db),
    getDirtyBlocks(db),
    getSetting(db, 'last_synced_at'),
    getBlocksByDay(db, dayFor(now)),
    getSetting(db, 'gap_threshold_min')
  ]);
  // Blocks still running are never synced, so they are not in the list.
  const unsynced = dirty
    .filter((b) => b.running !== 1 && b.end_epoch !== null && !b.is_deleted)
    .sort((a, b) => b.start_epoch - a.start_epoch);
  // The gap banner reads today's blocks plus the running one, which may have started on an earlier day.
  const gapBlocks = running && !dayBlocks.some((b) => b.block_id === running.block_id) ? dayBlocks.concat([running]) : dayBlocks;
  const gaps = dayGaps({ blocks: gapBlocks, nowEpoch: now, thresholdSec: gapMin * 60 }).map((g) => ({
    start: g.start,
    end: g.end,
    toNow: g.end === now
  }));
  return {
    categories: categories,
    running: running || null,
    unsynced: unsynced,
    gaps: gaps,
    lastSyncedAt: lastSyncedAt || null
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
  } catch (err) {
    warn('Something went wrong reading your saved data.');
  }
  window.scrollTo(0, 0);
}

// The theme follows the phone unless Settings forces light or dark (Settings arrives in Phase 8).
async function applyTheme(db) {
  const theme = await getSetting(db, 'theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  else document.documentElement.removeAttribute('data-theme');
}

async function boot() {
  try {
    const db = await openDb();
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
      refresh: refresh
    };
    await applyTheme(db);
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
  if (!document.hidden && ctx && current === 'home') refresh().catch(() => {});
});

boot();
