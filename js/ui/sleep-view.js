// sleep-view.js: the sleep taps from Home, and the morning sleep check (PRD section 5.4).
//
// sleepTap saves one live moment (bed, fell asleep, woke up) the instant it is tapped, so the exact
// second is never lost. Woke up then opens the morning check, where bed, asleep and wake can be
// reviewed and fixed. Backing out of the check keeps the wake and leaves a "review" banner on Home.
// The rules live in sleep.js. This file only draws and reacts.

import { el, clear, section } from './dom.js';
import { getAllSleep, getSleep, getBlock, getAllBlocks, getAllLabels, getCategories, getRunningBlock, saveNight } from '../db.js';
import {
  planBed, planChange, planDiscard, openNight, nightConflict, updateNight, checkNight, isStaleOpenNight,
  tryingLinesOf, TRYING_LABEL, STALE_OPEN_HOURS, withReday, isLongNight
} from '../sleep.js';
import { formatClock12, formatDuration, localDate } from '../time.js';
import { usageCounts } from '../categories.js';
import { makeTimePicker } from './timepick.js';
import { makeShared } from './picks.js';
import { makeLines } from './lines.js';

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
    // A wake tap long after bed is probably a forgotten tap. Nothing is saved yet: the check opens
    // with the wake wheels showing, and the night is saved when you confirm the real time.
    if (kind === 'wake' && isStaleOpenNight(open, now)) {
      await ctx.show('sleep', { nightId: open.night_id, pendingWake: now });
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
    // A wake changes the day of blocks that follow it, so they are worked out again in the same save.
    await saveNight(ctx.db, kind === 'wake' ? withReday(plan, nights, await getAllBlocks(ctx.db)) : plan);
    if (kind === 'wake') await ctx.show('sleep', { nightId: open.night_id });
    else await ctx.refresh();
  } catch (err) {
    ctx.warn('Could not save that. Nothing was changed. Try again.');
  }
}

