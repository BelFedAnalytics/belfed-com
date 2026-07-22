// Regression tests for the trade-review manifest reconciler/builder
// (build_review_manifest.js) and the Members-Signal dot rule it mirrors from
// trades.html / equities-trades.html.
//
// Regressions under test:
//   1. Members-Signal casing: a "Yes" / "yes" / " YES " row must be treated the
//      same. Casing must never decide whether the members dot renders, and the
//      audit's expected/actual dot must always agree.
//   2. Collision-safe manifest keys: the same ticker traded twice (same entry,
//      different exit) must resolve to DISTINCT full keys so the two trades get
//      their own Review card instead of colliding on the TICKER|ENTRY alias.
//   3. Supabase-history -> bot card: a closed position carrying subscriber-group
//      history must build a full bot timeline whose step links point at the
//      correct per-language Telegram channel (EN 3869302680/6, RU 3773738299/4).
//   4. Price precision is preserved verbatim (curated cards show raw values such
//      as 13.665) — the builder must never round.
//
// No test framework / dependencies — run with:  node tests/review-cards.test.js

'use strict';

const path = require('path');
const B = require(path.join(__dirname, '..', 'build_review_manifest.js'));

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

// Build a full A1:AB-style sheet row. Only the columns the reconciler reads are
// meaningful; everything else stays blank. `ms` is the Members-Signal cell,
// which lives in a different column per worksheet (idx 14 crypto, 19 equities).
function mkRow(o) {
  const r = new Array(27).fill('');
  r[1] = o.ticker || '';
  r[2] = o.dir || 'Long';
  r[3] = o.status || 'Closed';
  r[4] = o.entry || '';
  r[5] = o.exit || '';
  r[6] = o.entryP || '';
  r[8] = o.exitP || '';
  r[9] = o.result != null ? o.result : '';
  r[10] = o.tvLink || '';
  r[26] = o.snap || '';
  if (o.msIdx != null && o.ms != null) r[o.msIdx] = o.ms;
  return r;
}
// Sheet data has three header rows; data starts at index 3.
function sheet(rows) { return [[], [], []].concat(rows); }
function src(o) {
  return {
    crypto: sheet(o.crypto || []),
    equities: sheet(o.equities || []),
    supabase: { positions: o.positions || [] },
    manifest: o.manifest || {},
  };
}

console.log('trade-review manifest builder');

// 1) Members-Signal casing -----------------------------------------------------
{
  const rows = B.reconcile(src({
    crypto: [
      mkRow({ ticker: 'AAA', entry: '01.06.2026', exit: '05.06.2026', exitP: '10', result: '1', msIdx: 14, ms: 'Yes' }),
      mkRow({ ticker: 'BBB', entry: '01.06.2026', exit: '05.06.2026', exitP: '10', result: '1', msIdx: 14, ms: 'yes' }),
      mkRow({ ticker: 'CCC', entry: '01.06.2026', exit: '05.06.2026', exitP: '10', result: '1', msIdx: 14, ms: '  YES  ' }),
      mkRow({ ticker: 'DDD', entry: '01.06.2026', exit: '05.06.2026', exitP: '10', result: '1', msIdx: 14, ms: 'no' }),
      mkRow({ ticker: 'EEE', entry: '01.06.2026', exit: '05.06.2026', exitP: '10', result: '1', msIdx: 14, ms: '' }),
    ],
  }));
  const by = t => rows.find(r => r.ticker === t);
  assert(by('AAA').member === true, '"Yes" counts as a members signal');
  assert(by('BBB').member === true, '"yes" (lower) counts as a members signal');
  assert(by('CCC').member === true, '"  YES  " (padded/upper) counts as a members signal');
  assert(by('DDD').member === false, '"no" is not a members signal');
  assert(by('EEE').member === false, 'blank is not a members signal');
  assert(rows.every(r => r.expectedDot === r.actualDot), 'expected dot always equals actual dot (no casing-driven dot bug)');
  assert(by('AAA').expectedDot === 'dot' && by('DDD').expectedDot === 'none', 'members row expects a dot, non-member row expects none');
}

