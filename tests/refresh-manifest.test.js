// Regression tests for refresh_review_manifest.js — the unattended post-close
// manifest refresh.
//
// Regressions under test:
//   1. Sanitisation: only whitelisted lifecycle columns may leave Supabase, so a
//      production row carrying user ids / emails / billing fields can never be
//      rendered into a card or committed to the repo.
//   2. Row alignment: reconcile() addresses sheet rows positionally, while the
//      gviz CSV export drops the merged banner rows. The offset must be RECOVERED
//      from sheet_row_id, never assumed — a wrong offset silently attaches one
//      trade's history to another trade's card.
//   3. Idempotency / no-op: a second run over an unchanged ledger must report
//      changed=false and rewrite nothing, so the schedule produces no commit.
//   4. Closed-only policy survives the automation: an open position is never
//      upgraded, and a newly closed one is.
//
// No test framework / dependencies — run with:  node tests/refresh-manifest.test.js

'use strict';

const path = require('path');
const R = require(path.join(__dirname, '..', 'refresh_review_manifest.js'));

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

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
  if (o.msIdx != null && o.ms != null) r[o.msIdx] = o.ms;
  return r;
}

console.log('review-manifest refresh automation');

// 1) Sanitisation --------------------------------------------------------------
{
  const raw = {
    // whitelisted
    sheet_row_id: 'Crypto:47', ticker: 'CL', direction: 'long', status: 'closed',
    asset_class: 'crypto', result_rr: 2.62, exit_price: 84,
    opened_at: '2026-07-10T12:03:56.923Z', closed_at: '2026-07-27T06:15:05.353Z',
    comment_en: 'EN opening.', comment_ru: 'RU opening.',
    close_comment_en: null, close_comment_ru: null,
    // must never survive
    user_id: '00000000-0000-0000-0000-000000000001',
    created_by_email: 'trader@example.com',
    telegram_chat_id: 123456789,
    internal_notes: 'do not publish',
    events: [{
      id: 1, event_type: 'opened', triggered_at: '2026-07-10T12:03:56.923Z',
      triggered_price: 72.77, message_id_en: 1128, message_id_ru: 1098,
      author_email: 'ops@example.com', raw_message: 'unpublished draft',
      payload: { event: 'opened', is_addon: false, comment_en: 'EN note', subscriber_ids: [1, 2, 3] },
    }],
    partial_closes: [{
      id: 3, closed_at: '2026-07-22T08:26:11.301Z', exit_price: 87.22, pct_closed: 25,
      comment_en: 'EN partial.', comment_ru: 'RU partial.', source: 'manual',
      broker_account: 'ACC-9931',
    }],
  };
  const clean = R.sanitizePosition(raw);
  const flat = JSON.stringify(clean);

  assert(clean.ticker === 'CL' && clean.result_rr === 2.62 && clean.sheet_row_id === 'Crypto:47',
    'whitelisted position fields survive sanitisation');
  ['user_id', 'created_by_email', 'telegram_chat_id', 'internal_notes'].forEach(function (k) {
    assert(!(k in clean), 'position field "' + k + '" is stripped');
  });
  assert(flat.indexOf('trader@example.com') === -1 && flat.indexOf('ops@example.com') === -1,
    'no e-mail address can reach the manifest via a sanitised position');
  assert(flat.indexOf('ACC-9931') === -1 && flat.indexOf('unpublished draft') === -1,
    'broker/account and unpublished draft fields are stripped');
  assert(clean.events[0].message_id_en === 1128 && clean.events[0].payload.comment_en === 'EN note',
    'the event fields the card builder needs are kept');
  assert(!('author_email' in clean.events[0]) && !('subscriber_ids' in clean.events[0].payload),
    'unknown event and payload fields are stripped');
  assert(clean.partial_closes[0].pct_closed === 25 && !('broker_account' in clean.partial_closes[0]),
    'partial-close whitelist keeps pct/price and drops the rest');
  assert(Object.keys(clean.events[0].payload).every(k => R.SAFE_EVENT_PAYLOAD.indexOf(k) >= 0),
    'payload keys are exactly the documented safe set');
  assert(R.sanitizePositions([raw, raw]).length === 2, 'sanitizePositions maps the whole collection');
}

// 2) CSV parsing ---------------------------------------------------------------
{
  const rows = R.parseCsv('a,b,c\n1,"two, still two",3\n4,"line\nbreak",6\n');
  assert(rows.length === 3, 'parses one row per record');
  assert(rows[1][1] === 'two, still two', 'a quoted comma does not split the cell');
  assert(rows[2][1] === 'line\nbreak', 'a quoted newline does not split the row (columns stay aligned)');
}

