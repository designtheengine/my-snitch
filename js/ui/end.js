// end.js: the End screen. Tapping Stop or Switch on Home opens it, so a block that held
// several activities can be split at the moment it ends, with no editing later (decided 11 Oct 2026).
//
// The end time is frozen when the screen opens, so time spent splitting does not stretch the block.
// Stop (next 'stop'): saves the block and goes Home.
// Switch (next 'switch'): hands the confirmed lines to the start form, which saves the old block and
//   starts the new one together, starting at the frozen end time so there is no gap between them.
//
// data: {shared, running, next}

import { el } from './dom.js';
import { saveBlock, removeBlock, getRunningBlock } from '../db.js';
import { finishBlock, elapsedSeconds } from '../model.js';
import { formatDuration, formatClock12 } from '../time.js';
import { makeLines } from './lines.js';

export async function openEnd(ctx, root, data) {
  const running = data.running;
  if (!running) {
    await ctx.show('home');
    return;
  }
  const isSwitch = data.next === 'switch';
  const endEpoch = ctx.nowEpoch();
  const duration = Math.max(0, endEpoch - running.start_epoch);
  const tz = ctx.tzOffsetMin();

  const msg = el('p', { class: 'muted msg form-msg' });
  const doneBtn = el('button', { type: 'button', class: 'btn btn-primary', disabled: true, onclick: () => done() }, isSwitch ? 'Next' : 'End block');

  const ui = makeLines(ctx, data.shared, {
    getDuration: () => duration,
    onChange: () => {
      msg.textContent = '';
      ui.refresh();
      update();
    },
    onMessage: (text) => {
      msg.textContent = text;
    }
  });
  ui.prefill(running.lines[0].category, running.lines[0].label);

  function update() {
    doneBtn.disabled = !ui.ready();
  }

  async function done() {
    if (doneBtn.disabled) return;
    doneBtn.disabled = true;
    const lines = ui.getLines();
    try {
      // Read the running block again, so a stale screen never ends the wrong thing.
      const current = await getRunningBlock(ctx.db);
      if (!current) {
        await ctx.show('home');
        return;
      }
      const changed = JSON.stringify(lines) !== JSON.stringify(current.lines);
      if (isSwitch) {
        await ctx.show('entry', { mode: 'start', ending: { end: endEpoch, lines: lines, changed: changed } });
        return;
      }
      const result = finishBlock(current, endEpoch, lines);
      if (result.action === 'remove') await removeBlock(ctx.db, result.block_id);
      else await saveBlock(ctx.db, result.block, { now: ctx.nowEpoch(), bumpLabels: changed });
    } catch (err) {
      ctx.warn('Could not end the block. Nothing was changed. Try again.');
      update();
      return;
    }
    await ctx.show('home');
  }

  const names = running.lines.map((l) => l.category).join(' / ');
  const label = running.lines[0].label;
  root.append(
    el('div', { class: 'head' }, [el('h2', { class: 'title', text: isSwitch ? 'End this block, then switch' : 'End block' })]),
    el('div', { class: 'card summary' }, [
      el('div', { text: label ? names + ', ' + label : names }),
      el('div', { class: 'muted', text: formatClock12(running.start_epoch, tz) + ' to ' + formatClock12(endEpoch, tz) + ' · ' + formatDuration(elapsedSeconds(running, endEpoch)) })
    ]),
    el('p', { class: 'muted', text: 'Did you do more than one thing? Split it here.' }),
    ui.node,
    el('div', { class: 'spacer' }),
    ui.splitBtn,
    msg,
    el('div', { class: 'spacer' }),
    el('div', { class: 'btn-row' }, [
      el('button', { type: 'button', class: 'btn', onclick: () => ctx.show('home') }, 'Cancel'),
      doneBtn
    ])
  );
  update();
}
