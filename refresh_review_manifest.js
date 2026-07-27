#!/usr/bin/env node
/*
 * Automatic post-close refresh for trade_review_cards.json.
 *
 * A trade closing on the Google Sheet updates trades.html immediately (the page
 * reads the sheet live), but the Review card manifest is a build artifact. Until
 * it is rebuilt the just-closed trade renders the history-free fallback card.
 * This script closes that gap unattended:
 *
 *   1. Fetch the live ledger worksheets as CSV (public gviz export, no secret).
 *   2. Fetch the subscriber-signal lifecycle from Supabase and reduce it to the
 *      whitelisted fields the card builder needs (see SAFE_* below). Nothing
 *      else — no profiles, no subscriptions, no user ids — is ever read into
 *      memory, written to disk, or logged.
 *   3. Reuse build_review_manifest.js reconcile()/fill(): closed rows that have
 *      genuine EN history and no bot card yet are upgraded in place.
 *   4. Write the manifest only when its bytes actually change.
 *
 * The run is idempotent: with no newly closed trade it rewrites nothing and
 * reports changed=false, so the scheduled workflow produces no commit.
 *
 * Usage:
 *   node refresh_review_manifest.js [--manifest path] [--dry-run]
 *
 * Env:
 *   SUPABASE_URL                (optional, defaults to the public project URL)
 *   SUPABASE_SERVICE_ROLE_KEY   (required; the lifecycle tables are RLS-closed
 *                                to the anon key, which returns zero rows)
 *   GITHUB_OUTPUT               (optional; changed/upgraded/blocked are appended)
 *
 * Without the key the script is a deliberate no-op: it reports
 * blocked=missing_supabase_credentials and exits 0 rather than failing the
 * schedule or, worse, rewriting cards from incomplete data.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const B = require(path.join(__dirname, 'build_review_manifest.js'));

const SHEET_ID = '1bBpKZP74HEVrLZJlazz7gY7jbuBj9R5rPBcV2KklwDo';
// gid + worksheet name as used by build_review_manifest.js MS_IDX / sheet_row_id.
const WORKSHEETS = [
  { key: 'crypto', ws: 'Crypto', gid: '1219794768' },
  { key: 'equities', ws: 'Equties', gid: '0' },
];
const DEFAULT_SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';

// Only these columns ever leave Supabase. Everything else in the row — and every
// other table — stays untouched, so no subscriber or billing data can reach the
// repository even by accident.
const SAFE_POSITION = ['sheet_row_id', 'ticker', 'direction', 'status', 'asset_class',
  'result_rr', 'exit_price', 'opened_at', 'closed_at',
  'comment_en', 'comment_ru', 'close_comment_en', 'close_comment_ru'];
const SAFE_EVENT = ['id', 'event_type', 'triggered_at', 'triggered_price',
  'message_id_en', 'message_id_ru'];
const SAFE_EVENT_PAYLOAD = ['event', 'is_addon', 'old_stop', 'new_stop',
  'comment_en', 'comment_ru', 'partial_close_id'];
const SAFE_PARTIAL = ['id', 'closed_at', 'exit_price', 'pct_closed',
  'comment_en', 'comment_ru', 'source'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function sanitizePosition(p) {
  const out = pick(p, SAFE_POSITION);
  out.events = (p.events || []).map(e => {
    const ev = pick(e, SAFE_EVENT);
    ev.payload = pick(e.payload || {}, SAFE_EVENT_PAYLOAD);
    return ev;
  });
  out.partial_closes = (p.partial_closes || []).map(pc => pick(pc, SAFE_PARTIAL));
  return out;
}

function sanitizePositions(positions) {
  return (positions || []).map(sanitizePosition);
}

// RFC-4180 aware parser, byte-identical in behaviour to the one in trades.html:
// a quoted cell may hold commas and newlines, and must not shift later columns.
function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur.trim()); cur = ''; }
    else if (ch === '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { if (text[i + 1] !== '\n') { row.push(cur.trim()); rows.push(row); row = []; cur = ''; } }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows;
}

// reconcile() addresses a row as sheet row i+1, matching the Sheets-API export
// the manifest was originally built from. The gviz CSV drops the merged banner
// rows, so its indices sit a constant offset earlier. Rather than hard-coding
// that offset — a silent card mix-up the day someone inserts a header row — it
// is recovered from the data: the offset that makes the most sheet_row_id
// tickers land on a row with the same ticker wins.
function detectOffset(csvRows, positions, ws, maxOffset) {
  const want = [];
  for (const p of positions || []) {
    const m = String(p.sheet_row_id || '').match(/^(.+):(\d+)$/);
    if (m && m[1] === ws) want.push({ n: parseInt(m[2], 10), ticker: String(p.ticker || '').toUpperCase() });
  }
  let best = { offset: null, hits: 0 };
  for (let off = 0; off <= (maxOffset == null ? 5 : maxOffset); off++) {
    let hits = 0;
    for (const w of want) {
      const r = csvRows[w.n - 1 - off];
      if (r && String(r[1] || '').trim().toUpperCase() === w.ticker) hits++;
    }
    if (hits > best.hits) best = { offset: off, hits };
  }
  return best;
}

// Pad the CSV rows so index i is sheet row i+1, i.e. the exact shape
// build_review_manifest.js expects.
function alignRows(csvRows, offset) {
  const pad = [];
  for (let i = 0; i < offset; i++) pad.push([]);
  return pad.concat(csvRows);
}

function alignWorksheet(csvRows, positions, ws) {
  const det = detectOffset(csvRows, positions, ws);
  // No position maps into this worksheet (or none matched): nothing can be
  // filled for it anyway, so keep the rows unshifted rather than guessing.
  const offset = det.offset == null ? 0 : det.offset;
  return { rows: alignRows(csvRows, offset), offset, hits: det.hits };
}

// Pure core: given aligned sheet rows, sanitized positions and the current
// manifest, return the next manifest and whether anything changed. Exported so
// the tests can exercise the whole decision path with no network.
function buildUpdate(alignedCrypto, alignedEquities, positions, manifest) {
  const before = JSON.stringify(manifest);
  const next = JSON.parse(before);
  const src = {
    crypto: alignedCrypto,
    equities: alignedEquities,
    supabase: { positions: positions || [] },
    manifest: next,
  };
  const rows = B.reconcile(src);
  const { upgraded, pruned } = B.fill(rows, next);
  return {
    manifest: next,
    changed: JSON.stringify(next) !== before,
    upgraded: upgraded.map(r => ({ ticker: r.ticker, asset: r.asset, key: r.safeKey })),
    pruned,
  };
}

// --- IO ---------------------------------------------------------------------

async function fetchText(url, headers) {
  const res = await fetch(url, { headers: headers || {} });
  if (!res.ok) throw new Error('GET ' + url.split('?')[0] + ' -> HTTP ' + res.status);
  return res.text();
}

async function fetchWorksheet(gid) {
  const url = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID +
    '/gviz/tq?tqx=out:csv&gid=' + gid + '&single=true';
  return parseCsv(await fetchText(url));
}

// One nested read of the lifecycle tables. The embed syntax keeps it to a single
// request and to the whitelisted columns only.
async function fetchLifecycle(baseUrl, key) {
  const select = 'sheet_row_id,ticker,direction,status,asset_class,result_rr,exit_price,' +
    'opened_at,closed_at,comment_en,comment_ru,close_comment_en,close_comment_ru,' +
    'events:position_events(id,event_type,triggered_at,triggered_price,message_id_en,message_id_ru,payload),' +
    'partial_closes(id,closed_at,exit_price,pct_closed,comment_en,comment_ru,source)';
  const url = baseUrl.replace(/\/+$/, '') + '/rest/v1/active_positions?select=' +
    encodeURIComponent(select) + '&sheet_row_id=not.is.null';
  const body = await fetchText(url, { apikey: key, Authorization: 'Bearer ' + key });
  return sanitizePositions(JSON.parse(body));
}

function ghOutput(pairs) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  fs.appendFileSync(f, Object.keys(pairs).map(k => k + '=' + pairs[k]).join('\n') + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const mi = argv.indexOf('--manifest');
  const manifestPath = mi >= 0 ? argv[mi + 1] : path.join(__dirname, 'trade_review_cards.json');

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    // Deliberate no-op. Failing here would turn a missing-configuration state
    // into a daily red schedule, and rebuilding from sheet data alone would
    // strip existing timelines.
    console.log('no-op: SUPABASE_SERVICE_ROLE_KEY is not configured; manifest left untouched.');
    ghOutput({ changed: 'false', upgraded: '0', blocked: 'missing_supabase_credentials' });
    return;
  }
  const baseUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;

  const positions = await fetchLifecycle(baseUrl, key);
  const sheets = {};
  for (const w of WORKSHEETS) sheets[w.key] = await fetchWorksheet(w.gid);

  const aligned = {};
  for (const w of WORKSHEETS) {
    const a = alignWorksheet(sheets[w.key], positions, w.ws);
    aligned[w.key] = a.rows;
    console.log(w.ws + ': ' + sheets[w.key].length + ' csv rows, row offset ' + a.offset +
      ' (' + a.hits + ' sheet_row_id ticker matches)');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const res = buildUpdate(aligned.crypto, aligned.equities, positions, manifest);

  if (!res.changed) {
    console.log('no change: every closed trade with history already has its card.');
    ghOutput({ changed: 'false', upgraded: '0', blocked: '' });
    return;
  }
  for (const u of res.upgraded) console.log('upgraded -> ' + u.key);
  if (res.pruned.length) console.log('pruned ambiguous alias(es): ' + res.pruned.join(', '));
  if (dryRun) {
    console.log('dry run: ' + res.upgraded.length + ' card(s) would be written.');
    ghOutput({ changed: 'false', upgraded: String(res.upgraded.length), blocked: '' });
    return;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(res.manifest) + '\n');
  console.log('manifest written -> ' + manifestPath);
  ghOutput({ changed: 'true', upgraded: String(res.upgraded.length), blocked: '' });
}

if (require.main === module) {
  main().catch(err => { console.error(String(err && err.message ? err.message : err)); process.exit(1); });
}

module.exports = {
  parseCsv, sanitizePosition, sanitizePositions, detectOffset, alignRows,
  alignWorksheet, buildUpdate, WORKSHEETS,
  SAFE_POSITION, SAFE_EVENT, SAFE_EVENT_PAYLOAD, SAFE_PARTIAL,
};
