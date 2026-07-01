// Behavioural tests for the EN signup flow in belfed-auth.js.
//
// Regression under test: after supaClient.auth.signUp() succeeds, the success
// UI must render and the submit button must reset EVEN IF the best-effort
// side-effect calls (start_web_trial RPC, welcome-email, trial-intent-create)
// never respond. Previously those calls were awaited inline, so a single slow
// edge function left the button stuck on "Creating account..." forever.
//
// No test framework / dependencies — run with:  node tests/signup.test.js

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

// Minimal DOM element stub covering only what handleSignUp touches.
function makeEl(props) {
  const el = Object.assign({
    value: '', checked: false, disabled: false,
    textContent: '', innerHTML: '', _attrs: {},
    style: {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    classList: { add() {}, remove() {}, contains() { return false; } }
  }, props || {});
  return el;
}

// Build a fresh sandbox + module instance for each scenario.
function load(opts) {
  opts = opts || {};
  const captures = { rpc: [], fetch: [], track: [], signup: [] };

  const els = {
    suEmail:    makeEl({ value: opts.email || 'qa@example.com' }),
    suName:     makeEl({ value: opts.name || 'QA Tester' }),
    suPassword: makeEl({ value: opts.pw || 'secret123' }),
    suPassword2:makeEl({ value: (opts.pw2 !== undefined ? opts.pw2 : (opts.pw || 'secret123')) }),
    suConsent:  makeEl({ checked: opts.consent !== false }),
    loginError: makeEl({}),
    loginMsg:   makeEl({})
  };
  const btn = makeEl({ textContent: 'Start 14-day free trial' });

  const hang = () => new Promise(() => {}); // never resolves — simulates a stall

  const document = {
    readyState: 'loading',
    head: { appendChild() {} },
    addEventListener() {},
    getElementById(id) { return els[id] || null; },
    querySelector(sel) {
      if (sel === '#signupForm .login-btn') return btn;
      return null;
    },
    querySelectorAll() { return []; },
    createElement() { return makeEl({}); }
  };

  const supaClient = {
    auth: {
      async signUp(args) {
        captures.signup.push(args);
        if (opts.signUp) return opts.signUp;
        return { data: { user: { id: 'user-1', identities: [{ id: 'i1' }] }, session: null }, error: null };
      },
      async getSession() { return { data: { session: null } }; },
      onAuthStateChange() {},
      async signInWithPassword() { return { error: null }; },
      async signInWithOtp() { return { error: null }; },
      async setSession() { return {}; }
    },
    rpc(name, params) { captures.rpc.push({ name, params }); return hang(); },
    from() {
      return { update() { return { eq() { return hang(); } }; },
               select() { return { eq() { return { single() { return hang(); } }; } }; } };
    }
  };

  const windowObj = {
    location: { origin: 'https://belfed.com', hash: '', search: '' },
    BelfedAnalytics: { utmFields() { return { utm_source: 'newsletter', utm_campaign: 'spring' }; } },
    belfedTrack(name, props) { captures.track.push({ name, props }); }
  };

  const sandbox = {
    supabase: { createClient() { return supaClient; } },
    document,
    window: windowObj,
    fetch(url, options) { captures.fetch.push({ url, options }); return hang(); },
    setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams
  };
  sandbox.window.belfedTrack = windowObj.belfedTrack;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'belfed-auth.js' });

  return { ctx: sandbox, els, btn, captures };
}

(async function run() {
  console.log('signup flow');

  // 1) Success path must not block on hanging side-effects.
  {
    const { ctx, els, btn, captures } = load();
    await ctx.handleSignUp();

    assert(btn.disabled === false, 'submit button is re-enabled after signup');
    assert(btn.textContent === 'Start 14-day free trial', 'submit button text is restored (not stuck on "Creating account...")');
    assert(/trial is active/i.test(els.loginMsg.innerHTML), 'success message is rendered');
    assert(els.loginMsg.style.display === 'block', 'success message is visible');
    assert(els.loginError.style.display !== 'block', 'no error is shown on success');

    const trial = captures.rpc.find(r => r.name === 'start_web_trial');
    assert(!!trial, 'start_web_trial RPC is invoked');
    assert(trial && trial.params.p_source === 'web_signup', 'trial source is web_signup');
    assert(trial && trial.params.p_lang === 'en', 'trial language is en');
    assert(trial && trial.params.p_consent_locale === 'en', 'consent locale is en');
    assert(trial && typeof trial.params.p_privacy_consent_at === 'string' && trial.params.p_privacy_consent_at.length > 0, 'privacy consent timestamp is set');
    assert(trial && typeof trial.params.p_terms_consent_at === 'string' && trial.params.p_terms_consent_at.length > 0, 'terms consent timestamp is set');

    const tracked = captures.track.map(t => t.name);
    assert(tracked.includes('trial_started'), 'trial_started analytics event fired');
    const trialEvt = captures.track.find(t => t.name === 'trial_started');
    assert(trialEvt && trialEvt.props.trial_days === 14, 'canonical 14-day trial preserved in analytics');

    const intent = captures.fetch.find(f => /trial-intent-create$/.test(f.url));
    assert(!!intent, 'trial-intent-create is called');
    assert(intent && intent.options.headers.apikey, 'trial-intent-create sends the apikey header');
    const body = intent ? JSON.parse(intent.options.body) : {};
    assert(body.utm_source === 'newsletter', 'UTM fields are propagated into trial-intent-create');
    assert(body.source === 'web_signup', 'trial-intent source preserved');
  }

  // 2) Already-registered (obfuscated empty identities) -> error, no false success.
  {
    const { ctx, els, btn, captures } = load({
      signUp: { data: { user: { id: 'x', identities: [] }, session: null }, error: null }
    });
    await ctx.handleSignUp();
    assert(/already registered/i.test(els.loginError.innerHTML), 'already-registered email shows the sign-in hint');
    assert(!/trial is active/i.test(els.loginMsg.innerHTML), 'no success message for an existing account');
    assert(captures.rpc.length === 0, 'no trial is activated for an existing account');
    assert(btn.disabled === false, 'button re-enabled after already-registered error');
  }

  // 3) Client-side validation blocks the request.
  {
    const { ctx, els, captures } = load({ pw: 'secret123', pw2: 'different' });
    await ctx.handleSignUp();
    assert(/do not match/i.test(els.loginError.textContent), 'mismatched passwords are rejected');
    assert(captures.signup.length === 0, 'signUp is not called when validation fails');
  }

  console.log(failures === 0 ? '\nAll signup tests passed.' : '\n' + failures + ' assertion(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
