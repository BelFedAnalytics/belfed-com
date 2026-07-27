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
//   5. RPC contract: the export is read through the token-gated
//      export_review_card_data RPC only — publishable apikey, p_token body, no
//      service-role header — and a rejected token or malformed payload aborts the
//      run rather than producing a manifest with history quietly missing.
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

// 6) RPC request contract ------------------------------------------------------
{
  const req = R.rpcRequest('https://proj.supabase.co/', 'PUB_KEY', 'TOKEN');
  assert(req.url === 'https://proj.supabase.co/rest/v1/rpc/export_review_card_data',
    'posts to /rest/v1/rpc/export_review_card_data with the trailing slash normalised');
  assert(req.options.method === 'POST', 'the export is a POST');
  assert(req.options.headers.apikey === 'PUB_KEY', 'apikey header carries the publishable key');
  assert(req.options.headers['Content-Type'] === 'application/json', 'Content-Type is application/json');
  assert(!('Authorization' in req.options.headers),
    'no Authorization/service-role header is sent — the token is the only gate');
  assert(req.options.body === '{"p_token":"TOKEN"}', 'the token is passed as the p_token argument');

  let threw = null;
  try { R.rpcRequest('http://proj.supabase.co', 'PUB_KEY', 'TOKEN'); } catch (e) { threw = e; }
  assert(threw !== null, 'a plaintext http:// URL is refused (the token is in the body)');
}

// 7) Response validation and nesting -------------------------------------------
{
  const payload = {
    generated_at: '2026-07-27T07:00:00Z',
    positions: [
      { id: 331, sheet_row_id: 'Crypto:47', ticker: 'CL', direction: 'long', status: 'closed',
        asset_class: 'crypto', result_rr: 2.62, exit_price: 84,
        opened_at: '2026-07-10T12:03:56.923Z', closed_at: '2026-07-27T06:15:05.353Z',
        comment_en: 'EN open.', comment_ru: 'RU open.' },
      { id: 337, sheet_row_id: 'Crypto:49', ticker: 'ETH', direction: 'short', status: 'closed',
        asset_class: 'crypto', result_rr: -1, exit_price: 1941,
        opened_at: '2026-07-23T16:28:29.917Z', closed_at: '2026-07-26T22:35:04.995Z',
        comment_en: 'EN open.', comment_ru: 'RU open.' },
    ],
    events: [
      { position_id: 331, id: 1, event_type: 'opened', triggered_at: '2026-07-10T12:03:56.923Z', triggered_price: 72.77, message_id_en: 1128, message_id_ru: 1098, payload: {} },
      { position_id: 337, id: 2, event_type: 'opened', triggered_at: '2026-07-23T16:28:29.917Z', triggered_price: 1887.38, message_id_en: 1316, message_id_ru: 1291, payload: {} },
      { position_id: 999, id: 3, event_type: 'opened', triggered_at: '2026-07-01T00:00:00Z', triggered_price: 1, message_id_en: 1, message_id_ru: 1, payload: {} },
    ],
    partial_closes: [
      { position_id: 331, id: 7, closed_at: '2026-07-22T08:26:11.301Z', exit_price: 87.22, pct_closed: 25 },
    ],
  };

  const grouped = R.groupLifecycle(payload);
  assert(grouped.length === 2, 'one entry per exported position');
  assert(grouped[0].events.length === 1 && grouped[0].events[0].message_id_ru === 1098,
    'events are nested under their own position by position_id');
  assert(grouped[1].events.length === 1 && grouped[1].events[0].message_id_en === 1316,
    'a second position does not inherit the first one\'s history');
  assert(grouped[0].partial_closes.length === 1 && grouped[1].partial_closes.length === 0,
    'partial closes are nested by position_id too');
  assert(!grouped.some(p => p.events.some(e => e.position_id === 999)),
    'an orphan event is dropped rather than attached to an arbitrary position');

  // The client-side whitelist still applies to the RPC payload.
  const clean = R.sanitizePositions(grouped);
  assert(!('id' in clean[0]) && !('position_id' in clean[0].events[0]),
    'join keys are stripped after nesting — nothing extra reaches the manifest');

  function rejects(mutate, what) {
    const bad = JSON.parse(JSON.stringify(payload));
    mutate(bad);
    let threw = null;
    try { R.groupLifecycle(bad); } catch (e) { threw = e; }
    assert(threw !== null, 'rejects ' + what);
  }
  rejects(p => { delete p.generated_at; }, 'a payload with no generated_at');
  rejects(p => { p.positions = null; }, 'a payload whose positions is not an array');
  rejects(p => { p.events = {}; }, 'a payload whose events is not an array');
  rejects(p => { delete p.partial_closes; }, 'a payload missing partial_closes entirely');
  rejects(p => { p.positions = []; }, 'an empty export (a truncated response, not a real no-op)');
  rejects(p => { delete p.positions[0].id; }, 'a position with no id to join on');
  rejects(p => { delete p.positions[1].sheet_row_id; }, 'a position with no sheet_row_id');
  rejects(p => { p.positions[1].id = 331; }, 'duplicate position ids (ambiguous join)');
  [null, [], 'ok', 42].forEach(function (v) {
    let threw = null;
    try { R.groupLifecycle(v); } catch (e) { threw = e; }
    assert(threw !== null, 'rejects a non-object payload (' + JSON.stringify(v) + ')');
  });
}