// 3) Row alignment is recovered, not assumed -----------------------------------
{
  // gviz drops 2 banner rows: CSV index 44 is sheet row 47.
  const csv = [];
  for (let i = 0; i < 47; i++) csv.push(mkRow({ ticker: 'FILLER' }));
  csv[44] = mkRow({ ticker: 'CL', entry: '10.07.2026', exit: '27.07.2026' });
  csv[46] = mkRow({ ticker: 'ETH', dir: 'Short', entry: '23.07.2026', exit: '26.07.2026' });
  const positions = [
    { sheet_row_id: 'Crypto:47', ticker: 'CL' },
    { sheet_row_id: 'Crypto:49', ticker: 'ETH' },
  ];

  const det = R.detectOffset(csv, positions, 'Crypto');
  assert(det.offset === 2 && det.hits === 2, 'offset 2 is recovered from the sheet_row_id tickers');

  const aligned = R.alignWorksheet(csv, positions, 'Crypto');
  assert(aligned.rows[46][1] === 'CL' && aligned.rows[48][1] === 'ETH',
    'after alignment, array index n-1 is sheet row n for both trades');
  assert(aligned.rows.length === csv.length + 2, 'alignment pads rather than drops data');

  // A worksheet with no matching positions is left unshifted instead of guessed.
  const none = R.alignWorksheet(csv, positions, 'Equties');
  assert(none.offset === 0 && none.hits === 0, 'an unmatched worksheet is not shifted on a guess');

  // A wrong offset must be visibly wrong: shifting by one moves CL off its row,
  // which is exactly the mix-up detectOffset exists to prevent.
  assert(R.alignRows(csv, 1)[46][1] !== 'CL', 'an off-by-one offset would misplace the trade (why it is detected)');
}

// 4) End-to-end: newly closed trade is upgraded, then the run is a no-op -------
{
  const pos = {
    sheet_row_id: 'Crypto:5', ticker: 'AAA', direction: 'long', status: 'closed',
    asset_class: 'crypto', result_rr: 1.5, exit_price: 120,
    opened_at: '2026-07-01T09:00:00Z', closed_at: '2026-07-09T15:00:00Z',
    comment_en: 'Opening AAA.', comment_ru: 'Открываем AAA.',
    events: [
      { id: 1, event_type: 'opened', triggered_at: '2026-07-01T09:00:00Z', triggered_price: 100, message_id_en: 900, message_id_ru: 800, payload: {} },
      { id: 2, event_type: 'closed', triggered_at: '2026-07-09T15:00:00Z', triggered_price: 120, message_id_en: 950, message_id_ru: 850, payload: {} },
    ],
    partial_closes: [],
  };
  const positions = R.sanitizePositions([pos]);
  const csv = [];
  for (let i = 0; i < 3; i++) csv.push([]);
  csv.push(mkRow({ ticker: 'AAA', entry: '01.07.2026', exit: '09.07.2026', exitP: '120', result: '1,5', msIdx: 14, ms: 'Yes' }));
  const aligned = R.alignWorksheet(csv, positions, 'Crypto').rows;

  const first = R.buildUpdate(aligned, [[], [], []], positions, {});
  assert(first.changed === true, 'a newly closed trade with history changes the manifest');
  assert(first.upgraded.length === 1 && first.upgraded[0].key === 'crypto#long#AAA|2026-07-01|2026-07-09',
    'it is written under the collision-safe key');
  assert(first.manifest['crypto#long#AAA|2026-07-01|2026-07-09'].kind === 'bot', 'the card is a bot timeline');
  assert(first.manifest['crypto#long#AAA|2026-07-01|2026-07-09'].en.indexOf('https://t.me/c/3869302680/6/900') >= 0,
    'the timeline links the real EN signal message');

  const second = R.buildUpdate(aligned, [[], [], []], positions, first.manifest);
  assert(second.changed === false && second.upgraded.length === 0,
    're-running over the same ledger is a no-op (idempotent, no commit)');

  // The input manifest is never mutated in place — the caller decides to write.
  const input = {};
  R.buildUpdate(aligned, [[], [], []], positions, input);
  assert(Object.keys(input).length === 0, 'buildUpdate does not mutate the manifest it was given');

  // Existing entries are preserved verbatim alongside the new card.
  const withPrior = R.buildUpdate(aligned, [[], [], []], positions,
    { 'ZZZ|2026-01-01|2026-01-02': { kind: 'legacy', en: 'PRIOR', ru: 'PRIOR' } });
  assert(withPrior.manifest['ZZZ|2026-01-01|2026-01-02'].en === 'PRIOR',
    'unrelated existing cards are preserved byte-for-byte');
}

// 5) Closed-only policy holds in the automation --------------------------------
{
  const pos = {
    sheet_row_id: 'Crypto:5', ticker: 'BBB', direction: 'short', status: 'partially_closed',
    asset_class: 'crypto', result_rr: null, exit_price: null,
    opened_at: '2026-07-01T09:00:00Z', closed_at: null,
    comment_en: 'Opening BBB.', comment_ru: 'Открываем BBB.',
    events: [{ id: 1, event_type: 'opened', triggered_at: '2026-07-01T09:00:00Z', triggered_price: 100, message_id_en: 901, message_id_ru: 801, payload: {} }],
    partial_closes: [],
  };
  const positions = R.sanitizePositions([pos]);
  const csv = [[], [], [], mkRow({ ticker: 'BBB', dir: 'Short', status: 'Open', entry: '01.07.2026', exit: '', exitP: '', result: '', msIdx: 14, ms: 'Yes' })];
  const res = R.buildUpdate(csv, [[], [], []], positions, {});
  assert(res.changed === false && res.upgraded.length === 0,
    'a still-open position is never carded by the refresh (no half-written timeline)');
}

console.log(failures === 0 ? '\nAll refresh-automation tests passed.' : '\n' + failures + ' assertion(s) failed.');
process.exit(failures === 0 ? 0 : 1);
