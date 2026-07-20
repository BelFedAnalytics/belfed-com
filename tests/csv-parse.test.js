// Regression test for the results-page CSV parser (parseCSV) embedded in
// trades.html and equities-trades.html.
//
// Bug reproduced here: the sheet's gviz CSV export quotes a multi-line "note"
// cell (col N / idx 13). The previous parser split the text on newlines FIRST
// and parsed each physical line on its own, so a quoted field containing a
// newline tore one logical record across two lines and shifted every later
// column — including Members-Signal (crypto idx 14, equities idx 19). The
// members dot then silently disappeared for ~22 fully-closed "Yes" rows.
//
// The fixed parser is RFC-4180 aware: it scans the whole text as one character
// stream so quotes span newlines. This test extracts the real parseCSV from
// each HTML file (no copy) and proves columns stay aligned.
//
// No framework — run with:  node tests/csv-parse.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

// Pull the real `function parseCSV(text){ ... }` out of an HTML file by
// matching balanced braces, then evaluate it in an isolated context.
function extractParseCSV(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const start = html.indexOf('function parseCSV(text){');
  if (start < 0) throw new Error('parseCSV not found in ' + htmlPath);
  let depth = 0, i = html.indexOf('{', start), end = -1;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const src = html.slice(start, end);
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.parseCSV = parseCSV;', sandbox, { filename: path.basename(htmlPath) + ':parseCSV' });
  return sandbox.parseCSV;
}

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
function csvRow(cells) { return cells.map(q).join(','); }

function runFor(htmlPath, msIdx, label) {
  console.log(label);
  const parseCSV = extractParseCSV(htmlPath);

  // Header + two data rows. The second data row carries a multi-line note in
  // col 13 (like the real sheet). Fill through the Members-Signal column so we
  // can assert alignment survives the embedded newline.
  const width = msIdx + 2;
  const mk = (over) => {
    const r = new Array(width).fill('');
    r[1] = over.ticker; r[3] = 'Closed'; r[8] = over.exitP; r[9] = over.result;
    r[13] = over.note; r[msIdx] = over.ms;
    return r;
  };
  const header = new Array(width).fill(''); header[1] = 'Ticker';
  const rows = [
    header,
    mk({ ticker: 'AAA', exitP: '10', result: '1', note: 'single line note', ms: 'Yes' }),
    mk({ ticker: 'BBB', exitP: '20', result: '2', note: 'line one\nline two\nline three', ms: 'yes' }),
    mk({ ticker: 'CCC', exitP: '30', result: '3', note: 'has, commas, and\na newline', ms: 'Yes' }),
  ];
  const csv = rows.map(csvRow).join('\r\n');

  const parsed = parseCSV(csv);
  const data = parsed.filter((r, i) => i > 0 && r[1] && r[1] !== 'Ticker');

  assert(data.length === 3, 'three logical records survive despite embedded newlines (got ' + data.length + ')');
  assert(data[1] && data[1][1] === 'BBB', 'the multi-line-note row is NOT split into extra records');
  assert(data[1] && /line one[\s\S]*line three/.test(data[1][13]), 'the multi-line note is preserved verbatim in col 13');
  const YES = new Set(['yes', 'y', 'true', '1', '•', '●']);
  const dots = data.filter((r) => YES.has((r[msIdx] || '').trim().toLowerCase())).length;
  assert(dots === 3, 'Members-Signal column stays aligned after the note (all 3 "Yes" -> dot; got ' + dots + ')');
  assert(data[2] && data[2][msIdx].trim().toLowerCase() === 'yes',
    'a note containing BOTH commas and a newline does not shift the MS column');
}

runFor(path.join(__dirname, '..', 'trades.html'), 14, 'trades.html parseCSV (crypto, MS idx 14)');
runFor(path.join(__dirname, '..', 'equities-trades.html'), 19, 'equities-trades.html parseCSV (MS idx 19)');

console.log(failures === 0 ? '\nAll CSV-parse tests passed.' : '\n' + failures + ' assertion(s) failed.');
process.exit(failures === 0 ? 0 : 1);
