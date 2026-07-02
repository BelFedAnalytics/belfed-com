// Behavioural tests for web-first Telegram connect in belfed-auth.js +
// members.html.
//
// Regression under test: a logged-in member's Telegram CTA must resolve to a
// PER-USER token link (via the telegram-link-start Edge Function) so the bot
// can bind that exact web profile. Previously members.html used a static
// ?start=members_en link that carried no identity, so the bot could not tell
// which web account to attach and fell back to whatever account the Telegram
// user was last seen as.
//
// No test framework / dependencies — run with:  node tests/telegram-link.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'belfed-auth.js'), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

function makeEl(props) {
  return Object.assign({
    value: '', checked: false, disabled: false, textContent: '', innerHTML: '',
    _attrs: {}, style: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    classList: { add() {}, remove() {}, contains() { return false; } }
  }, props || {});
}

// Load belfed-auth.js in a sandbox with a supabase stub whose session and a
// fetch stub are configurable per-scenario.
function load(opts) {
  opts = opts || {};
  const captures = { fetch: [] };

  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return makeEl({}); }
  };

  // Chainable, awaitable query-builder stub. checkAuth() runs on module load and
  // (when a session exists) walks .from().select().eq().in().order().limit() and
  // .single(); every method returns the same builder, which resolves to an empty
  // result. We only care about fetchTelegramConnectLink here, so entitlement
  // lookups just need to not throw.
  function makeQuery() {
    const q = {};
    ['select', 'eq', 'in', 'order', 'limit', 'update', 'insert', 'single', 'maybeSingle']
      .forEach(function (m) { q[m] = function () { return q; }; });
    q.then = function (resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); };
    return q;
  }

  const supaClient = {
    auth: {
      async getSession() { return { data: { session: opts.session || null } }; },
      onAuthStateChange() {},
      async signInWithPassword() { return { error: null }; },
      async signInWithOtp() { return { error: null }; },
      async setSession() { return {}; }
    },
    rpc() { return Promise.resolve({ error: null }); },
    from() { return makeQuery(); }
  };

  const hang = () => new Promise(() => {});
  const windowObj = { location: { origin: 'https://belfed.com', hash: '', search: '' } };

  const sandbox = {
    supabase: { createClient() { return supaClient; } },
    document,
    window: windowObj,
    fetch(url, options) {
      captures.fetch.push({ url, options });
      if (opts.fetchHangs) return hang();
      return Promise.resolve({ json() { return Promise.resolve(opts.fetchJson || {}); } });
    },
    setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams
  };

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'belfed-auth.js' });
  return { ctx: sandbox, captures };
}

(async function run() {
  console.log('web-first telegram connect');

  // 1) Authenticated member -> calls telegram-link-start and returns deep_link.
  {
    const { ctx, captures } = load({
      session: { access_token: 'user-access-token', user: { id: 'u1' } },
      fetchJson: { ok: true, token: 'abc123', deep_link: 'https://t.me/BelfedBot?start=abc123', expires_in_seconds: 900 }
    });
    const link = await ctx.fetchTelegramConnectLink();
    assert(link === 'https://t.me/BelfedBot?start=abc123', 'returns the per-user deep link from telegram-link-start');
    const call = captures.fetch.find(f => /telegram-link-start$/.test(f.url));
    assert(!!call, 'telegram-link-start edge function is called');
    assert(call && /\/functions\/v1\/telegram-link-start$/.test(call.url), 'calls the correct edge function path');
    assert(call && call.options.method === 'POST', 'uses POST');
    assert(call && call.options.headers.Authorization === 'Bearer user-access-token',
      'authenticates with the USER access token (not the anon key) so the function can identify the profile');
    assert(call && !!call.options.headers.apikey, 'sends the apikey header');
  }

  // 2) No session -> no network call, returns null (static link stays).
  {
    const { ctx, captures } = load({ session: null });
    const link = await ctx.fetchTelegramConnectLink();
    assert(link === null, 'returns null when there is no session');
    assert(captures.fetch.length === 0, 'does not call the edge function without a session');
  }

  // 3) Hanging edge function -> resolves null within the timeout (never blocks).
  {
    const { ctx } = load({ session: { access_token: 't', user: { id: 'u' } }, fetchHangs: true });
    const link = await ctx.fetchTelegramConnectLink();
    assert(link === null, 'resolves to null (not a rejection/hang) when the call times out');
  }

  // 4) Response without a deep_link -> null.
  {
    const { ctx } = load({ session: { access_token: 't', user: { id: 'u' } }, fetchJson: { ok: false, error: 'unauthorized' } });
    const link = await ctx.fetchTelegramConnectLink();
    assert(link === null, 'returns null when the response has no deep_link');
  }

  // 5) members.html regression: CTAs carry the hook ids and are upgraded from the
  //    static link at auth-ready time.
  {
    const html = fs.readFileSync(path.join(__dirname, '..', 'members.html'), 'utf8');
    assert(/id="tgConnectPrimary"/.test(html), 'members.html primary Telegram CTA has id tgConnectPrimary');
    assert(/id="tgConnectBottom"/.test(html), 'members.html bottom Telegram CTA has id tgConnectBottom');
    assert(/upgradeTelegramConnectLinks\(\)/.test(html), 'members.html calls upgradeTelegramConnectLinks() on auth ready');
    assert(/fetchTelegramConnectLink/.test(html), 'members.html uses fetchTelegramConnectLink');
    // Static fallback must remain in place for the best-effort failure case.
    assert(/start=members_en/.test(html), 'static members_en link retained as a fallback');
  }

  console.log(failures === 0 ? '\nAll telegram-connect tests passed.' : '\n' + failures + ' assertion(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
