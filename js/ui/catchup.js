// catchup.js: the choice shown when the gap banner is tapped after a long silence (v33, decision B1).
// A silence of more than 14 hours is days, not a forgotten stretch, so one big block would be wrong: it would
// put your sleep inside an activity. This screen offers the two tools that already exist, one at a time:
//   Add a missed night            opens the sleep screen on a draft night, starting at the first night after the silence began
//   Add activities for a day      opens Missed something with the day wheel, so you can pick the day
// Come back to the banner after each save: it shrinks as the days are filled in.
// (The full Catch up list, one row per missed day, is parked for after the trial: log decision B2.)

import { el, clear, backButton } from './dom.js';
import { sinceText, nightAfter } from '../time.js';
import { newNight, updateNight } from '../sleep.js';

export function openCatchup(ctx, root, data) {
  clear(root);
  const gap = data && data.gap ? data.gap : null;
  if (!gap) {
    ctx.show('home');
    return;
  }
  const tz = ctx.tzOffsetMin();
  const now = ctx.nowEpoch();

  function addNight() {
    let times = nightAfter(gap.start, tz);
    // If that night has not finished yet, start from the usual draft instead: 11:00 pm two days ago.
    if (times.wake > now) times = null;
    const bed = times ? times.bed : gap.start;
    const wake = times ? times.wake : now;
    const draft = updateNight(newNight({ bedEpoch: bed, offsetMin: tz, autoClosed: false, makeId: ctx.newId }), {
      wake_epoch: wake,
      wake_offset_min: tz
    });
    ctx.show('sleep', { draft: draft, back: 'home' });
  }

  root.append(
    el('div', { class: 'head page-head head-back' }, [backButton(() => ctx.show('home')), el('h2', { class: 'title', text: 'Catch up' })]),
    el('p', { class: 'catchup-lead', text: 'Nothing logged since ' + sinceText(gap.start, now, tz) + '.' }),
    el('p', { class: 'muted', text: 'That is long enough to include sleep. Fill it in one piece at a time. Each save brings you back here, and the banner on Home shrinks as you go.' }),
    el('div', { class: 'catchup-actions' }, [
      el('button', { type: 'button', class: 'btn btn-wide', onclick: addNight }, 'Add a missed night'),
      el('button', { type: 'button', class: 'btn btn-wide', onclick: () => ctx.show('entry', 'late') }, 'Add activities for a day')
    ])
  );
}
