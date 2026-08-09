'use strict';

const fs = require('fs');
const path = require('path');
const B = require(path.join(__dirname, '..', 'build_review_manifest.js'));
const manifest = require(path.join(__dirname, '..', 'trade_review_cards.json'));
const renderer = fs.readFileSync(path.join(__dirname, '..', 'trade-review.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'trade-review.css'), 'utf8');

let failures = 0;
function assert(condition, message) {
  if (condition) console.log('  PASS - ' + message);
  else { console.error('  FAIL - ' + message); failures++; }
}
function card(key) {
  const entry = manifest[key];
  assert(!!entry, key + ' exists');
  assert(!!(entry && entry.manual && entry.manual.en), key + ' has structured EN enrichment data');
  return entry && entry.manual && entry.manual.en;
}
function noForbidden(value, message) {
  const text = JSON.stringify(value).toLowerCase();
  const forbidden = [
    /no separate .*entry signal/, /without a .*entry signal/, /member entry signal/,
    /excluded from .*signal statistics/, /member-signal statistics/
  ];
  assert(!forbidden.some(re => re.test(text)), message);
}

console.log('structured HIMS / SNDK review-card enrichments');

const hims = card('HIMS|2026-05-12|2026-07-20');
const sndk = card('SNDK|2026-07-13|2026-07-29');

if (hims) {
  assert(manifest['equities#long#HIMS|2026-05-12|2026-07-20'] && manifest['HIMS|2026-05-12'],
    'HIMS is reachable through collision-safe full/safe and unambiguous pair keys');
  assert(hims.publicLabel === 'Public trade idea', 'HIMS uses only the approved Public trade idea label');
  assert(hims.ideaUrl === 'https://www.tradingview.com/chart/HIMS/vO7ESVVg-HIMS-upside-potential/',
    'HIMS keeps the approved TradingView public-idea URL');
  assert(hims.riskRows[0].value === '24.84' && hims.riskRows[1].value === '21.53' &&
    hims.riskRows[2].value === '3.31' && hims.riskRows[3].value === '13.33%',
    'HIMS entry, stop, initial risk, and percentage risk are exact');
  assert(hims.calculation[0].formula === '(35.26 − 24.84) / 3.31' && hims.calculation[0].result === '3.15R' &&
    hims.calculation[1].formula === '(33 − 24.84) / 3.31' && hims.calculation[1].result === '2.47R' &&
    hims.weighted.formula === '0.50 × 3.15R + 0.50 × 2.47R' && hims.weighted.result === '+2.81R',
    'HIMS tranche formulas and weighted +2.81R result are exact');
  assert(manifest['HIMS|2026-05-12|2026-07-20'].en.indexOf('https://t.me/c/3869302680/4/1195') >= 0,
    'HIMS existing EN CLOSED timeline and Telegram link are retained');
  noForbidden(hims, 'HIMS enrichment contains no negative member-signal disclosure');
}

if (sndk) {
  assert(manifest['equities#short#SNDK|2026-07-13|2026-07-29'] && manifest['SNDK|2026-07-13'],
    'SNDK is reachable through collision-safe full/safe and unambiguous pair keys');
  assert(manifest['SNDK|2026-07-13|2026-07-29'].kind === 'manual',
    'SNDK is marked as a protected structured manual card');
  assert(sndk.publicLabel === 'Public trade idea', 'SNDK uses only the approved Public trade idea label');
  assert(sndk.ideaUrl === 'https://www.tradingview.com/chart/SNDK/vpWnVsNI-SNDK-Short-term-Trend-Structure/',
    'SNDK keeps the approved TradingView public-idea URL');
  assert(sndk.header.entryP === '1915.92' && sndk.header.exitP === '1030' && sndk.header.result === '+3.67R',
    'SNDK structured header has the verified entry, final target, and +3.67R result');
  assert(sndk.setup.indexOf('Published premarket on 13 July 2026. Entry reference: closing price of the 10 July 2026 session.') >= 0,
    'SNDK uses the mandated entry-reference copy exactly');
  assert(sndk.riskRows[1].value === '2130' && sndk.riskRows[2].value === '214.08' && sndk.riskRows[3].value === '11.17%',
    'SNDK invalidation, initial risk, and percentage risk are exact');
  assert(sndk.calculation[0].formula === '(1915.92 − 1230) / 214.08' && sndk.calculation[0].result === '3.20R' &&
    sndk.calculation[1].formula === '(1915.92 − 1030) / 214.08' && sndk.calculation[1].result === '4.14R' &&
    sndk.weighted.formula === '0.50 × 3.20R + 0.50 × 4.14R' && sndk.weighted.result === '+3.67R',
    'SNDK tranche formulas and weighted +3.67R result are exact');
  noForbidden(sndk, 'SNDK enrichment contains no negative member-signal disclosure');
}

assert(renderer.indexOf('function manualBlock(m)') >= 0 && renderer.indexOf('data-review-enrichment="true"') >= 0,
  'renderer builds the enrichment from structured data rather than a static HTML blob');
assert(renderer.indexOf('var fallbackData = manualHeader ? Object.assign({}, data, manualHeader) : data;') >= 0 &&
  renderer.indexOf('insertManualBlock(card, entry.manual[LANG])') >= 0,
  'renderer applies structured headers and inserts the enrichment before existing timeline/methodology content');
assert(renderer.indexOf('var marker = ["<p class=\\"bot-intro\\"", "<ol class=\\"timeline\\"", "<div class=\\"rc-method\\"", "<div class=\\"promo\\""]') >= 0,
  'renderer insertion order keeps the new block between header metrics and timeline/methodology');
assert(!/Sn[ie]mok|uploaded_attachments|8d545fb677aa42f093d042f44a61e4a5/i.test(renderer + JSON.stringify(manifest)),
  'no attached screenshot path, filename, or reference is present');
assert(css.indexOf('.brc-body .tl-row dd{') >= 0 && css.indexOf('font-variant-numeric:tabular-nums') >= 0 &&
  css.indexOf('linear-gradient') === -1 && css.indexOf('.tl-sec') >= 0,
  'flat rule-separated styling uses tabular numerals without gradients');

const preserved = { kind: 'manual', manual: { en: { publicLabel: 'Public trade idea' } } };
const copy = { 'SNDK|2026-07-13|2026-07-29': JSON.parse(JSON.stringify(preserved)) };
const manualRow = {
  fullyClosed: true, enHistory: 'yes', cardKind: 'manual', sheetPairKey: 'SNDK|2026-07-13',
  sheetKey: 'SNDK|2026-07-13|2026-07-29', safeKey: 'equities#short#SNDK|2026-07-13|2026-07-29'
};
assert(!B.isGap(manualRow), 'manifest builder does not classify a manual card as a refresh gap');
const filled = B.fill([manualRow], copy);
assert(filled.upgraded.length === 0 && JSON.stringify(copy['SNDK|2026-07-13|2026-07-29']) === JSON.stringify(preserved),
  'scheduled manifest fill preserves structured manual fields without overwrite');

console.log(failures === 0 ? '\nAll HIMS / SNDK enrichment tests passed.' : '\n' + failures + ' assertion(s) failed.');
process.exit(failures === 0 ? 0 : 1);