// 2) Collision-safe keys for a ticker traded twice -----------------------------
{
  const rows = B.reconcile(src({
    equities: [
      mkRow({ ticker: 'TSLA', entry: '15.07.2026', exit: '16.07.2026', exitP: '389', result: '-0.7', msIdx: 19, ms: 'Yes' }),
      mkRow({ ticker: 'TSLA', entry: '15.07.2026', exit: '20.07.2026', exitP: '400', result: '1.2', msIdx: 19, ms: 'Yes' }),
    ],
  }));
  const a = rows[0], b = rows[1];
  assert(a.sheetKey !== b.sheetKey, 'two TSLA trades opened the same day get DISTINCT full keys');
  assert(a.sheetPairKey === b.sheetPairKey, 'their TICKER|ENTRY pair alias collides (why the full key is needed)');
  assert(/^TSLA\|2026-07-15\|2026-07-16$/.test(a.sheetKey), 'full key is TICKER|ENTRY_ISO|EXIT_ISO');
  // A manifest keyed only on the colliding pair alias would mis-serve one of the
  // two trades; a full-key manifest disambiguates.
  const withFull = B.reconcile(src({
    equities: [
      mkRow({ ticker: 'TSLA', entry: '15.07.2026', exit: '16.07.2026', exitP: '389', result: '-0.7', msIdx: 19, ms: 'Yes' }),
      mkRow({ ticker: 'TSLA', entry: '15.07.2026', exit: '20.07.2026', exitP: '400', result: '1.2', msIdx: 19, ms: 'Yes' }),
    ],
    manifest: {
      'TSLA|2026-07-15|2026-07-16': { kind: 'bot', en: 'A', ru: 'A' },
      'TSLA|2026-07-15|2026-07-20': { kind: 'bot', en: 'B', ru: 'B' },
    },
  }));
  assert(withFull[0].manifestMatch === 'full' && withFull[1].manifestMatch === 'full',
    'each trade matches its own full-key card, not the collided alias');
}

// 3) Supabase history -> bot card with correct per-language Telegram links ------
{
  const pos = {
    ticker: 'BE', direction: 'Short', result_rr: 1.94,
    opened_at: '2026-07-07T09:00:00Z', closed_at: '2026-07-15T15:00:00Z',
    exit_price: 238.22,
    comment_en: 'Opening a medium-term short position in BE.',
    comment_ru: 'Открываем среднесрочную короткую позицию по BE.',
    close_comment_en: 'Closing the full position.',
    close_comment_ru: 'Закрываем всю позицию.',
    partial_closes: [],
    events: [
      { id: 1, event_type: 'opened', triggered_at: '2026-07-07T09:00:00Z', triggered_price: 250, message_id_en: 1091, message_id_ru: 2091, payload: {} },
      { id: 2, event_type: 'closed', triggered_at: '2026-07-15T15:00:00Z', triggered_price: 238.22, message_id_en: 1198, message_id_ru: 2198, payload: {} },
    ],
  };
  const sheetInfo = { entryISO: '2026-07-07', exitISO: '2026-07-15', exitP: '238.22' };
  const en = B.renderBotCard(pos, sheetInfo, 'en');
  const ru = B.renderBotCard(pos, sheetInfo, 'ru');
  assert(/class="card card-t1"/.test(en), 'renders a bot card article');
  assert((en.match(/class="step"/g) || []).length === 2, 'builds one timeline step per event');
  assert(en.indexOf('https://t.me/c/3869302680/6/1091') >= 0, 'EN opened step links to the EN channel with message_id_en');
  assert(en.indexOf('https://t.me/c/3869302680/6/1198') >= 0, 'EN closed step links to the EN channel with message_id_en');
  assert(ru.indexOf('https://t.me/c/3773738299/4/2091') >= 0, 'RU opened step links to the RU channel with message_id_ru');
  assert(ru.indexOf('https://t.me/c/3773738299/4/2198') >= 0, 'RU closed step links to the RU channel with message_id_ru');
  assert(en.indexOf('Opening a medium-term short position in BE.') >= 0, 'EN uses the verbatim EN opening comment');
  assert(ru.indexOf('Открываем среднесрочную короткую позицию по BE.') >= 0, 'RU uses the verbatim RU opening comment');
  assert(en.indexOf('+1.94R') >= 0, 'result badge shows the published R (result_rr)');

  // isGap: closed row + EN history + non-bot card must be flagged for upgrade.
  const rows = B.reconcile(src({
    equities: [mkRow({ ticker: 'BE', entry: '07.07.2026', exit: '15.07.2026', exitP: '238.22', result: '1.94', msIdx: 19, ms: 'Yes' })],
    positions: [Object.assign({ sheet_row_id: 'Equties:4' }, pos)],
    manifest: {}, // no card yet -> fallback/missing
  }));
  assert(rows.length === 1 && B.isGap(rows[0]) === true, 'a closed row with EN history and no bot card is a timeline gap');
  assert(rows[0].enHistory === 'yes', 'EN history is detected from the joined position');

  // Once a bot card exists for it, it is no longer a gap.
  const rows2 = B.reconcile(src({
    equities: [mkRow({ ticker: 'BE', entry: '07.07.2026', exit: '15.07.2026', exitP: '238.22', result: '1.94', msIdx: 19, ms: 'Yes' })],
    positions: [Object.assign({ sheet_row_id: 'Equties:4' }, pos)],
    manifest: { 'BE|2026-07-07|2026-07-15': { kind: 'bot', en: en, ru: ru } },
  }));
  assert(B.isGap(rows2[0]) === false, 'a row already backed by a bot card is not a gap');
}

