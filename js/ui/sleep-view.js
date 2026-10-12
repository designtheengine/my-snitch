// sleep-view.js: the sleep taps from Home, and the morning sleep check (PRD section 5.4).
//
// sleepTap saves one live moment (bed, fell asleep, woke up) the instant it is tapped, so the exact
// second is never lost. Woke up then opens the morning check, where bed, asleep and wake can be
// reviewed and fixed. Backing out of the check keeps the wake and leaves a "review" banner on Home.
// The rules live in sleep.js. This file only draws and reacts.

import { el, clear, section } from './dom.js';
import { getAllSleep, getSleep, getBlock, getAllBlocks, getRunningBlock, saveNight } from '../db.js';
import {
  planBed, planChange, planDiscard, openNight, nightConflict, updateNight, checkNight,
  SLEEP_CATEGORY, DOOM_CATEGORY
} from '../sleep.js';
import { formatClock12, formatDuration, localDate } from '../time.js';
import { makeTimePicker } from './timepick.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const AFTER_CHIPS = [
  { text: '10 min after', min: 10 },
  { text: '30 min after', min: 30 },
  { text: '1 hour after', min: 60 },
  { text: '90 min after', min: 90 }
];

// The blocks a night already has in storage, as {block_id: block}.
async function existingBlocks(db, night) {
  const out = {};
  for (const id of [night.bed_block_id, night.sleep_block_id]) {
    const b = await getBlock(db, id);
    if (b) out[id] = b;
  }
  return out;
}

// kind: 'bed', 'asleep' or 'wake'. One tap, saved at once.
export async function sleepTap(ctx, kind) {
  const now = ctx.nowEpoch();
  try {
    const nights = await getAllSleep(ctx.db);
    const open = openNight(nights);
    if (kind === 'bed') {
      if (!open) {
        const running = await getRunningBlock(ctx.db);
        await saveNight(ctx.db, planBed({ running: running || null, now: now, offsetMin: ctx.tzOffsetMin(), makeId: ctx.newId }));
      }
      await ctx.refresh();
      return;
    }
    if (!open) {
      await ctx.refresh();
      return;
    }
    const existing = await existingBlocks(ctx.db, open);
    const changes = kind === 'asleep' ? { asleep_epoch: now } : { wake_epoch: now, wake_offset_min: ctx.tzOffsetMin() };
    const plan = planChange(open, changes, existing, now);
    if (plan.error) {
      ctx.warn(plan.error);
      return;
    }
    // A night closed by the 4:00 am rule has no blocks yet. If its blocks would land on time that was
    // logged by hand, only the wake is saved now, and the check makes you settle the times first.
    if (kind === 'wake' && Object.keys(existing).length === 0 && nightConflict(plan.night, await getAllBlocks(ctx.db), now)) {
      plan.save = [];
      plan.remove = [];
    }
    await saveNight(ctx.db, plan);
    if (kind === 'wake') await ctx.show('sleep', { nightId: open.night_id });
    else await ctx.refresh();
  } catch (err) {
    ctx.warn('Could not save that. Nothing was changed. Try again.');
  }
}

