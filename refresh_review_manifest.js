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
 *   2. Fetch the subscriber-signal lifecycle through the token-gated Supabase RPC
 *      export_review_card_data, which returns only closed archived positions and
 *      is already field-whitelisted server-side. The whitelist below is applied
 *      again on this side, so nothing — no profiles, no subscriptions, no user
 *      ids — can reach disk even if the function is widened later.
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
 *   SUPABASE_URL               (optional, defaults to the public project URL)
 *   SUPABASE_PUBLISHABLE_KEY   (required; the public apikey, gate is the token)
 *   SUPABASE_CARD_EXPORT_KEY   (required; the RPC's p_token argument)
 *   GITHUB_OUTPUT              (optional; changed/upgraded are appended)
 *
 * There is no degraded mode. A missing secret, a rejected token or a payload
 * that fails validation aborts with a non-zero exit and leaves the manifest
 * untouched, so a silent half-refresh can never be committed.
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
const RPC_NAME = 'export_review_card_data';

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

// The single privileged read: a token-gated RPC that returns only closed,
// archived positions with the card fields whitelisted server-side. The apikey is
// the project's public publishable key — the actual gate is p_token, which is
// never logged and never echoed into an error message.
function rpcRequest(baseUrl, publishableKey, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  // The token travels in the request body; a plaintext scheme would leak it.
  if (!/^https:\/\//.test(base)) throw new Error('SUPABASE_URL must be an https:// URL');
  return {
    url: base + '/rest/v1/rpc/' + RPC_NAME,
    options: {
      method: 'POST',
      headers: { apikey: publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_token: token }),
    },
  };
}

// The payload arrives as four parallel arrays; reconcile() wants events and
// partial closes nested under their position. Validate hard before nesting: a
// truncated or shape-shifted response must abort the run, not silently produce a
// manifest with the history stripped out of half the cards.
function groupLifecycle(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(RPC_NAME + ': expected an object payload');
  }
  if (typeof payload.generated_at !== 'string' || !payload.generated_at) {
    throw new Error(RPC_NAME + ': payload has no generated_at');
  }
  for (const k of ['positions', 'events', 'partial_closes']) {
    if (!Array.isArray(payload[k])) throw new Error(RPC_NAME + ': payload.' + k + ' is not an array');
  }
  if (!payload.positions.length) throw new Error(RPC_NAME + ': payload.positions is empty');

  const byId = new Map();
  const out = [];
  for (const p of payload.positions) {
    if (!p || typeof p !== 'object') throw new Error(RPC_NAME + ': malformed position entry');
    const id = p.id != null ? p.id : p.position_id;
    if (id == null) throw new Error(RPC_NAME + ': position is missing its id');
    if (!p.sheet_row_id) throw new Error(RPC_NAME + ': position ' + id + ' has no sheet_row_id');
    if (byId.has(String(id))) throw new Error(RPC_NAME + ': duplicate position id ' + id);
    const pos = Object.assign({}, p, { events: [], partial_closes: [] });
    byId.set(String(id), pos);
    out.push(pos);
  }
  // Children whose parent is absent are dropped rather than guessed at: the RPC
  // filters to archived positions, so an orphan means the parent was excluded.
  for (const e of payload.events) {
    const parent = e && byId.get(String(e.position_id));
    if (parent) parent.events.push(e);
  }
  for (const pc of payload.partial_closes) {
    const parent = pc && byId.get(String(pc.position_id));
    if (parent) parent.partial_closes.push(pc);
  }
  return out;
}

async function fetchLifecycle(baseUrl, publishableKey, token, doFetch) {
  const req = rpcRequest(baseUrl, publishableKey, token);
  const res = await (doFetch || fetch)(req.url, req.options);
  if (!res.ok) {
    // Deliberately terse: the response body of a rejected auth call is not
    // something to print into a public build log.
    throw new Error('POST ' + RPC_NAME + ' -> HTTP ' + res.status +
      (res.status === 401 || res.status === 403 ? ' (token rejected)' : ''));
  }
  let payload;
  try { payload = JSON.parse(await res.text()); }
  catch (err) { throw new Error(RPC_NAME + ': response is not valid JSON'); }
  return sanitizePositions(groupLifecycle(payload));
}

// Missing configuration is a hard error, not a quiet skip: the secrets are
// provisioned, so their absence means the workflow is misconfigured and the
// schedule should go red instead of silently never refreshing anything.
function resolveConfig(env) {
  const missing = ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_CARD_EXPORT_KEY'].filter(n => !env[n]);
  if (missing.length) throw new Error('missing required secret(s): ' + missing.join(', '));
  return {
    baseUrl: env.SUPABASE_URL || DEFAULT_SUPABASE_URL,
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY,
    token: env.SUPABASE_CARD_EXPORT_KEY,
  };
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

  const cfg = resolveConfig(process.env);
  const positions = await fetchLifecycle(cfg.baseUrl, cfg.publishableKey, cfg.token);
  console.log(RPC_NAME + ': ' + positions.length + ' closed position(s) exported.');
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
    ghOutput({ changed: 'false', upgraded: '0' });
    return;
  }
  for (const u of res.upgraded) console.log('upgraded -> ' + u.key);
  if (res.pruned.length) console.log('pruned ambiguous alias(es): ' + res.pruned.join(', '));
  if (dryRun) {
    console.log('dry run: ' + res.upgraded.length + ' card(s) would be written.');
    ghOutput({ changed: 'false', upgraded: String(res.upgraded.length) });
    return;
  }
  fs.writeFileSync(manifestPath, JSON.stringify(res.manifest) + '\n');
  console.log('manifest written -> ' + manifestPath);
  ghOutput({ changed: 'true', upgraded: String(res.upgraded.length) });
}

if (require.main === module) {
  main().catch(err => { console.error(String(err && err.message ? err.message : err)); process.exit(1); });
}

module.exports = {
  parseCsv, sanitizePosition, sanitizePositions, detectOffset, alignRows,
  alignWorksheet, buildUpdate, WORKSHEETS, RPC_NAME,
  rpcRequest, groupLifecycle, fetchLifecycle, resolveConfig,
  SAFE_POSITION, SAFE_EVENT, SAFE_EVENT_PAYLOAD, SAFE_PARTIAL,
};
