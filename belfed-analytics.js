// ===========================================
// BelFed Analytics — lightweight UTM + event layer
// ===========================================
// Safe, dependency-free. No network calls of its own.
// - Captures & persists first-touch and last-touch UTM params.
// - Propagates UTMs onto internal /members.html links (esp. #signup).
// - Exposes BelfedAnalytics.track(name, props) which records events to
//   window.belfedEvents and window.dataLayer, and console-logs in debug mode.
// Wire a real backend later by reading window.belfedEvents or overriding
// window.BelfedAnalytics.sink.
(function (w, d) {
  'use strict';

  var UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var FIRST_KEY = 'bf_utm_first';
  var LAST_KEY = 'bf_utm_last';

  function safeGet(store, key) {
    try { return store.getItem(key); } catch (e) { return null; }
  }
  function safeSet(store, key, val) {
    try { store.setItem(key, val); } catch (e) {}
  }
  function parseJSON(s) {
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function readUrlUtms() {
    var out = {};
    var params;
    try { params = new URLSearchParams(w.location.search); } catch (e) { return out; }
    UTM_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) out[k] = v;
    });
    return out;
  }

  var urlUtms = readUrlUtms();
  var hasUrlUtms = Object.keys(urlUtms).length > 0;

  // First-touch: write once, never overwrite.
  if (hasUrlUtms && !safeGet(localStorage, FIRST_KEY)) {
    safeSet(localStorage, FIRST_KEY, JSON.stringify(urlUtms));
  }
  // Last-touch: overwrite whenever a fresh UTM-tagged visit happens.
  if (hasUrlUtms) {
    safeSet(localStorage, LAST_KEY, JSON.stringify(urlUtms));
  }

  function getFirstTouch() { return parseJSON(safeGet(localStorage, FIRST_KEY)) || {}; }
  function getLastTouch() {
    // Prefer current URL UTMs, then stored last-touch, then first-touch.
    if (hasUrlUtms) return urlUtms;
    return parseJSON(safeGet(localStorage, LAST_KEY)) || getFirstTouch();
  }

  // Flat fields suitable for inclusion in a payload (last-touch + first-touch).
  function utmFields() {
    var last = getLastTouch();
    var first = getFirstTouch();
    var out = {};
    UTM_KEYS.forEach(function (k) {
      if (last[k]) out[k] = last[k];
      if (first[k]) out['first_' + k] = first[k];
    });
    return out;
  }

  function isDebug() {
    try {
      if (/[?&]debug=1\b/.test(w.location.search)) { safeSet(localStorage, 'bf_debug', '1'); return true; }
      return safeGet(localStorage, 'bf_debug') === '1';
    } catch (e) { return false; }
  }

  // Append the active UTMs (last-touch) to an internal URL, preserving its hash.
  function decorate(url) {
    var utms = getLastTouch();
    var keys = Object.keys(utms);
    if (!keys.length || !url) return url;
    try {
      var abs = new URL(url, w.location.href);
      // Only decorate same-origin links.
      if (abs.origin !== w.location.origin) return url;
      keys.forEach(function (k) {
        if (!abs.searchParams.has(k)) abs.searchParams.set(k, utms[k]);
      });
      // Return in the same shape we were given (relative if it started relative).
      return abs.pathname + abs.search + abs.hash;
    } catch (e) { return url; }
  }

  function decorateLinks() {
    var anchors = d.querySelectorAll('a[href*="members.html"], a[href*="trial.html"]');
    Array.prototype.forEach.call(anchors, function (a) {
      var href = a.getAttribute('href');
      if (!href || /^https?:\/\//i.test(href) && href.indexOf(w.location.host) === -1) {
        // skip external absolute links to other hosts
        if (/^https?:\/\//i.test(href) && href.indexOf(w.location.host) === -1) return;
      }
      a.setAttribute('href', decorate(href));
    });
  }

  function track(name, props) {
    var payload = { event: name, ts: new Date().toISOString() };
    var utms = utmFields();
    for (var k in utms) { if (utms.hasOwnProperty(k)) payload[k] = utms[k]; }
    if (props) { for (var p in props) { if (props.hasOwnProperty(p)) payload[p] = props[p]; } }
    try { (w.belfedEvents = w.belfedEvents || []).push(payload); } catch (e) {}
    try { (w.dataLayer = w.dataLayer || []).push(payload); } catch (e) {}
    if (isDebug()) { try { console.log('[belfed:event]', name, payload); } catch (e) {} }
    if (typeof w.BelfedAnalytics.sink === 'function') {
      try { w.BelfedAnalytics.sink(payload); } catch (e) {}
    }
    return payload;
  }

  w.BelfedAnalytics = {
    UTM_KEYS: UTM_KEYS,
    getFirstTouch: getFirstTouch,
    getLastTouch: getLastTouch,
    utmFields: utmFields,
    decorate: decorate,
    track: track,
    sink: null // assign a function to forward events to a backend
  };
  // Short global alias.
  w.belfedTrack = track;

  // Delegated funnel-click tracking. Safe everywhere the script is loaded.
  function wireClickTracking() {
    d.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a, button') : null;
      if (!a) return;
      var href = (a.getAttribute && a.getAttribute('href')) || '';
      if (/t\.me\/(belfedbot|tribute)|tribute\.tg/i.test(href)) {
        if (/tribute/i.test(href)) track('payment_started', { href: href });
        else track('telegram_connected', { href: href });
        return;
      }
      if (a.hasAttribute && a.hasAttribute('data-bf-cta')) {
        track('cta_click', { cta: a.getAttribute('data-bf-cta') || (a.textContent || '').trim().slice(0, 60) });
        return;
      }
      if (/members\.html(#signup)?$/i.test(href) || /#signup$/i.test(href) || /#pricing$/i.test(href)) {
        track('cta_click', { cta: (a.textContent || '').trim().slice(0, 60), href: href });
      }
    }, true);
  }

  function onReady() {
    decorateLinks();
    wireClickTracking();
    // Decorate again shortly after, in case scripts inject links late.
    setTimeout(decorateLinks, 800);
  }
  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})(window, document);