export async function openSleepCheck(ctx, root, data) {
  clear(root);
  const night = data && data.nightId ? await getSleep(ctx.db, data.nightId) : null;
  if (!night || night.wake_epoch === null) {
    await ctx.show('home');
    return;
  }
  const allBlocks = await getAllBlocks(ctx.db);
  const existing = await existingBlocks(ctx.db, night);
  const tz = ctx.tzOffsetMin();

  const clock = (epoch) => {
    const sameDay = localDate(epoch, tz) === localDate(ctx.nowEpoch(), tz);
    const parts = localDate(epoch, tz).split('-').map(Number);
    return (sameDay ? '' : parts[2] + ' ' + MONTHS[parts[1] - 1] + ', ') + formatClock12(epoch, tz);
  };

  let tryingCategory = night.trying_category || SLEEP_CATEGORY;
  let asleepSpec = { kind: 'none' };
  let discardArmed = false;

  // ------------------------------------------------------------ the three moments

  const bedPicker = makeTimePicker(ctx, 'Bed', () => update());
  const asleepPicker = makeTimePicker(ctx, 'Asleep', () => update());
  const wakePicker = makeTimePicker(ctx, 'Wake', () => update());
  bedPicker.setEpoch(night.bed_epoch);
  wakePicker.setEpoch(night.wake_epoch);
  asleepPicker.setEpoch(night.asleep_epoch === null ? night.bed_epoch : night.asleep_epoch);
  for (const p of [bedPicker, asleepPicker, wakePicker]) p.node.hidden = true;

  if (night.asleep_epoch !== null) {
    const diff = night.asleep_epoch - night.bed_epoch;
    const hit = AFTER_CHIPS.find((c) => c.min * 60 === diff);
    asleepSpec = hit ? { kind: 'after', min: hit.min } : { kind: 'exact' };
    if (asleepSpec.kind === 'exact') asleepPicker.node.hidden = false;
  }

  function bedEpoch() {
    return bedPicker.getEpoch();
  }

  function asleepEpoch() {
    if (asleepSpec.kind === 'none') return null;
    if (asleepSpec.kind === 'after') return bedEpoch() + asleepSpec.min * 60;
    return asleepPicker.getEpoch();
  }

  function wakeEpoch() {
    return wakePicker.getEpoch();
  }

  // A time shown as text, with a Change button that opens its wheels.
  const bedText = el('span', { class: 'summary' });
  const wakeText = el('span', { class: 'summary' });
  const changeBtn = (picker) =>
    el('button', { type: 'button', class: 'btn btn-small', onclick: () => { picker.node.hidden = !picker.node.hidden; } }, 'Change');

  const asleepRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Fell asleep' });
  const tryRow = el('div', { class: 'chip-row', role: 'group', 'aria-label': 'What the time before sleep was' });
  const tryBox = el('div', {}, [
    el('p', { class: 'muted', text: 'Bed to asleep: was it trying to sleep, or scrolling?' }),
    tryRow
  ]);

  function chip(text, selected, onclick) {
    return el('button', { type: 'button', class: 'chip', 'aria-pressed': String(selected), onclick: onclick }, text);
  }

  function drawChips() {
    clear(asleepRow);
    for (const c of AFTER_CHIPS) {
      asleepRow.append(chip(c.text, asleepSpec.kind === 'after' && asleepSpec.min === c.min, () => chooseAsleep({ kind: 'after', min: c.min })));
    }
    asleepRow.append(
      chip('Exact time', asleepSpec.kind === 'exact', () => chooseAsleep({ kind: 'exact' })),
      chip('Not tracked', asleepSpec.kind === 'none', () => chooseAsleep({ kind: 'none' }))
    );
    asleepPicker.node.hidden = asleepSpec.kind !== 'exact';
    clear(tryRow);
    tryRow.append(
      chip('Trying to sleep', tryingCategory === SLEEP_CATEGORY, () => { tryingCategory = SLEEP_CATEGORY; drawChips(); update(); }),
      chip('Doomscrolling', tryingCategory === DOOM_CATEGORY, () => { tryingCategory = DOOM_CATEGORY; drawChips(); update(); })
    );
  }

  function chooseAsleep(spec) {
    // Opening the exact wheels starts from whatever the chip meant a moment ago.
    if (spec.kind === 'exact' && asleepSpec.kind === 'after') asleepPicker.setEpoch(asleepEpoch());
    asleepSpec = spec;
    drawChips();
    update();
  }

  // ------------------------------------------------------------ checking and saving

  const msg = el('p', { class: 'muted msg form-msg' });
  const sumLine = el('p', { class: 'muted' });
  const okBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: () => confirm() }, 'Looks right');

  function candidate() {
    return updateNight(night, {
      bed_epoch: bedEpoch(),
      asleep_epoch: asleepEpoch(),
      wake_epoch: wakeEpoch(),
      trying_category: tryingCategory
    });
  }

  function update() {
    const c = candidate();
    bedText.textContent = clock(c.bed_epoch);
    wakeText.textContent = clock(c.wake_epoch);
    tryBox.hidden = !(c.asleep_epoch !== null && c.asleep_epoch > c.bed_epoch);
    const error = checkNight(c, ctx.nowEpoch());
    const conflict = error ? null : nightConflict(c, allBlocks, ctx.nowEpoch());
    if (error) {
      msg.textContent = error;
      sumLine.textContent = '';
    } else if (conflict) {
      const first = conflict.lines[0];
      msg.textContent = 'This overlaps ' + first.category + (first.label ? ', ' + first.label : '') + ' (' + clock(conflict.start_epoch) + ' to ' + (conflict.end_epoch === null ? 'now' : clock(conflict.end_epoch)) + '). Change the times so they do not.';
      sumLine.textContent = '';
    } else {
      msg.textContent = '';
      const parts = [];
      if (c.asleep_epoch !== null) parts.push('Took ' + formatDuration(c.asleep_epoch - c.bed_epoch) + ' to fall asleep');
      parts.push('In bed ' + formatDuration(c.wake_epoch - c.bed_epoch));
      sumLine.textContent = parts.join(' · ');
    }
    okBtn.disabled = !!error || !!conflict;
  }

  async function confirm() {
    if (okBtn.disabled) return;
    okBtn.disabled = true;
    const c = candidate();
    const plan = planChange(night, {
      bed_epoch: c.bed_epoch,
      asleep_epoch: c.asleep_epoch,
      wake_epoch: c.wake_epoch,
      trying_category: tryingCategory,
      reviewed: true
    }, existing, ctx.nowEpoch());
    if (plan.error) {
      msg.textContent = plan.error;
      update();
      return;
    }
    try {
      await saveNight(ctx.db, plan);
    } catch (err) {
      ctx.warn('Could not save the night. Nothing was changed. Try again.');
      update();
      return;
    }
    await ctx.show('home');
  }

  async function discard() {
    if (!discardArmed) {
      discardArmed = true;
      discardBtn.textContent = 'Tap again to discard this night';
      return;
    }
    try {
      await saveNight(ctx.db, planDiscard(night, existing));
    } catch (err) {
      ctx.warn('Could not discard the night. Nothing was changed.');
      return;
    }
    await ctx.show('home');
  }

  const discardBtn = el('button', { type: 'button', class: 'btn btn-text', onclick: () => discard() }, 'Discard this night');

  // ------------------------------------------------------------ the screen

  root.append(
    el('div', { class: 'head page-head' }, [el('h2', { class: 'title', text: 'Last night' })]),
    section(1, 'Went to bed', [
      night.auto_closed ? el('p', { class: 'muted', text: 'Bed was not logged, so the day closed at 4:00 am. Change the time if you slept earlier.' }) : null,
      el('div', { class: 'chip-row' }, [bedText, changeBtn(bedPicker)]),
      bedPicker.node
    ]),
    section(2, 'Fell asleep', [
      el('p', { class: 'muted', text: 'About how long after bed?' }),
      asleepRow,
      asleepPicker.node,
      tryBox
    ]),
    section(3, 'Woke up', [
      el('div', { class: 'chip-row' }, [wakeText, changeBtn(wakePicker)]),
      wakePicker.node
    ]),
    sumLine,
    msg,
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Later'),
      okBtn
    ]),
    el('div', { class: 'discard' }, [discardBtn])
  );
  drawChips();
  update();
}