// 4) No history is not invented; an open members row is hidden, not a gap -------
{
  const rows = B.reconcile(src({
    crypto: [
      // open (no result / no exit price) -> not fully closed -> intentionally no dot
      mkRow({ ticker: 'OPN', entry: '01.07.2026', status: 'Open', msIdx: 14, ms: 'Yes' }),
    ],
  }));
  assert(rows[0].member === true && rows[0].fullyClosed === false, 'open members row is recognised but not fully closed');
  assert(B.isGap(rows[0]) === false, 'an open row is never a timeline gap (nothing to render yet)');
}

// 6) Collision-safe SAFE keys + ambiguous pair pruning -------------------------
// The pair alias TICKER|ENTRY is unsafe when two sheet rows share it with
// different exits (TSLA opened 2026-04-30, closed 05-08 and 05-15). The builder
// must: (a) emit a SAFE key <asset>#<dir>#TICKER|ENTRY|EXIT, (b) never write an
// ambiguous pair alias, (c) prune any pre-existing ambiguous pair alias, so the
// 05-08 trade honestly falls back instead of borrowing the 05-15 card.
{
  assert(B.keySafe('Equities', 'Long', 'tsla', '2026-04-30', '2026-05-15') ===
    'equities#long#TSLA|2026-04-30|2026-05-15', 'keySafe: <asset>#<dir>#TICKER|ENTRY|EXIT, normalised');
  assert(B.keyFull('tsla', '2026-04-30', '2026-05-15') === 'TSLA|2026-04-30|2026-05-15', 'keyFull: TICKER|ENTRY|EXIT');
  assert(B.keyPair('tsla', '2026-04-30') === 'TSLA|2026-04-30', 'keyPair: TICKER|ENTRY');

  // Two same-entry TSLA rows with different exits; only the 05-15 one has a
  // curated bot card, reachable via both its full key and an ambiguous pair alias.
  const scenario = () => src({
    equities: [
      mkRow({ ticker: 'TSLA', dir: 'Long', entry: '30.04.2026', exit: '08.05.2026', exitP: '280', result: '-1', msIdx: 19, ms: 'Yes' }),
      mkRow({ ticker: 'TSLA', dir: 'Long', entry: '30.04.2026', exit: '15.05.2026', exitP: '349', result: '2', msIdx: 19, ms: 'Yes' }),
    ],
    manifest: {
      'TSLA|2026-04-30|2026-05-15': { kind: 'bot', en: 'FIFTEENTH', ru: 'FIFTEENTH' },
      'TSLA|2026-04-30': { kind: 'bot', en: 'FIFTEENTH', ru: 'FIFTEENTH' }, // ambiguous alias
    },
  });

  const rows = B.reconcile(scenario());
  const r0508 = rows.find(r => r.exitISO === '2026-05-08');
  const r0515 = rows.find(r => r.exitISO === '2026-05-15');
  assert(r0508.ambiguousPair === true && r0515.ambiguousPair === true,
    'both same-entry rows are flagged ambiguousPair');
  assert(r0508.safeKey === 'equities#long#TSLA|2026-04-30|2026-05-08', '05-08 row carries its own SAFE key');
  // With the ambiguous alias still present, the 05-08 row currently BORROWS the
  // 05-15 card through the pair alias -- this is exactly the bug being fixed.
  assert(r0508.manifestMatch === 'pair', '05-08 borrows the 05-15 card via the pair alias (pre-prune bug)');
  assert(r0515.manifestMatch === 'full', '05-15 resolves via its own full key');

  // pruneAmbiguousPairs removes the ambiguous alias; the full key is untouched.
  const m = scenario().manifest;
  const pruned = B.pruneAmbiguousPairs(rows, m);
  assert(pruned.indexOf('TSLA|2026-04-30') >= 0, 'the ambiguous pair alias is pruned');
  assert(!('TSLA|2026-04-30' in m), 'pruned alias no longer in the manifest');
  assert('TSLA|2026-04-30|2026-05-15' in m, 'the 05-15 full key survives pruning');

  // After pruning, re-reconcile: 05-08 has no card of its own -> honest fallback.
  const rowsAfter = B.reconcile(src({
    equities: scenario().equities.slice(3), // strip the 3 header rows added by sheet()
    manifest: m,
  }));
  const after0508 = rowsAfter.find(r => r.exitISO === '2026-05-08');
  const after0515 = rowsAfter.find(r => r.exitISO === '2026-05-15');
  assert(after0508.manifestMatch === 'none', '05-08 now falls back honestly (no borrowed card)');
  assert(after0515.manifestMatch === 'full', '05-15 still keeps its own card via the full key');
}

