// ===========================================
// BelFed Email Confirmation Handler (EN)
// ===========================================
// Loaded by confirm.html AFTER the supabase-js CDN script.
//
// Supabase can hand a confirmation back to this page in several shapes and the
// page must handle all of them — previously confirm.html was a static stub that
// ignored the token entirely and always claimed success, so expired/invalid
// links silently left email_confirmed_at = null:
//
//   1. Implicit / verify-redirect flow — the hash carries the session:
//        /confirm.html#access_token=...&refresh_token=...&type=signup
//   2. PKCE flow — the query carries an auth code to exchange:
//        /confirm.html?code=...
//   3. token_hash flow — the query carries a hashed OTP to verify:
//        /confirm.html?token_hash=...&type=signup|email|magiclink|recovery
//   4. Failure redirect from Supabase /verify (e.g. expired link):
//        /confirm.html#error=access_denied&error_code=otp_expired&error_description=...
//
// This module exposes pure, unit-testable helpers on window.BelfedConfirm.

(function (global) {
  'use strict';

  // Merge both the query string and the URL hash fragment into one param bag.
  // Supabase uses the query for code/token_hash and the hash for session tokens
  // and error redirects, so we always look at both.
  function parseAuthParams(loc) {
    var out = {};
    function add(qs) {
      if (!qs) return;
      if (qs.charAt(0) === '?' || qs.charAt(0) === '#') qs = qs.substring(1);
      if (!qs) return;
      var sp = new global.URLSearchParams(qs);
      sp.forEach(function (v, k) { if (!(k in out)) out[k] = v; });
    }
    add(loc && loc.search);
    add(loc && loc.hash);
    return out;
  }

  // Decide which flow we are in based on the params present.
  function classifyConfirmation(params) {
    params = params || {};
    if (params.error || params.error_code || params.error_description) {
      return {
        kind: 'error',
        code: params.error_code || params.error || 'error',
        description: params.error_description || ''
      };
    }
    if (params.access_token && params.refresh_token) {
      return { kind: 'session', access_token: params.access_token, refresh_token: params.refresh_token };
    }
    if (params.code) {
      return { kind: 'code', code: params.code };
    }
    if (params.token_hash && params.type) {
      return { kind: 'token_hash', token_hash: params.token_hash, type: params.type };
    }
    return { kind: 'none' };
  }

  function looksExpired(text) {
    return /expired|otp_expired|invalid|already/i.test(String(text || ''));
  }

  // Perform the confirmation against Supabase. Resolves to:
  //   { ok: true, session }
  //   { ok: false, expired: <bool>, message }
  async function resolveConfirmation(sb, cls) {
    try {
      if (!cls || cls.kind === 'none') {
        // No token in the URL. The link may already have been consumed (e.g. the
        // user reloaded confirm.html) — if a session exists, treat as confirmed.
        var s = await sb.auth.getSession();
        if (s && s.data && s.data.session) return { ok: true, session: s.data.session };
        return { ok: false, expired: false, message: 'No confirmation token was found in this link. Request a new one below.' };
      }

      if (cls.kind === 'error') {
        return {
          ok: false,
          expired: looksExpired(cls.code + ' ' + cls.description),
          message: cls.description || 'This confirmation link is invalid or has expired.'
        };
      }

      if (cls.kind === 'session') {
        var r = await sb.auth.setSession({ access_token: cls.access_token, refresh_token: cls.refresh_token });
        if (r && r.error) return { ok: false, expired: looksExpired(r.error.message), message: r.error.message };
        return { ok: true, session: r && r.data && r.data.session };
      }

      if (cls.kind === 'code') {
        var rc = await sb.auth.exchangeCodeForSession(cls.code);
        if (rc && rc.error) return { ok: false, expired: looksExpired(rc.error.message), message: rc.error.message };
        return { ok: true, session: rc && rc.data && rc.data.session };
      }

      if (cls.kind === 'token_hash') {
        var rt = await sb.auth.verifyOtp({ token_hash: cls.token_hash, type: cls.type });
        if (rt && rt.error) return { ok: false, expired: looksExpired(rt.error.message), message: rt.error.message };
        return { ok: true, session: rt && rt.data && rt.data.session };
      }

      return { ok: false, expired: false, message: 'This confirmation link is not recognised.' };
    } catch (e) {
      return { ok: false, expired: looksExpired(e && e.message), message: (e && e.message) || 'Confirmation failed.' };
    }
  }

  var api = {
    parseAuthParams: parseAuthParams,
    classifyConfirmation: classifyConfirmation,
    resolveConfirmation: resolveConfirmation,
    looksExpired: looksExpired
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
  global.BelfedConfirm = api;
})(typeof window !== 'undefined' ? window : globalThis);
