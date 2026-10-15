// my snitch. Apps Script (Phase 6). Paste this whole file into the script attached to your Sheet,
// replacing everything that is there. The secret key is NOT in this file: it lives in the script's
// Project Settings under Script Properties, with the name SECRET.
//
// What it does for each request from the app:
//   1. checks the key
//   2. appends new rows to the raw tab, skipping any row_id it already holds (so a retry never duplicates)
//   3. replies with the row_ids it saved and skipped
//   4. writes one line to the sync_log tab, refused requests included

var RAW_NAME = 'raw';
var LOG_NAME = 'sync_log';

function doPost(e) {
  var started = new Date();
  var body = {};
  var result;
  var written = [];
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(20000);
    if (!locked) {
      result = { ok: false, error: 'busy' };
    } else {
      body = JSON.parse(e.postData.contents);
      var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
      if (!secret || body.key !== secret) {
        result = { ok: false, error: 'bad_key' };
      } else if (!Array.isArray(body.rows)) {
        result = { ok: false, error: 'bad_request' };
      } else {
        result = appendRows(body.rows, written);
      }
    }
  } catch (err) {
    result = { ok: false, error: 'bad_request' };
  }
  writeLog(started, body, result, written);
  if (locked) lock.releaseLock();
  return out(result);
}

// Appends the rows that raw does not hold yet. written collects them, for the log.
function appendRows(rows, written) {
  var sh = SpreadsheetApp.getActive().getSheetByName(RAW_NAME);
  if (!sh) return { ok: false, error: 'bad_request' };
  var last = sh.getLastRow();
  var existing = {};
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { existing[r[0]] = true; });
  }
  var saved = [];
  var skipped = [];
  var now = new Date();
  rows.forEach(function (r) {
    if (existing[r.row_id]) { skipped.push(r.row_id); return; }
    existing[r.row_id] = true;
    // Column order is fixed: A to Q. New fields only ever go on the right.
    written.push([
      r.row_id, r.block_id, r.version, r.schema_version,
      r.start_ts, r.end_ts, r.start_epoch, r.end_epoch, r.day,
      r.category, r.label, r.share_pct, r.is_deleted, r.entry_mode,
      r.logged_at, now, r.night_role || ''
    ]);
    saved.push(r.row_id);
  });
  if (written.length) {
    sh.getRange(last + 1, 1, written.length, written[0].length).setValues(written);
  }
  return { ok: true, saved: saved, skipped: skipped };
}

// One row in sync_log per request. It never records the key. A logging failure never blocks a sync.
function writeLog(started, body, result, written) {
  try {
    var count = function (test) {
      var seen = {};
      written.filter(test).forEach(function (w) { seen[w[1]] = true; });
      return Object.keys(seen).length;
    };
    var row = [
      body.sync_id || '',
      body.batch_no || '',
      body.batch_total || '',
      started,
      Array.isArray(body.rows) ? body.rows.length : 0,
      result.ok ? result.saved.length : 0,
      result.ok ? result.skipped.length : 0,
      count(function (w) { return w[2] === 1 && w[12] !== true; }),
      count(function (w) { return w[2] > 1 && w[12] !== true; }),
      count(function (w) { return w[12] === true; }),
      result.ok ? 'ok' : result.error,
      body.app_version || '',
      new Date() - started
    ];
    SpreadsheetApp.getActive().getSheetByName(LOG_NAME).appendRow(row);
  } catch (err) {
    // ignore
  }
}

function doGet() {
  return out({ ok: true, status: 'my snitch. script is live' });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