// 7) fill() writes SAFE + full keys but never an ambiguous pair alias ----------
{
  const pos = {
    ticker: 'ZZZ', direction: 'Long', result_rr: 1.0,
    opened_at: '2026-04-30T09:00:00Z', closed_at: '2026-05-08T15:00:00Z', exit_price: 280,
    comment_en: 'Opening ZZZ.', comment_ru: 'Открываем ZZZ.',
    close_comment_en: 'Closing ZZZ.', close_comment_ru: 'Закрываем ZZZ.',
    partial_closes: [], events: [],
  };
  // Two same-entry ZZZ rows (ambiguous pair) -> fill must NOT create the pair alias.
  const s = src({
    equities: [
      mkRow({ ticker: 'ZZZ', dir: 'Long', entry: '30.04.2026', exit: '08.05.2026', exitP: '280', result: '1', msIdx: 19, ms: 'Yes' }),
      mkRow({ ticker: 'ZZZ', dir: 'Long', entry: '30.04.2026', exit: '15.05.2026', exitP: '349', result: '2', msIdx: 19, ms: 'Yes' }),
    ],
    positions: [Object.assign({ sheet_row_id: 'Equties:4' }, pos)],
    manifest: {},
  });
  const rows = B.reconcile(s);
  const res = B.fill(rows, s.manifest);
  assert(res.upgraded.length === 1, 'only the row with EN history is upgraded');
  assert('equities#long#ZZZ|2026-04-30|2026-05-08' in s.manifest, 'fill writes the SAFE key');
  assert('ZZZ|2026-04-30|2026-05-08' in s.manifest, 'fill writes the full key');
  assert(!('ZZZ|2026-04-30' in s.manifest), 'fill NEVER writes an ambiguous pair alias');
}

// 8) Absent message ids do not suppress real historical text -------------------
// NBIS/OUST/HIMS style: closed position with comments/partials but no message
// ids. Steps must still render the verbatim body; only the link is omitted.
{
  const pos = {
    ticker: 'NBIS', direction: 'Long', result_rr: 1.5,
    opened_at: '2026-04-28T09:00:00Z', closed_at: '2026-06-05T15:00:00Z', exit_price: 100,
    comment_en: 'Long-term NBIS idea, no message id on file.',
    comment_ru: 'Долгосрочная идея по NBIS, без id сообщения.',
    close_comment_en: 'Closed NBIS.', close_comment_ru: 'Закрыли NBIS.',
    partial_closes: [],
    events: [
      { id: 1, event_type: 'opened', triggered_at: '2026-04-28T09:00:00Z', triggered_price: 60, message_id_en: null, message_id_ru: null, payload: {} },
    ],
  };
  const en = B.renderBotCard(pos, { entryISO: '2026-04-28', exitISO: '2026-06-05', exitP: '100' }, 'en');
  assert(en.indexOf('Long-term NBIS idea, no message id on file.') >= 0,
    'verbatim body renders even when no message id exists');
  assert(en.indexOf('t.me/c/3869302680') === -1, 'no Telegram link is fabricated when message_id_en is null');
}

