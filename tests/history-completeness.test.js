'use strict';
const assert = require('node:assert/strict');
const B = require('../build_review_manifest');
const R = require('../refresh_review_manifest');
const pc = (id, at, price, extra = {}) => ({ id, closed_at: at, exit_price: price,
  pct_closed: 25, comment_en: 'Taking part of the profit.', comment_ru: 'Фиксируем часть прибыли.', ...extra });
const ev = (id, type, at, price, payload = {}) => ({ id, event_type: type,
  triggered_at: at, triggered_price: price, message_id_en: id, message_id_ru: id + 100, payload });
const opening = ev(1, 'opened', '2026-08-18T07:00:00Z', 75);
const closing = ev(4, 'closed', '2026-10-12T08:00:00Z', 80);
const position = { sheet_row_id: 'Crypto:4', ticker: 'SOL', direction: 'long',
  status: 'closed', opened_at: opening.triggered_at, closed_at: closing.triggered_at,
  result_rr: 1.2, exit_price: 80, comment_en: 'Opening.', comment_ru: 'Открытие.',
  events: [closing, opening], partial_closes: [
    pc(10, '2026-08-19T15:00:00Z', 80.75, { comment_en: 'Auto target_1_hit', comment_ru: 'Auto target_1_hit' }),
    pc(11, '2026-08-20T15:00:00Z', 83, { chart_url: 'https://www.tradingview.com/x/Test123/' }),
    pc(12, '2026-10-12T08:00:00.100Z', 80, { source: 'admin_final_close', pct_closed: 50 }),
  ] };
let failures = 0;
function test(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (err) { failures++; console.error('FAIL - ' + name + ': ' + err.message); }
}
test('merge orphan target/manual partials chronologically, no invented links or duplicate final exit', () => {
  for (const lang of ['en', 'ru']) {
    const steps = B.buildSteps(position, lang);
    assert.equal(steps.length, 4);
    assert.deepEqual(steps.map(s => s.ts), ['18.08.2026', '19.08.2026', '20.08.2026', '12.10.2026']);
    assert.equal(steps[1].mid, null);
    assert.equal(steps[2].mid, null);
    assert.match(steps[1].body, /25%.*80.75/);
    assert.doesNotMatch(steps[1].body, /Auto/);
    assert.match(steps[2].body, /25%.*83/);
    assert.ok(steps[2].body.includes(position.partial_closes[1]['comment_' + lang]));
    assert.equal(steps[2].chart, position.partial_closes[1].chart_url);
  }
});
test('explicit matches are reserved before timestamp fallback and remain one-to-one', () => {
  const at = '2026-08-20T15:00:00Z';
  const p = { ...position, events: [opening, ev(2, 'partial_closed', at, 83),
    ev(3, 'partial_closed', at, 83, { partial_close_id: 11 })],
  partial_closes: [pc(11, at, 83, { pct_closed: 10 }), pc(12, at, 83, { pct_closed: 15 })] };
  const steps = B.buildSteps(p, 'en');
  assert.equal(steps.length, 3);
  assert.match(steps[1].body, /15%/);
  assert.match(steps[2].body, /10%/);
});
test('nearby exits at different prices never borrow each other’s record', () => {
  const p = { ...position, events: [opening, ev(2, 'partial_closed', '2026-08-20T15:00:00Z', 90)],
    partial_closes: [pc(11, '2026-08-20T15:00:00Z', 83)] };
  const steps = B.buildSteps(p, 'en');
  assert.equal(steps.length, 3);
  assert.ok(steps.find(s => s.mid === 2).body.includes('90'));
  assert.ok(steps.find(s => s.mid === null).body.includes('83'));
});
test('target record enriches its real event without adding a duplicate', () => {
  const p = { ...position, events: [opening,
    ev(2, 'target_1_hit', '2026-08-19T15:00:02Z', 80.75)],
    partial_closes: [position.partial_closes[0]] };
  const steps = B.buildSteps(p, 'en');
  assert.equal(steps.length, 2);
  assert.match(steps[1].body, /25%/);
  assert.equal(steps[1].mid, 2);
});
test('final close with no trigger price uses the recorded exit, once', () => {
  const p = {...position, events:[opening, {...closing, triggered_price:null}], partial_closes:[position.partial_closes[2]]};
  const steps = B.buildSteps(p, 'en');
  assert.equal(steps.length, 2);
  assert.match(steps[1].body, /Closed at 80/);
  assert.match(steps[1].body, /50%/);
});
test('rounded legacy final exit joins its stop event without suppressing either price', () => {
  const p = {...position, exit_price:1.99, events:[opening, {...closing, event_type:'stop_hit', triggered_price:1.9875}],
    partial_closes:[{...position.partial_closes[2], exit_price:1.99}]};
  const steps = B.buildSteps(p, 'en');
  assert.equal(steps.length, 2);
  assert.match(steps[1].body, /1.9875/);
  assert.match(steps[1].body, /50% at 1.99/);
});
const row = ['', 'SOL', 'Long', 'Closed', '18.08.2026', '12.10.2026', '75', '', '80', '1.2'];
const key = 'crypto#long#SOL|2026-08-18|2026-10-12';
test('refresh existing bot cards and all aliases; retain manual/unrelated cards; second run is a no-op', () => {
  const input = { [key]: {kind:'bot', en:'old -1R', ru:'старое'},
    'OTHER': {kind:'legacy', en:'keep'} };
  const out = R.buildUpdate([[], [], [], row], [], [position], input);
  assert.ok(out.changed);
  assert.match(out.manifest[key].en, /\+1.20R/);
  assert.match(out.manifest[key].en, /80.75/);
  assert.deepEqual(out.manifest[key], out.manifest['SOL|2026-08-18|2026-10-12']);
  assert.deepEqual(out.manifest[key], out.manifest['SOL|2026-08-18']);
  assert.deepEqual(out.manifest.OTHER, input.OTHER);
  assert.equal(R.buildUpdate([[], [], [], row], [], [position], out.manifest).changed, false);
  const manual = { [key]: {kind:'manual', manual:{ru:'keep'}, en:'curated', ru:'проверено'} };
  assert.deepEqual(R.buildUpdate([[], [], [], row], [], [position], manual).manifest, manual);
});
test('same ticker at a stale row number cannot attach another trade’s history', () => {
  const wrong = { ...position, opened_at: '2026-08-01T07:00:00Z' };
  assert.equal(R.buildUpdate([[], [], [], row], [], [wrong], {}).changed, false);
});
test('structured manual enrichment on a generated card survives its refresh', () => {
  const manual = {en:{title:'Reviewed explanation'}};
  const out = R.buildUpdate([[], [], [], row], [], [position],
    {[key]:{kind:'bot', en:'old', ru:'старое', manual}});
  assert.deepEqual(out.manifest[key].manual, manual);
});
test('public card result matches its published table row without changing database result', () => {
  const p = {...position, result_rr:3.6};
  const out = R.buildUpdate([[], [], [], row], [], [p], {});
  assert.match(out.manifest[key].en, /\+1.20R/);
  assert.equal(p.result_rr, 3.6);
});
test('schedule runs every 15 minutes and refreshed EN artifacts are deployed by the same workflow', () => {
  const yml = require('node:fs').readFileSync('.github/workflows/refresh-review-manifest.yml', 'utf8');
  assert.match(yml, /7,22,37,52 \* \* \* \*/);
  assert.match(yml, /actions\/deploy-pages@v4/);
});
process.exitCode = failures ? 1 : 0;
