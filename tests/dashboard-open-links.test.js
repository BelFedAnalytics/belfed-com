#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
let failures = 0;

function ok(condition, message) {
  if (condition) console.log('  ok   - ' + message);
  else { console.error('  FAIL - ' + message); failures++; }
}

function extractFunction(name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error(name + ' not found');
  let depth = 0;
  let end = -1;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const context = { TG_OPEN_CHAT: '3869302680', TG_OPEN_TOPIC: '6' };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end) + '\nthis.fn=' + name + ';', context);
  return context.fn;
}

console.log('EN dashboard open-position links');
ok(/<table id="openTable">[\s\S]*?data-col="entryDate">Entry Date<\/th>[\s\S]*?<th>Telegram<\/th>/.test(html),
  'open positions table shows Entry Date and Telegram columns');
ok(/tgUrl:\(r\[12\]\|\|''\)\.trim\(\)/.test(html),
  'Google Sheet Telegram URL remains a supported fallback');
ok(/rpc\('get_open_position_links'\)/.test(html),
  'open-position link metadata is loaded through the restricted RPC');
ok(/await enrichOpenTelegramLinks\(allTrades\)/.test(html),
  'trades are enriched before the first render');
ok(/<td>'\+t\.entryDate\+'<\/td><td>'\+telegramLink\(t\.tgUrl\)/.test(html),
  'open rows render the entry date followed by the Telegram opening link');
ok(/renderClosedWeekRows[\s\S]*?tvLink\(t\.tvUrl\)/.test(html),
  'closed rows keep their TradingView analysis link');

const buildTelegramUrl = extractFunction('buildTelegramUrl');
ok(buildTelegramUrl(1783) === 'https://t.me/c/3869302680/6/1783',
  'EN message ID resolves to the EN members topic');
ok(buildTelegramUrl(null) === '', 'missing message ID does not fabricate a link');

if (failures) process.exit(1);
console.log('\nAll EN dashboard-link assertions passed.');