// 9) LITE #237 (Equties:167): a position closed AFTER the manifest build -------
// Root cause of the regression this guards: position 237 was still OPEN
// (partially_closed, closed_at=null, no sheet exit/result) at the 2026-07-20
// closed-only build, so it was correctly excluded; it closed 2026-07-21 but no
// rebuild ran, leaving the live EN page on a generic fallback card. Once the
// sheet row is closed and the position carries its 5-event EN history, the row
// must resolve to a full bot timeline under the SAME closed-only policy.
{
  // Faithful (trimmed) copy of the authoritative Supabase position id 237.
  const lite237 = {
    ticker: 'LITE', direction: 'short', result_rr: 1.6189,
    opened_at: '2026-06-25T15:22:14.812229+00:00',
    closed_at: '2026-07-21T17:50:03.449+00:00', exit_price: 839,
    comment_en: "Price continues to print lower highs and is reacting sharply off key resistance zones at key moving averages today, signaling ongoing distribution. We're entering the position with a stepped (laddered) stop placed above today's and prior local highs.\n\nSee macro context in today's analysis: https://t.me/c/3869302680/4/991",
    comment_ru: 'RU opening comment.',
    close_comment_en: null, close_comment_ru: null,
    // Bot "Auto ..." partials are system notes; the timeline is event-driven.
    partial_closes: [
      { id: 48, closed_at: '2026-07-02T17:50:06.185118+00:00', exit_price: 714.72, pct_closed: 35, comment_en: 'Auto target_1_hit', comment_ru: 'Auto target_1_hit', source: 'bot' },
      { id: 59, closed_at: '2026-07-17T13:45:04.520477+00:00', exit_price: 653.19, pct_closed: 35, comment_en: 'Auto target_2_hit', comment_ru: 'Auto target_2_hit', source: 'bot' },
      { id: 63, closed_at: '2026-07-21T17:50:03.530561+00:00', exit_price: 839, pct_closed: 30, comment_en: 'Auto stop_hit', comment_ru: 'Auto stop_hit', source: 'bot' },
    ],
    events: [
      { id: 156, event_type: 'opened', triggered_at: '2026-06-25T15:22:26.744934+00:00', triggered_price: 838.76, message_id_en: 992, message_id_ru: 965, payload: { event: 'opened', is_addon: false } },
      { id: 165, event_type: 'target_1_hit', triggered_at: '2026-07-02T17:50:07.43559+00:00', triggered_price: 714.72, message_id_en: 1065, message_id_ru: 1035, payload: {} },
      { id: 178, event_type: 'stop_moved', triggered_at: '2026-07-15T13:44:46.987192+00:00', triggered_price: null, message_id_en: 1178, message_id_ru: 1148, payload: { event: 'stop_moved', new_stop: 839, old_stop: 838.76, comment_en: "Shifting the risk level to yesterday's highs. To keep the probabilities in favor of a continued correction in the coming weeks, the price must hold below this mark and continue closing under the moving averages.\n\nChart: https://www.tradingview.com/x/fLk9BKIq/", comment_ru: 'RU stop moved.' } },
      { id: 188, event_type: 'target_2_hit', triggered_at: '2026-07-17T13:45:05.517268+00:00', triggered_price: 653.19, message_id_en: 1228, message_id_ru: 1200, payload: {} },
      { id: 190, event_type: 'stop_hit', triggered_at: '2026-07-21T17:50:05.728538+00:00', triggered_price: 839, message_id_en: 1266, message_id_ru: 1238, payload: {} },
    ],
  };
  const sheetInfo = { entryISO: '2026-06-25', exitISO: '2026-07-21', exitP: '839' };
  const en = B.renderBotCard(lite237, sheetInfo, 'en');

  assert((en.match(/class="step"/g) || []).length === 5, 'LITE builds all 5 event steps (opened, T1, stop moved, T2, stop hit)');
  [992, 1065, 1178, 1228, 1266].forEach(function (mid) {
    assert(en.indexOf('https://t.me/c/3869302680/6/' + mid) >= 0, 'EN step links to the EN channel message ' + mid);
  });
  assert(en.indexOf('3773738299') === -1, 'no RU channel link leaks into the EN card');
  assert(en.indexOf('Price continues to print lower highs') >= 0, 'verbatim EN opening comment is preserved');
  assert(en.indexOf("Shifting the risk level to yesterday") >= 0, 'verbatim EN stop-moved comment is preserved');
  assert(en.indexOf('+1.62R') >= 0, 'result badge shows the published +1.62R (result_rr 1.6189)');
  assert(en.indexOf('Target 1 reached at 714.72.') >= 0 && en.indexOf('Target 2 reached at 653.19.') >= 0, 'target steps report their trigger prices');
  assert(en.indexOf('Stop hit at 839.') >= 0, 'stop-hit step reports the exit price');

  // Closed-only policy holds both ways: the CLOSED row (with sheet exit+result)
  // is a gap to upgrade; the SAME position while still OPEN is never a gap.
  const closedRow = mkRow({ ticker: 'LITE', dir: 'Short', entry: '25.06.2026', exit: '21.07.2026', exitP: '839,00', result: '1,62', msIdx: 19, ms: 'Yes' });
  const closedRows = B.reconcile(src({
    equities: [closedRow],
    positions: [Object.assign({ sheet_row_id: 'Equties:4', status: 'closed' }, lite237)],
    manifest: {},
  }));
  assert(closedRows.length === 1 && B.isGap(closedRows[0]) === true, 'closed LITE row with EN history and no bot card is a timeline gap');
  assert(closedRows[0].safeKey === 'equities#short#LITE|2026-06-25|2026-07-21', 'resolves via the collision-safe equities#short key');

  const openRow = mkRow({ ticker: 'LITE', dir: 'Short', status: 'Open', entry: '25.06.2026', exit: '', exitP: '', result: '1,6159', msIdx: 19, ms: 'Yes' });
  const openRows = B.reconcile(src({
    equities: [openRow],
    positions: [Object.assign({ sheet_row_id: 'Equties:4', status: 'partially_closed', closed_at: null }, lite237)],
    manifest: {},
  }));
  assert(B.isGap(openRows[0]) === false, 'while still open (no exit/result), LITE is NOT a gap — closed-only policy preserved');

  // Once the bot card exists, the closed row is no longer a gap (idempotent build).
  const backed = B.reconcile(src({
    equities: [closedRow],
    positions: [Object.assign({ sheet_row_id: 'Equties:4', status: 'closed' }, lite237)],
    manifest: { 'equities#short#LITE|2026-06-25|2026-07-21': { kind: 'bot', en: en, ru: 'x' } },
  }));
  assert(B.isGap(backed[0]) === false, 'a LITE row already backed by a bot card is not a gap');
}

