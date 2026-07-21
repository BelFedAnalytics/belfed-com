// Regression test for the offline/degraded fallback path of the results pages.
//
// Bug reproduced here: when the live gviz CSV fetch fails, trades.html and
// equities-trades.html fall back to trades-fallback-{crypto,equities}.json and
// pass those rows straight to handleRows, which reads the Members-Signal flag at
// a fixed index (crypto r[14], equities r[19]). The fallback files used to be
// truncated to ~11 columns, so that index was absent and EVERY row rendered
// without its members dot in degraded mode (0 dots). build_trades_fallback.js
// now writes the signal back at the exact consumed index.
//
// This test:
//   1. reads the real Members-Signal index + YES token set out of each HTML
//      page (so it fails if the page changes what it reads),
//   2. confirms each page wires "live-fetch failure -> fetch(FALLBACK_URL) ->
//      handleRows(rows)",
//   3. simulates that failure with a fake fetch and asserts the fallback rows
//      delivered to handleRows render dots at parity (and > 0),
//   4. proves the signal is at the exact index (shifting it by one -> 0 dots).
//
// No framework — run with:  node tests/fallback-dots.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { MS_IDX } = require('../build_trades_fallback.js');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

const YES = new Set(['yes', 'y', 'true', '1', '•', '●']);

// Read the Members-Signal column index the page actually consumes.
function readMsIndexFromHtml(html, isCrypto) {
  const line = html.split('\n').find((l) => l.indexOf('var membersSignal=') >= 0);
  if (!line) throw new Error('membersSignal line not found');
  if (isCrypto) {
    const m = line.match(/isCrypto\?r\[(\d+)\]:r\[(\d+)\]/);
    if (!m) throw new Error('crypto MS index pattern not found');
    return { crypto: parseInt(m[1], 10), equities: parseInt(m[2], 10) };
  }
  const m = line.match(/r\[(\d+)\]/);
  if (!m) throw new Error('equities MS index pattern not found');
  return { equities: parseInt(m[1], 10) };
}

// The dot decision, mirrored from the page and gated on fully-closed.
function renderDots(rows, msIdx) {
  let dots = 0, closed = 0;
  rows.forEach((r, i) => {
    if (i < 1 || !r[1] || r[1].trim() === '' || r[1].trim().toLowerCase() === 'ticker') return;
    const status = (r[3] || '').trim().toLowerCase();
    const result = (r[9] || '').trim();
    const exitP = (r[8] || '').trim();
    const rVal = parseFloat(result.replace(',', '.'));
    const isFullyClosed = status === 'closed' && !isNaN(rVal) && result !== '' && exitP !== '';
    if (!isFullyClosed) return;
    closed++;
    const ms = ((r[msIdx] != null ? r[msIdx] : '') + '').trim().toLowerCase();
    if (YES.has(ms)) dots++;
  });
  return { dots, closed };
}

// Reproduce the page's fetch chain: live CSV rejects, fallback JSON resolves,
// handleRows receives the fallback rows. Returns whatever reached handleRows.
function simulateLiveFailure(csvUrl, fallbackUrl, fallbackRows) {
  let delivered = null;
  const handleRows = (rows) => { delivered = rows; };
  const fetchWithTimeout = (url) => Promise.reject(new Error('live gviz down: ' + url));
  const fetch = (url) => {
    if (url === fallbackUrl) return Promise.resolve({ json: () => Promise.resolve(fallbackRows) });
    return Promise.reject(new Error('unexpected url ' + url));
  };
  return fetchWithTimeout(csvUrl)
    .then((r) => r.text()).then((text) => handleRows(text))
    .catch(() => fetch(fallbackUrl).then((r) => r.json()).then((rows) => handleRows(rows)))
    .then(() => delivered);
}

const cryptoHtml = fs.readFileSync(path.join(__dirname, '..', 'trades.html'), 'utf8');
const equitiesHtml = fs.readFileSync(path.join(__dirname, '..', 'equities-trades.html'), 'utf8');
const cryptoFb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trades-fallback-crypto.json'), 'utf8'));
const equitiesFb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trades-fallback-equities.json'), 'utf8'));

const EXPECT = { crypto: 30, equities: 94 };

async function runFor(label, html, fb, isCrypto, fallbackUrl, msIdxExpected) {
  console.log(label);

  const idx = readMsIndexFromHtml(html, isCrypto);
  const msIdx = isCrypto ? idx.crypto : idx.equities;
  assert(msIdx === msIdxExpected, 'page reads Members-Signal at index ' + msIdxExpected + ' (got ' + msIdx + ')');
  assert(msIdx === (isCrypto ? MS_IDX.crypto : MS_IDX.equities), 'builder MS_IDX agrees with the page index');

  // Wiring: live failure must route to the fallback and into handleRows.
  assert(html.indexOf("FALLBACK_URL='" + fallbackUrl + "'") >= 0, 'FALLBACK_URL points at ' + fallbackUrl);
  assert(/\.catch\(function\(\)\{return fetch\(FALLBACK_URL\)\.then\(function\(r\)\{return r\.json\(\);\}\)\.then\(function\(rows\)\{handleRows\(rows\);\}\);\}\)/.test(html),
    'live-fetch failure is wired to fetch(FALLBACK_URL) -> handleRows(rows)');
  assert(/handleRows\(parseCSV\(text\)\)/.test(html), 'live path is unchanged (still handleRows(parseCSV(text)))');

  // Simulate the failure and assert the fallback rows actually arrive.
  const delivered = await simulateLiveFailure('gviz-csv-url', fallbackUrl, fb);
  assert(delivered === fb, 'on live-fetch failure, handleRows receives the fallback rows');

  const { dots, closed } = renderDots(delivered, msIdx);
  assert(dots > 0, 'degraded mode renders members dots (not 0 as before the fix); closed=' + closed + ' dots=' + dots);
  assert(dots === EXPECT[isCrypto ? 'crypto' : 'equities'],
    'fallback dot count matches baseline ' + EXPECT[isCrypto ? 'crypto' : 'equities'] + ' (got ' + dots + ')');

  // Alignment proof: the signal must be exactly at msIdx. Reading the neighbour
  // index must not reproduce the dots (guards against a re-truncation/off-by-one).
  const shifted = renderDots(delivered, msIdx + 1).dots;
  assert(shifted < dots, 'signal lives at the exact consumed index, not msIdx+1 (' + shifted + ' < ' + dots + ')');
}

(async () => {
  await runFor('trades.html (crypto, fallback)', cryptoHtml, cryptoFb, true, 'trades-fallback-crypto.json', 14);
  await runFor('equities-trades.html (fallback)', equitiesHtml, equitiesFb, false, 'trades-fallback-equities.json', 19);
  console.log(failures === 0 ? '\nAll fallback-dot tests passed.' : '\n' + failures + ' assertion(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
