// Behavioural tests for the EN email-confirmation handler in belfed-confirm.js.
//
// Regression under test: confirm.html used to be a static page that ignored the
// confirmation token entirely and ALWAYS claimed success — so expired/invalid
// Supabase links silently left email_confirmed_at = null while the user saw
// "EMAIL CONFIRMED". The handler must now correctly classify and resolve every
// Supabase confirmation shape (hash session, ?code PKCE, ?token_hash+type, and
// /verify error redirects) and surface real success/failure.
//
// No test framework / dependencies — run with:  node tests/confirm.test.js

'use strict';

const path = require('path');
const BelfedConfirm = require(path.join(__dirname, '..', 'belfed-confirm.js'));

// Node >=10 has a global URLSearchParams; belfed-confirm.js reads it off the
// global object it is loaded into, so make sure it is present.
if (typeof global.URLSearchParams === 'undefined') {
  global.URLSearchParams = require('url').URLSearchParams;
}

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok   - ' + msg); }
  else { console.error('  FAIL - ' + msg); failures++; }
}

// A supabase.auth stub that records calls and returns scripted results.
function stubClient(scripted) {
  scripted = scripted || {};
  const calls = { setSession: [], exchangeCodeForSession: [], verifyOtp: [], getSession: 0 };
  return {
    calls,
    auth: {
      async setSession(a) { calls.setSession.push(a); return scripted.setSession || { data: { session: { id: 's' } }, error: null }; },
      async exchangeCodeForSession(a) { calls.exchangeCodeForSession.push(a); return scripted.exchangeCodeForSession || { data: { session: { id: 's' } }, error: null }; },
      async verifyOtp(a) { calls.verifyOtp.push(a); return scripted.verifyOtp || { data: { session: { id: 's' } }, error: null }; },
      async getSession() { calls.getSession++; return scripted.getSession || { data: { session: null } }; }
    }
  };
}

(async function run() {
  console.log('email confirmation flow');

  // --- parseAuthParams merges query + hash ---
  {
    const p = BelfedConfirm.parseAuthParams({ search: '?code=abc', hash: '#type=signup' });
    assert(p.code === 'abc' && p.type === 'signup', 'parseAuthParams merges query string and hash fragment');
  }

  // --- classify: hash session tokens ---
  {
    const c = BelfedConfirm.classifyConfirmation({ access_token: 'AT', refresh_token: 'RT', type: 'signup' });
    assert(c.kind === 'session' && c.access_token === 'AT' && c.refresh_token === 'RT', 'classify: #access_token+refresh_token -> session');
  }

  // --- classify: PKCE code ---
  {
    const c = BelfedConfirm.classifyConfirmation({ code: 'CODE123' });
    assert(c.kind === 'code' && c.code === 'CODE123', 'classify: ?code -> code (PKCE)');
  }

  // --- classify: token_hash + type ---
  {
    const c = BelfedConfirm.classifyConfirmation({ token_hash: 'TH', type: 'email' });
    assert(c.kind === 'token_hash' && c.token_hash === 'TH' && c.type === 'email', 'classify: ?token_hash+type -> token_hash');
  }

  // --- classify: /verify expired error redirect ---
  {
    const c = BelfedConfirm.classifyConfirmation({ error: 'access_denied', error_code: 'otp_expired', error_description: 'Email link is invalid or has expired' });
    assert(c.kind === 'error' && c.code === 'otp_expired', 'classify: error params -> error');
  }

  // --- classify: nothing ---
  {
    const c = BelfedConfirm.classifyConfirmation({});
    assert(c.kind === 'none', 'classify: no params -> none');
  }

  // --- resolve: session sets the session and succeeds ---
  {
    const sb = stubClient();
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'session', access_token: 'AT', refresh_token: 'RT' });
    assert(r.ok === true, 'resolve: session flow succeeds');
    assert(sb.calls.setSession.length === 1 && sb.calls.setSession[0].access_token === 'AT', 'resolve: setSession called with the hash tokens');
  }

  // --- resolve: PKCE code is exchanged ---
  {
    const sb = stubClient();
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'code', code: 'CODE123' });
    assert(r.ok === true, 'resolve: code flow succeeds');
    assert(sb.calls.exchangeCodeForSession.length === 1 && sb.calls.exchangeCodeForSession[0] === 'CODE123', 'resolve: exchangeCodeForSession called with the code');
  }

  // --- resolve: token_hash is verified with its type ---
  {
    const sb = stubClient();
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'token_hash', token_hash: 'TH', type: 'signup' });
    assert(r.ok === true, 'resolve: token_hash flow succeeds');
    assert(sb.calls.verifyOtp.length === 1 && sb.calls.verifyOtp[0].token_hash === 'TH' && sb.calls.verifyOtp[0].type === 'signup', 'resolve: verifyOtp called with token_hash + type');
  }

  // --- resolve: expired error is reported as expired, never as success ---
  {
    const sb = stubClient();
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' });
    assert(r.ok === false, 'resolve: expired link is NOT a false success');
    assert(r.expired === true, 'resolve: expired link flagged as expired');
    assert(sb.calls.setSession.length === 0 && sb.calls.verifyOtp.length === 0, 'resolve: expired error performs no verification call');
  }

  // --- resolve: verifyOtp error surfaces as failure ---
  {
    const sb = stubClient({ verifyOtp: { data: { session: null }, error: { message: 'Token has expired or is invalid' } } });
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'token_hash', token_hash: 'TH', type: 'signup' });
    assert(r.ok === false && r.expired === true, 'resolve: verifyOtp error -> failure flagged expired');
  }

  // --- resolve: no token but an existing session counts as confirmed (reload) ---
  {
    const sb = stubClient({ getSession: { data: { session: { id: 'existing' } } } });
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'none' });
    assert(r.ok === true, 'resolve: reload with existing session -> success');
    assert(sb.calls.getSession === 1, 'resolve: none checks for an existing session');
  }

  // --- resolve: no token and no session -> actionable failure ---
  {
    const sb = stubClient();
    const r = await BelfedConfirm.resolveConfirmation(sb, { kind: 'none' });
    assert(r.ok === false && r.expired === false, 'resolve: no token + no session -> failure');
  }

  console.log(failures === 0 ? '\nAll confirmation tests passed.' : '\n' + failures + ' assertion(s) failed.');
  process.exit(failures === 0 ? 0 : 1);
})();