// 8) Missing secrets are a hard failure, not a silent skip ----------------------
{
  const full = {
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'PUB_KEY',
    SUPABASE_CARD_EXPORT_KEY: 'TOKEN',
  };
  const cfg = R.resolveConfig(full);
  assert(cfg.baseUrl === 'https://proj.supabase.co' && cfg.token === 'TOKEN' && cfg.publishableKey === 'PUB_KEY',
    'a fully configured environment resolves');

  const noUrl = Object.assign({}, full); delete noUrl.SUPABASE_URL;
  assert(R.resolveConfig(noUrl).baseUrl.indexOf('https://') === 0,
    'SUPABASE_URL is optional and defaults to the project URL');

  ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_CARD_EXPORT_KEY'].forEach(function (name) {
    const env = Object.assign({}, full); delete env[name];
    let threw = null;
    try { R.resolveConfig(env); } catch (e) { threw = e; }
    assert(threw !== null && String(threw.message).indexOf(name) >= 0,
      'a missing ' + name + ' fails loudly and names the secret');
  });

  // The old service-role no-op must be gone: having only that key is not enough.
  let threw = null;
  try { R.resolveConfig({ SUPABASE_SERVICE_ROLE_KEY: 'legacy' }); } catch (e) { threw = e; }
  assert(threw !== null, 'a service-role key alone no longer satisfies the config');
}

// 9) HTTP failures abort — nothing is written, no secret is echoed --------------
{
  function fakeFetch(status, body) {
    const f = function (url, options) {
      f.last = { url, options };
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        text: () => Promise.resolve(body == null ? '' : body),
      });
    };
    return f;
  }

  const good = JSON.stringify({
    generated_at: '2026-07-27T07:00:00Z',
    positions: [{ id: 1, sheet_row_id: 'Crypto:5', ticker: 'AAA' }],
    events: [], partial_closes: [],
  });

  const cases = [
    [401, '{"message":"invalid export token","hint":"TOKEN"}', 'a 401 rejected token'],
    [403, 'forbidden', 'a 403'],
    [500, 'boom', 'a 5xx'],
  ];
  Promise.all(cases.map(function (c) {
    const f = fakeFetch(c[0], c[1]);
    return R.fetchLifecycle('https://proj.supabase.co', 'PUB_KEY', 'TOKEN', f)
      .then(() => ({ err: null }), err => ({ err }));
  })).then(function (results) {
    results.forEach(function (r, i) {
      assert(r.err !== null, cases[i][2] + ' aborts the run instead of returning zero positions');
      const msg = String(r.err && r.err.message);
      assert(msg.indexOf('TOKEN') === -1 && msg.indexOf('PUB_KEY') === -1,
        'the ' + cases[i][0] + ' error message leaks neither the token nor the response body');
    });

    const f = fakeFetch(200, 'not json at all');
    return R.fetchLifecycle('https://proj.supabase.co', 'PUB_KEY', 'TOKEN', f)
      .then(() => ({ err: null }), err => ({ err }));
  }).then(function (r) {
    assert(r.err !== null, 'a 200 with a non-JSON body aborts the run');

    const f = fakeFetch(200, good);
    return R.fetchLifecycle('https://proj.supabase.co', 'PUB_KEY', 'TOKEN', f)
      .then(positions => ({ positions, sent: f.last }));
  }).then(function (r) {
    assert(r.positions.length === 1 && r.positions[0].sheet_row_id === 'Crypto:5',
      'a valid export is sanitised and returned');
    assert(r.sent.url.indexOf('/rest/v1/rpc/export_review_card_data') > 0 &&
      r.sent.options.headers.apikey === 'PUB_KEY' &&
      JSON.parse(r.sent.options.body).p_token === 'TOKEN',
      'the live call uses exactly the documented request contract');
    finish();
  }).catch(function (err) {
    console.error('  FAIL - unexpected rejection: ' + err.message);
    failures++;
    finish();
  });
}

function finish() {
  console.log(failures === 0 ? '\nAll refresh-automation tests passed.' : '\n' + failures + ' assertion(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
}