export async function openSleepCheck(ctx, root, data) {
  clear(root);
  const night = data && data.nightId ? await getSleep(ctx.db, data.nightId) : null;
  // pendingWake is the moment of a late Woke up tap. It is not saved until Looks right.
  const pendingWake = data && Number.isInteger(data.pendingWake) ? data.pendingWake : null;
  if (!night || (night.wake_epoch === null && pendingWake === null)) {
    await ctx.show('home');
    return;
  }
  const allBlocks = await getAllBlocks(ctx.db);
  const allNights = await getAllSleep(ctx.db);
  const existing = await existingBlocks(ctx.db, night);
  const shared = makeShared(await getCategories(ctx.db), usageCounts(allBlocks), await getAllLabels(ctx.db));
  const tz = ctx.tzOffsetMin();

  const clock = (epoch) => {
    const sameDay = localDate(epoch, tz) === localDate(ctx.nowEpoch(), tz);
    const parts = localDate(epoch, tz).split('-').map(Number);
    return (sameDay ? '' : parts[2] + ' ' + MONTHS[parts[1] - 1] + ', ') + formatClock12(epoch, tz);
  };

  // 'unset' means nothing is chosen yet. Nobody taps a phone while falling asleep, so the check asks.
  let asleepSpec = { kind: night.reviewed ? 'none' : 'unset' };
  let discardArmed = false;
  // Filling the lines at start-up fires change events before the screen exists, so update() waits for this.
  let built = false;
  // A night over 16 hours needs a second tap on Looks right. Any change to the times starts again.
  let longArmed = false;

  // ------------------------------------------------------------ the three moments

  const bedPicker = makeTimePicker(ctx, 'Bed', () => update());
  const asleepPicker = makeTimePicker(ctx, 'Asleep', () => update());
  const wakePicker = makeTimePicker(ctx, 'Wake', () => update());
  bedPicker.setEpoch(night.bed_epoch);
  wakePicker.setEpoch(night.wake_epoch === null ? pendingWake : night.wake_epoch);
  asleepPicker.setEpoch(night.asleep_epoch === null ? night.bed_epoch : night.asleep_epoch);
  for (const p of [bedPicker, asleepPicker, wakePicker]) p.node.hidden = true;
  if (pendingWake !== null) wakePicker.node.hidden = false;
  // The offset of the wake. A saved wake keeps its own, and a wake still to be saved takes this phone's.
  const wakeOffset = night.wake_offset_min !== null && night.wake_offset_min !== undefined ? night.wake_offset_min : tz;

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
    if (asleepSpec.kind === 'none' || asleepSpec.kind === 'unset') return null;
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

  // The stretch from bed to sleep. It can hold any mix of activities, with shares and live minutes.
  const ui = makeLines(ctx, shared, {
    getDuration: () => {
      const a = asleepEpoch();
      return a === null || a <= bedEpoch() ? null : a - bedEpoch();
    },
    onChange: () => update(),
    onMessage: (text) => { msg.textContent = text; }
  });
  ui.prefillAll(tryingLinesOf(night));

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

  // The lines the person has entered for the stretch before sleep, or the saved ones while a
  // category is still missing.
  function tryingLines() {
    return ui.ready() ? ui.getLines() : tryingLinesOf(night);
  }

  function candidate() {
    return updateNight(night, {
      bed_epoch: bedEpoch(),
      asleep_epoch: asleepEpoch(),
      wake_epoch: wakeEpoch(),
      wake_offset_min: wakeOffset,
      trying_lines: tryingLines()
    });
  }

  function update() {
    if (!built) return;
    longArmed = false;
    okBtn.textContent = 'Looks right';
    const c = candidate();
    bedText.textContent = clock(c.bed_epoch);
    wakeText.textContent = clock(c.wake_epoch);
    // The "before you fell asleep" card only makes sense when there is time between bed and sleep.
    const hasBefore = c.asleep_epoch !== null && c.asleep_epoch > c.bed_epoch;
    beforeSect.hidden = !hasBefore;
    wakeSect.querySelector('.sect-num').textContent = hasBefore ? '4' : '3';
    if (hasBefore) ui.refresh();
    const error = checkNight(c, ctx.nowEpoch());
    const conflict = error ? null : nightConflict(c, allBlocks, ctx.nowEpoch());
    const needsChoice = asleepSpec.kind === 'unset';
    const needsCategory = hasBefore && !ui.ready();
    if (needsChoice && !error) {
      msg.textContent = 'Pick how long it took to fall asleep, or Not tracked.';
      sumLine.textContent = '';
    } else if (error) {
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
    okBtn.disabled = !!error || !!conflict || needsChoice || needsCategory;
  }

  async function confirm() {
    if (okBtn.disabled) return;
    const c = candidate();
    if (isLongNight(c) && !longArmed) {
      longArmed = true;
      msg.textContent = 'That is a long night. If it is right, tap Yes, save it.';
      okBtn.textContent = 'Yes, save it';
      return;
    }
    okBtn.disabled = true;
    const plan = withReday(planChange(night, {
      bed_epoch: c.bed_epoch,
      asleep_epoch: c.asleep_epoch,
      wake_epoch: c.wake_epoch,
      wake_offset_min: wakeOffset,
      trying_lines: c.trying_lines,
      reviewed: true
    }, existing, ctx.nowEpoch()), allNights, allBlocks);
    if (plan.error) {
      msg.textContent = plan.error;
      update();
      return;
    }
    // Labels you typed count for suggestions. The default "trying to sleep" does not.
    if (c.asleep_epoch !== null && c.asleep_epoch > c.bed_epoch) {
      plan.bump = { lines: c.trying_lines.filter((l) => l.label !== '' && l.label !== TRYING_LABEL), now: ctx.nowEpoch() };
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

  const beforeSect = section(3, 'Before you fell asleep', [
    el('p', { class: 'muted', text: 'What did you do between going to bed and falling asleep? Split it if it was more than one thing.' }),
    ui.node,
    ui.splitBtn
  ]);
  const wakeSect = section(3, 'Woke up', [
    pendingWake !== null
      ? el('p', { class: 'muted', text: 'It is more than ' + STALE_OPEN_HOURS + ' hours since you went to bed. Set the time you really woke up. Nothing is saved until you tap Looks right.' })
      : null,
    el('div', { class: 'chip-row' }, [wakeText, changeBtn(wakePicker)]),
    wakePicker.node
  ]);

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
      asleepPicker.node
    ]),
    beforeSect,
    wakeSect,
    sumLine,
    msg,
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Later'),
      okBtn
    ]),
    el('div', { class: 'discard' }, [discardBtn])
  );
  built = true;
  drawChips();
  update();
}
