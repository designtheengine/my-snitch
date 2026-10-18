// timepick.js: the exact time picker for late logging (PRD section 5.2).
// A day, then hour and minute, then am or pm, as drop-down wheels. No seconds: typing seconds
// for a block you are logging afterwards is too fiddly (decided 11 Oct 2026). Start and stop
// timers still keep seconds, and so do times that come from a chip or a gap.

import { el } from './dom.js';
import { epochFromLocal, localDate, addDays } from '../time.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_BACK = 29; // today and the 29 days before it, 30 in all (decided 18 Oct 2026, Q19)

const two = (n) => String(n).padStart(2, '0');

function dayLabel(dateStr, today) {
  if (dateStr === today) return 'Today';
  if (dateStr === addDays(today, -1)) return 'Yesterday';
  const parts = dateStr.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()];
  return weekday + ' ' + parts[2] + ' ' + MONTHS[parts[1] - 1];
}

function makeSelect(label, options) {
  return el(
    'select',
    { class: 'select', 'aria-label': label },
    options.map((o) => el('option', { value: o.value, text: o.text }))
  );
}

// title: small heading above the wheels. onChange runs after any wheel moves.
export function makeTimePicker(ctx, title, onChange) {
  const tz = ctx.tzOffsetMin();
  const today = localDate(ctx.nowEpoch(), tz);

  const days = [];
  for (let i = 0; i <= DAYS_BACK; i++) {
    const d = addDays(today, -i);
    days.push({ value: d, text: dayLabel(d, today) });
  }
  const daySel = makeSelect(title + ' day', days);
  const hourSel = makeSelect(
    title + ' hour',
    Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), text: String(i + 1) }))
  );
  const minSel = makeSelect(
    title + ' minute',
    Array.from({ length: 60 }, (_, i) => ({ value: String(i), text: two(i) }))
  );
  const ampmSel = makeSelect(title + ' am or pm', [
    { value: 'am', text: 'am' },
    { value: 'pm', text: 'pm' }
  ]);

  // An epoch set from outside keeps its seconds until a wheel moves. A gap that starts at
  // 12:00:23 must not turn into 12:00:00 and overlap the block before it.
  let exact = null;
  for (const s of [daySel, hourSel, minSel, ampmSel]) {
    s.addEventListener('change', () => {
      exact = null;
      onChange();
    });
  }

  function ensureDay(dateStr) {
    for (const o of daySel.options) if (o.value === dateStr) return;
    daySel.append(el('option', { value: dateStr, text: dayLabel(dateStr, today) }));
  }

  const picker = {
    node: el('div', { class: 'picker' }, [el('div', { class: 'picker-row' }, [daySel, hourSel, minSel, ampmSel])]),
    // The epoch the wheels show. Whole minutes, unless it was set from outside and not touched since.
    getEpoch() {
      if (exact !== null) return exact;
      const h12 = Number(hourSel.value);
      const h24 = (h12 % 12) + (ampmSel.value === 'pm' ? 12 : 0);
      return epochFromLocal(daySel.value, h24, Number(minSel.value), 0, tz);
    },
    // Moves the wheels to an epoch. Does not call onChange.
    setEpoch(epoch) {
      exact = epoch;
      const date = localDate(epoch, tz);
      ensureDay(date);
      daySel.value = date;
      const secsInDay = (((epoch + tz * 60) % 86400) + 86400) % 86400;
      const h24 = Math.floor(secsInDay / 3600);
      hourSel.value = String(h24 % 12 === 0 ? 12 : h24 % 12);
      minSel.value = String(Math.floor((secsInDay % 3600) / 60));
      ampmSel.value = h24 < 12 ? 'am' : 'pm';
    }
  };
  picker.setEpoch(ctx.nowEpoch());
  return picker;
}
