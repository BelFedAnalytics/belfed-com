'use strict';

// Regenerates the offline/degraded fallback datasets consumed by the results
// pages when the live Google-Sheets gviz CSV cannot be fetched:
//
//   trades.html          -> fetch('trades-fallback-crypto.json')   -> handleRows(rows)
//   equities-trades.html -> fetch('trades-fallback-equities.json') -> handleRows(rows)
//
// handleRows reads the Members-Signal flag at a fixed column index — crypto
// r[14], equities r[19] — the same indices the live-CSV path uses. The
// historical fallback files were truncated to ~11 columns, so that index was
// never present and every row rendered WITHOUT its members dot in degraded
// mode. This builder joins each fallback row to the authoritative sheet
// snapshot (by ticker + entry + exit date) and writes the Members-Signal value
// back at the exact consumed index, so a live-fetch failure yields the same
// dots as the live feed. Only the Members-Signal cell is added; every other
// existing fallback value is preserved byte-for-byte.
//
// Usage:
//   node build_trades_fallback.js [cryptoSnapshot.json] [equitiesSnapshot.json]
// Snapshots default to the captured sheet rows under the trade-audit deliverables.

const fs = require('fs');
const path = require('path');

const MS_IDX = { crypto: 14, equities: 19 };
const DEFAULT_SNAP_DIR = '/home/user/workspace/trade_audit_2026-07-20';

// Normalise a DD.MM.YYYY date to integer form so "07.04.2025" and "7.4.2025"
// compare equal across the fallback and snapshot exports.
function normDate(s) {
  return String(s || '').trim().split('.').map((x) => parseInt(x, 10)).join('.');
}
function rowKey(ticker, entry, exit) {
  return String(ticker || '').trim().toUpperCase() + '|' + normDate(entry) + '|' + normDate(exit);
}
function isDataRow(r) {
  return r && r[1] && r[1].trim() !== '' && r[1].trim().toLowerCase() !== 'ticker';
}

// Map (ticker|entry|exit) -> Members-Signal string, from a full-width snapshot.
function buildSignalMap(snapshot, msIdx) {
  const m = new Map();
  for (const r of snapshot) {
    if (!isDataRow(r) || !r[4]) continue;
    m.set(rowKey(r[1], r[4], r[5]), r[msIdx] == null ? '' : r[msIdx]);
  }
  return m;
}

// Insert the Members-Signal value at msIdx, padding intermediate cells with ''
// so the index the renderer reads is exactly aligned. Existing cells are kept.
function enrich(fallbackRows, signalMap, msIdx) {
  let filled = 0;
  const out = fallbackRows.map((r, i) => {
    if (i < 1 || !isDataRow(r)) return r;
    const sig = signalMap.get(rowKey(r[1], r[4], r[5]));
    if (sig == null || String(sig).trim() === '') return r;
    const row = r.slice();
    while (row.length <= msIdx) row.push('');
    row[msIdx] = sig;
    filled++;
    return row;
  });
  return { rows: out, filled };
}

function run() {
  const repoDir = __dirname;
  const cryptoSnapPath = process.argv[2] || path.join(DEFAULT_SNAP_DIR, 'crypto_rows.json');
  const equitiesSnapPath = process.argv[3] || path.join(DEFAULT_SNAP_DIR, 'equities_rows.json');

  const targets = [
    { name: 'crypto', fallback: 'trades-fallback-crypto.json', snap: cryptoSnapPath, msIdx: MS_IDX.crypto },
    { name: 'equities', fallback: 'trades-fallback-equities.json', snap: equitiesSnapPath, msIdx: MS_IDX.equities },
  ];

  for (const t of targets) {
    if (!fs.existsSync(t.snap)) {
      throw new Error('snapshot not found for ' + t.name + ': ' + t.snap +
        '\n  (pass the captured full-width sheet rows as an argument)');
    }
    const snapshot = JSON.parse(fs.readFileSync(t.snap, 'utf8'));
    const fbPath = path.join(repoDir, t.fallback);
    const fallback = JSON.parse(fs.readFileSync(fbPath, 'utf8'));

    const signalMap = buildSignalMap(snapshot, t.msIdx);
    const { rows, filled } = enrich(fallback, signalMap, t.msIdx);

    fs.writeFileSync(fbPath, JSON.stringify(rows));
    console.log(t.name + ': wrote ' + t.fallback + ' — Members-Signal filled on ' +
      filled + ' rows (idx ' + t.msIdx + ')');
  }
}

if (require.main === module) run();

module.exports = { normDate, rowKey, isDataRow, buildSignalMap, enrich, MS_IDX };
