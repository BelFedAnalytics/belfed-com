#!/usr/bin/env node
/*
 * BelFed trade-review manifest audit + gap-fill tool.
 *
 * Reconciles three sources and keeps trade_review_cards.json in sync with them:
 *   1. The public Google-Sheet trade ledgers (Equities worksheet "Equties",
 *      Crypto worksheet "Crypto"), exported as full A1:AB row arrays.
 *   2. The live Supabase public.active_positions dump (nested events +
 *      partial_closes) that holds the subscriber-group signal history.
 *   3. The existing pre-rendered manifest (trade_review_cards.json).
 *
 * A closed sheet row is joined to its Supabase position by sheet_row_id
 * ("Worksheet:<1-based row>"), which is collision-safe even when the same
 * ticker is traded multiple times. The manifest lookup key mirrors the runtime
 * key in trade-review.js: TICKER|ENTRY_ISO|EXIT_ISO (+ TICKER|ENTRY_ISO alias).
 *
 * Modes:
 *   node build_review_manifest.js audit [dataDir] [outCsv]
 *       Print a reconciliation summary and (optionally) write a CSV of every
 *       audited row. Never mutates the manifest.
 *   node build_review_manifest.js fill  [dataDir] [manifestPath]
 *       Upgrade every closed trade that has genuine Supabase EN history but no
 *       bot timeline card to a freshly-built bot card, merged into the manifest
 *       in place. Existing manifest entries are preserved verbatim unless they
 *       are being upgraded from legacy/missing -> bot.
 *
 * dataDir defaults to $BELFED_AUDIT_DIR or /home/user/workspace/trade_audit_2026-07-20.
 *
 * The card-building rules in this file are reverse-engineered from, and kept
 * byte-compatible with, the curated bot cards already in the manifest.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DATA = process.env.BELFED_AUDIT_DIR ||
  '/home/user/workspace/trade_audit_2026-07-22';
// Subscriber Telegram signal channels differ per language (EN and RU are
// separate supergroups/topics, each with its own message-id namespace).
const TG = {
  en: { chat: '3869302680', topic: '6', midKey: 'message_id_en' },
  ru: { chat: '3773738299', topic: '4', midKey: 'message_id_ru' },
};

// Members Signal column index differs per worksheet (see trades.html).
const MS_IDX = { Crypto: 14, Equties: 19 };
const YES = new Set(['yes', 'y', 'true', '1', '•', '●']);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
function trim(v) { return (v == null ? '' : String(v)).trim(); }

// DD.MM.YYYY (or ISO) -> YYYY-MM-DD, matching trade-review.js toISO().
function toISO(d) {
  d = trim(d);
  if (!d) return '';
  let m = d.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}
// YYYY-MM-DD -> DD.MM.YYYY (card display). Falls back to input.
function fromISO(iso) {
  const m = trim(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[3] + '.' + m[2] + '.' + m[1] : trim(iso);
}
// Supabase timestamp -> ISO date.
function tsISO(t) { return trim(t).slice(0, 10); }

// Price -> clean string: keep the source precision verbatim (curated cards show
// raw values such as 13.665 / 4358.28605806), only strip trailing zeros/dot.
function fmtNum(x) {
  if (x == null || x === '') return '';
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  if (isNaN(n)) return trim(x);
  let s = String(n);
  if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
  return s;
}
// R value -> "+1.06R" / "-0.70R".
function fmtR(x) {
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(',', '.'));
  if (isNaN(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + 'R';
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

// Collision-safe manifest key, mirrored in trade-review.js keyFor():
//   <assetClass>#<direction>#TICKER|ENTRY_ISO|EXIT_ISO
// asset class + direction + exit disambiguate trades that share ticker+entry.
function keySafe(asset, dir, ticker, entryISO, exitISO) {
  return String(asset).toLowerCase() + '#' + trim(dir).toLowerCase() + '#' +
    ticker.toUpperCase() + '|' + entryISO + '|' + exitISO;
}
function keyFull(ticker, entryISO, exitISO) {
  return ticker.toUpperCase() + '|' + entryISO + '|' + exitISO;
}
function keyPair(ticker, entryISO) {
  return ticker.toUpperCase() + '|' + entryISO;
}

function loadSources(dataDir, manifestPath) {
  return {
    equities: readJSON(path.join(dataDir, 'equities_rows.json')),
    crypto: readJSON(path.join(dataDir, 'crypto_rows.json')),
    supabase: readJSON(path.join(dataDir, 'supabase_audit.json')),
    manifest: fs.existsSync(manifestPath) ? readJSON(manifestPath) : {},
  };
}

// ---------------------------------------------------------------------------
// step / card construction (EN + RU), matching the curated manifest cards
// ---------------------------------------------------------------------------
const L = {
  en: {
    opened: 'Opened', added: 'Added', stopMoved: 'Stop moved', stopHit: 'Stop hit',
    closed: 'Closed', partial: 'Partial close', target: n => 'Target ' + n + ' hit',
    intro: 'Below are the messages published in the subscriber group during the lifecycle of this trade.',
    steplink: ' signal message (sub. only)',
    sStopMoved: (o, n) => 'Stop moved from ' + o + ' to ' + n + '.',
    sStopHit: p => 'Stop hit at ' + p + '.',
    sClosed: p => 'Closed at ' + p + '.',
    sPartial: (pct, p) => 'Closed ' + pct + '% at ' + p + '.',
    sTarget: (n, p) => 'Target ' + n + ' reached at ' + p + '.',
    sOpened: (dir, p) => (dir === 'short' ? 'Short' : 'Long') + ' opened at ' + p + '.',
    promo: '<div class="promo"><span class="promo-h">Follow BelFed in real time</span><p class="promo-body">Start a 14-day trial to receive trade ideas, position updates, and risk notes as they are published.</p><a class="promo-btn" href="/trial.html?source=trial_tradehistory_modal_en" data-cta="trial">Start 14-day trial ↗</a></div>',
  },
  ru: {
    opened: 'Открытие', added: 'Добавление',
    stopMoved: 'Стоп перенесён', stopHit: 'Стоп сработал',
    closed: 'Закрытие', partial: 'Частичное закрытие',
    target: n => 'Цель ' + n + ' достигнута',
    intro: 'Ниже представлены сообщения, опубликованные в подписной группе в течение жизненного цикла этой сделки.',
    steplink: ' сообщение сигнала (для подписчиков)',
    sStopMoved: (o, n) => 'Стоп перенесён с ' + o + ' на ' + n + '.',
    sStopHit: p => 'Стоп сработал по ' + p + '.',
    sClosed: p => 'Закрыто по ' + p + '.',
    sPartial: (pct, p) => 'Закрыто ' + pct + '% по ' + p + '.',
    sTarget: (n, p) => 'Цель ' + n + ' достигнута по ' + p + '.',
    sOpened: (dir, p) => 'Открытие по ' + p + '.',
    promo: '<div class="promo"><span class="promo-h">Следите за BelFed в реальном времени</span><p class="promo-body">Оформите 14-дневный тестовый доступ, чтобы получать торговые идеи, обновления по позициям и риск-комментарии по мере публикации.</p><a class="promo-btn" href="/trial.html?source=trial_tradehistory_modal_ru" data-cta="trial">Начать 14-дневный тест ↗</a></div>',
  },
};

const SVG_LOCK = '<svg viewBox="0 0 10 12" width="8" height="9" fill="none" stroke="currentColor" stroke-width="1.2" style="vertical-align:-1px"><rect x="1.5" y="5" width="7" height="6" rx="1"/><path d="M3 5V3.2A2 2 0 0 1 7 3.2V5"/></svg>';

// A machine-written system note, not a verbatim subscriber message.
function isSystemComment(c) {
  return /^(auto |corrected )/i.test(trim(c)) || /\(per sheet recap\)/i.test(trim(c));
}

// Build the ordered timeline (list of {lbl, ts, body, mid}) for one language.
// mid is the Telegram message id (or null -> no step link).
function buildSteps(pos, lang) {
  const t = L[lang];
  const midKey = TG[lang].midKey;
  const comment = k => trim(pos[k + '_' + lang]);
  const events = (pos.events || []).filter(e => e.event_type !== 'edited');
  const steps = [];

  if (events.length) {
    // Event-driven timeline (matches the curated bot cards). A partial_closed
    // event references its partial_close record by payload.partial_close_id.
    const pcById = {};
    for (const pc of (pos.partial_closes || [])) pcById[pc.id] = pc;
    const pcQueue = (pos.partial_closes || [])
      .filter(pc => !isSystemComment(pc.comment_en))
      .sort((a, b) => trim(a.closed_at).localeCompare(trim(b.closed_at)));
    let pIdx = 0;
    events.sort((a, b) => (trim(a.triggered_at).localeCompare(trim(b.triggered_at)) || (a.id - b.id)));
    for (const e of events) {
      const pl = e.payload || {};
      const ts = fromISO(tsISO(e.triggered_at));
      const mid = e[midKey] || null;
      const price = e.triggered_price != null ? fmtNum(e.triggered_price) : (pl.triggered_price != null ? fmtNum(pl.triggered_price) : '');
      let lbl, body;
      switch (e.event_type) {
        case 'opened':
          lbl = pl.is_addon ? t.added : t.opened;
          body = comment('comment') || (price ? t.sOpened(trim(pos.direction).toLowerCase(), price) : '');
          break;
        case 'stop_moved':
          lbl = t.stopMoved;
          body = trim(pl['comment_' + lang]) ||
            t.sStopMoved(fmtNum(pl.old_stop), fmtNum(pl.new_stop));
          break;
        case 'stop_hit':
          lbl = t.stopHit; body = t.sStopHit(price); break;
        case 'target_1_hit':
          lbl = t.target(1); body = t.sTarget(1, price); break;
        case 'target_2_hit':
          lbl = t.target(2); body = t.sTarget(2, price); break;
        case 'target_3_hit':
          lbl = t.target(3); body = t.sTarget(3, price); break;
        case 'partial_closed': {
          lbl = t.partial;
          const pc = (pl.partial_close_id != null && pcById[pl.partial_close_id])
            ? pcById[pl.partial_close_id]
            : (pcQueue[pIdx++] || null);
          body = pc ? t.sPartial(Math.round(pc.pct_closed), fmtNum(pc.exit_price))
                    : t.sPartial('', price);
          break;
        }
        case 'closed':
          lbl = t.closed; body = comment('close_comment') || t.sClosed(price); break;
        default:
          continue;
      }
      steps.push({ lbl, ts, body, mid });
    }
  } else {
    // No event stream: build an honest timeline from the position's own
    // verbatim comments + partial_close records. No step links exist here, so
    // none are fabricated.
    if (comment('comment')) {
      steps.push({ lbl: t.opened, ts: fromISO(tsISO(pos.opened_at)), body: comment('comment'), mid: null });
    }
    for (const pc of (pos.partial_closes || []).slice().sort((a, b) => trim(a.closed_at).localeCompare(trim(b.closed_at)))) {
      const c = trim(pc['comment_' + lang]);
      const body = (c && !isSystemComment(c)) ? c : t.sPartial(Math.round(pc.pct_closed), fmtNum(pc.exit_price));
      steps.push({ lbl: t.partial, ts: fromISO(tsISO(pc.closed_at)), body, mid: null });
    }
    if (comment('close_comment')) {
      steps.push({ lbl: t.closed, ts: fromISO(tsISO(pos.closed_at)), body: comment('close_comment'), mid: null });
    }
  }
  return steps;
}

function renderStep(s, lang) {
  const t = L[lang];
  let link = '';
  if (s.mid) {
    const href = 'https://t.me/c/' + TG[lang].chat + '/' + TG[lang].topic + '/' + s.mid;
    link = '<a class="steplink" href="' + href + '" target="_blank" rel="noopener">' +
           SVG_LOCK + t.steplink + '</a>';
  }
  return '<li class="step"><div class="step-h"><span class="step-lbl">' + esc(s.lbl) +
         '</span><span class="step-ts">' + esc(s.ts) + '</span></div>' +
         '<div class="step-body">' + esc(s.body) + '</div>' + link + '</li>';
}

function renderBotCard(pos, sheet, lang) {
  const t = L[lang];
  const dir = trim(pos.direction).toLowerCase();
  const badgeCls = dir === 'short' ? 'badge-short' : 'badge-long';
  const dirLbl = lang === 'ru'
    ? (dir === 'short' ? 'Короткая' : 'Длинная')
    : (dir === 'short' ? 'Short' : 'Long');
  // The result badge/meta reflect the published R (result_rr) only; a position
  // without a finalized result_rr shows an em-dash, not the interim realized_r.
  const rNum = pos.result_rr;
  const hasR = rNum != null;
  const rStr = hasR ? fmtR(rNum) : '';
  const rInner = hasR
    ? '<span class="' + (rNum >= 0 ? 'win' : 'loss') + '">' + esc(rStr) + '</span>'
    : '<span class="no-link">—</span>';
  const entryD = fromISO(sheet.entryISO || tsISO(pos.opened_at));
  const exitD = fromISO(sheet.exitISO || tsISO(pos.closed_at));
  const exitP = fmtNum(pos.exit_price != null ? pos.exit_price : sheet.exitP);

  const head = '<div class="card-head"><span class="badge ' + badgeCls + '">' + esc(dirLbl) +
    '</span><span class="card-r">' + rInner + '</span></div>';
  const metaResult = lang === 'ru' ? 'Результат' : 'Result';
  const metaExit = lang === 'ru' ? 'Выход' : 'Exit $';
  let meta = '<div class="card-meta">' + esc(entryD) + ' → ' + esc(exitD);
  meta += ' · ' + metaResult + ': ' + (hasR ? esc(rStr) : '—');
  if (exitP) meta += ' · <span class="brc-exit">' + metaExit + ': ' + esc(exitP) + '</span>';
  meta += '</div>';

  const steps = buildSteps(pos, lang).map(s => renderStep(s, lang)).join('');
  const timeline = steps
    ? '<p class="bot-intro">' + esc(t.intro) + '</p><ol class="timeline">' + steps + '</ol>'
    : '';
  return '<article class="card card-t1">' + head + meta + timeline + t.promo + '</article>';
}

// ---------------------------------------------------------------------------
// reconciliation
// ---------------------------------------------------------------------------
function hasEnHistory(pos) {
  if (!pos) return false;
  if (trim(pos.comment_en) || trim(pos.close_comment_en)) return true;
  for (const e of (pos.events || [])) {
    if (e.event_type === 'edited') continue;
    if (e.message_id_en || trim((e.payload || {}).comment_en)) return true;
  }
  for (const pc of (pos.partial_closes || [])) {
    if (trim(pc.comment_en) && !isSystemComment(pc.comment_en)) return true;
  }
  return false;
}

function reconcile(src) {
  const posBySid = {};
  for (const p of src.supabase.positions) posBySid[p.sheet_row_id] = p;
  const rows = [];
  const worksheets = [
    { name: 'crypto', ws: 'Crypto', data: src.crypto },
    { name: 'equities', ws: 'Equties', data: src.equities },
  ];
  for (const { name, ws, data } of worksheets) {
    const msIdx = MS_IDX[ws];
    for (let i = 3; i < data.length; i++) {
      const r = data[i] || [];
      const ticker = trim(r[1]);
      if (!ticker || ticker.toLowerCase() === 'ticker') continue;
      const direction = trim(r[2]);
      const status = trim(r[3]);
      const entry = trim(r[4]), exit = trim(r[5]);
      const entryP = trim(r[6]), exitP = trim(r[8]);
      const result = trim(r[9]);
      const tvLink = trim(r[10]), snap = trim(r[26]);
      const ms = trim(r[msIdx]).toLowerCase();
      const member = YES.has(ms);
      const rVal = parseFloat(result.replace(',', '.'));
      const fullyClosed = status.toLowerCase() === 'closed' && !isNaN(rVal) && result !== '' && exitP !== '';
      const entryISO = toISO(entry), exitISO = toISO(exit);
      const kFull = keyFull(ticker, entryISO, exitISO);
      const kPair = keyPair(ticker, entryISO);
      const kSafe = keySafe(name, direction, ticker, entryISO, exitISO);
      // Mirror the runtime lookup cascade: safe -> full -> pair.
      const mEntry = src.manifest[kSafe] || src.manifest[kFull] || src.manifest[kPair];
      const match = src.manifest[kSafe] ? 'safe'
        : (src.manifest[kFull] ? 'full' : (src.manifest[kPair] ? 'pair' : 'none'));
      const kind = mEntry ? mEntry.kind : 'fallback/missing';
      const steps = mEntry ? (mEntry.en.match(/class="step"/g) || []).length : 0;
      const sid = ws + ':' + (i + 1);
      const pos = posBySid[sid];
      const posMatch = pos && pos.ticker.toUpperCase() === ticker.toUpperCase();
      const p = posMatch ? pos : null;
      const enHist = hasEnHistory(p);
      rows.push({
        asset: name, sheetRow: i + 1, ticker, direction, status, entry, exit,
        entryISO, exitISO, member, fullyClosed,
        expectedDot: member ? 'dot' : 'none',
        actualDot: member ? 'dot' : 'none', // code lowercases+trims -> matches expected
        manifestMatch: match, cardKind: kind, steps,
        sid, supMatch: posMatch ? 'yes' : (pos ? 'sid_ticker_mismatch' : 'no'),
        events: p ? (p.events || []).length : 0,
        partials: p ? (p.partial_closes || []).length : 0,
        enHistory: enHist ? 'yes' : 'no',
        pos: p,
        sheetKey: kFull, sheetPairKey: kPair, safeKey: kSafe,
        tvLink, snap, entryP, exitP, result,
      });
    }
  }
  // A TICKER|ENTRY pair alias is ambiguous when 2+ sheet rows share it with
  // different exits (e.g. TSLA opened 2026-04-30, closed 2026-05-08 and
  // 2026-05-15). Such an alias can serve the wrong card and must not be relied
  // on; flag every affected row and note when it is currently borrowing a card
  // through that ambiguous alias.
  const pairExits = {};
  for (const r of rows) (pairExits[r.sheetPairKey] = pairExits[r.sheetPairKey] || new Set()).add(r.sheetKey);
  for (const r of rows) {
    r.ambiguousPair = pairExits[r.sheetPairKey].size > 1;
    r.borrowedPairCard = r.ambiguousPair && r.manifestMatch === 'pair';
  }
  return rows;
}

// A row needs a bot timeline when it is closed, has genuine EN history, and its
// current card is not already a bot card.
function isGap(row) {
  return row.fullyClosed && row.enHistory === 'yes' && row.cardKind !== 'bot';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(rows, out) {
  const cols = ['asset', 'sheetRow', 'ticker', 'direction', 'status', 'entry', 'exit',
    'member', 'fullyClosed', 'expectedDot', 'actualDot', 'manifestMatch', 'cardKind',
    'steps', 'sid', 'supMatch', 'events', 'partials', 'enHistory', 'resolution'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    let resolution;
    if (isGap(r)) resolution = 'UPGRADE->bot timeline (genuine EN history)';
    else if (r.member && !r.fullyClosed) resolution = 'not rendered (open/partial/no-result) - expected, not a dot bug';
    else if (r.fullyClosed && r.cardKind === 'bot' && r.enHistory === 'no') resolution = 'pre-existing bot card, no EN evidence in snapshot - retained';
    else if (r.fullyClosed && r.manifestMatch === 'none') resolution = 'runtime fallback legacy card (no history) - honest';
    else resolution = 'ok';
    lines.push(cols.map(c => csvCell(c === 'resolution' ? resolution : r[c])).join(','));
  }
  fs.writeFileSync(out, lines.join('\n') + '\n');
}

function summarize(rows) {
  const closed = rows.filter(r => r.fullyClosed);
  const members = rows.filter(r => r.member);
  const gaps = rows.filter(isGap);
  const hiddenMembers = rows.filter(r => r.member && !r.fullyClosed);
  const dotMismatch = rows.filter(r => r.expectedDot !== r.actualDot);
  const susp = rows.filter(r => r.fullyClosed && r.cardKind === 'bot' && r.enHistory === 'no');
  console.log('rows audited        :', rows.length);
  console.log('closed (rendered)   :', closed.length);
  console.log('member=yes rows     :', members.length);
  console.log('member=yes & closed :', members.filter(r => r.fullyClosed).length);
  console.log('member=yes hidden   :', hiddenMembers.length, '(open/partial/no-result -> not rendered)');
  console.log('DOT mismatches      :', dotMismatch.length);
  console.log('timeline GAPS       :', gaps.length);
  for (const g of gaps) console.log('   GAP', g.asset, g.sheetRow, g.ticker, g.entryISO, g.exitISO, '| kind', g.cardKind, '| ev', g.events, 'pc', g.partials);
  console.log('bot w/o EN evidence :', susp.length, susp.map(s => s.ticker + '(' + s.sheetRow + ')').join(', '));
  return { gaps, dotMismatch };
}

// Remove every TICKER|ENTRY pair alias that is ambiguous across sheet rows, so
// a same-ticker/same-entry trade can never borrow another trade's card through
// it. Each affected trade then resolves by its safe/full key or falls back
// honestly. Returns the list of pruned aliases.
function pruneAmbiguousPairs(rows, manifest) {
  const pairExits = {};
  for (const r of rows) (pairExits[r.sheetPairKey] = pairExits[r.sheetPairKey] || new Set()).add(r.sheetKey);
  const pruned = [];
  for (const pair of Object.keys(pairExits)) {
    if (pairExits[pair].size > 1 && Object.prototype.hasOwnProperty.call(manifest, pair)) {
      delete manifest[pair];
      pruned.push(pair);
    }
  }
  return pruned;
}

function fill(rows, manifest) {
  const upgraded = [];
  for (const r of rows.filter(isGap)) {
    const sheet = { entryISO: r.entryISO, exitISO: r.exitISO, exitP: r.exitP };
    const en = renderBotCard(r.pos, sheet, 'en');
    const ru = renderBotCard(r.pos, sheet, 'ru');
    const entry = { kind: 'bot', en, ru };
    // Safe + full keys are always collision-safe. The pair alias is only added
    // when it is unambiguous; an ambiguous one would let another same-entry
    // trade borrow this card.
    manifest[r.safeKey] = entry;
    manifest[r.sheetKey] = entry;
    if (!r.ambiguousPair) manifest[r.sheetPairKey] = entry;
    upgraded.push(r);
  }
  const pruned = pruneAmbiguousPairs(rows, manifest);
  return { upgraded, pruned };
}

function main() {
  const mode = process.argv[2] || 'audit';
  const dataDir = process.argv[3] || DEFAULT_DATA;
  const manifestPath = (mode === 'fill' ? process.argv[4] : null) ||
    path.join(__dirname, 'trade_review_cards.json');
  const src = loadSources(dataDir, manifestPath);
  const rows = reconcile(src);

  if (mode === 'audit') {
    summarize(rows);
    const outCsv = process.argv[4];
    if (outCsv) { writeCsv(rows, outCsv); console.log('wrote CSV ->', outCsv); }
  } else if (mode === 'fill') {
    const { upgraded, pruned } = fill(rows, src.manifest);
    fs.writeFileSync(manifestPath, JSON.stringify(src.manifest) + '\n');
    console.log('upgraded', upgraded.length, 'trade(s) to bot timelines:');
    for (const r of upgraded) console.log('  ', r.ticker, r.entryISO, '->', r.exitISO, '(' + r.sheetKey + ')');
    console.log('pruned', pruned.length, 'ambiguous pair alias(es):', pruned.join(', ') || '(none)');
    console.log('manifest written ->', manifestPath);
  } else {
    console.error('usage: build_review_manifest.js audit|fill [dataDir] [csv|manifest]');
    process.exit(2);
  }
}

if (require.main === module) main();
module.exports = {
  toISO, fromISO, fmtNum, fmtR, isSystemComment, buildSteps, renderBotCard,
  reconcile, hasEnHistory, isGap, loadSources, MS_IDX, YES,
  keySafe, keyFull, keyPair, pruneAmbiguousPairs, fill,
};