// 5) Price precision preserved (never rounded) ---------------------------------
{
  assert(B.fmtNum(13.665) === '13.665', 'fmtNum keeps 13.665 (no rounding to 13.67)');
  assert(B.fmtNum('4358.28605806') === '4358.28605806', 'fmtNum keeps full raw precision');
  assert(B.fmtNum(82.0) === '82', 'fmtNum strips trailing .0');
  assert(B.fmtNum(10.680) === '10.68', 'fmtNum strips trailing zero');
  assert(B.fmtR(1.06) === '+1.06R', 'fmtR formats a positive R with sign');
  assert(B.fmtR(-0.7) === '-0.70R', 'fmtR formats a negative R to two decimals');
}

// 10) Shipped manifest artifact carries the LITE bot card ----------------------
// Guards the committed trade_review_cards.json (not just the builder) so the
// LITE #237 fix cannot silently regress on the live site.
{
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'trade_review_cards.json'), 'utf8'));
  const k = 'equities#short#LITE|2026-06-25|2026-07-21';
  const e = manifest[k];
  assert(!!e && e.kind === 'bot', 'shipped manifest has the LITE Equties:167 bot card under its safe key');
  if (e) {
    assert((e.en.match(/class="step"/g) || []).length === 5, 'shipped LITE EN card has all 5 timeline steps');
    assert(e.en.indexOf('https://t.me/c/3869302680/6/992') >= 0 && e.en.indexOf('https://t.me/c/3869302680/6/1266') >= 0,
      'shipped LITE EN card links first (992) and last (1266) subscriber messages');
    assert(manifest['LITE|2026-06-25|2026-07-21'] && manifest['LITE|2026-06-25|2026-07-21'].kind === 'bot',
      'shipped manifest also exposes the full key for the same card');
  }
}

console.log(failures === 0 ? '\nAll trade-review card tests passed.' : '\n' + failures + ' assertion(s) failed.');
process.exit(failures === 0 ? 0 : 1);
