#!/usr/bin/env node
// Lightweight, dependency-free compliance checks for the EN production site.
// Guards the legal/compliance remediation batch: consent defaults, submit
// gating, legal links, and absence of prohibited wording.
// Run with: node tests/compliance-check.mjs   (or: npm test)

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(root, f), 'utf8');

let failures = 0;
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failures++;
}

// ---------- index.html lead form ----------
const index = read('index.html');

// The required data-processing consent checkbox must NOT be pre-checked.
const consentInput = (index.match(/<input[^>]*id="consent"[^>]*>/) || [''])[0];
check('index: #consent checkbox exists', consentInput.length > 0, consentInput);
check('index: #consent is NOT prechecked (no checked attr)', consentInput && !/\bchecked\b/.test(consentInput), consentInput);

// A separate, optional marketing opt-in must exist and also not be prechecked.
const mkInput = (index.match(/<input[^>]*id="marketingConsent"[^>]*>/) || [''])[0];
check('index: separate #marketingConsent opt-in exists', mkInput.length > 0, mkInput);
check('index: #marketingConsent is NOT prechecked', mkInput && !/\bchecked\b/.test(mkInput), mkInput);

// Submission must be gated on the required consent with an accessible error.
check('index: has accessible consent error node (role=alert)',
  /id="consentErr"[^>]*role="alert"/.test(index) || /role="alert"[^>]*id="consentErr"/.test(index));
check('index: submit handler blocks when consent unchecked',
  /if\s*\(\s*!consent\s*\)\s*\{[\s\S]{0,200}?return;/.test(index));
check('index: marketing_consent sent as separate payload field',
  /marketing_consent\s*:\s*marketingConsent/.test(index));

// No blanket pre-checked user-facing consent checkboxes anywhere in the lead form area.
check('index: no "consent" checkbox with checked attribute',
  !/<input[^>]*name="consent"[^>]*\bchecked\b/.test(index));

// ---------- dashboard.html signup consent ----------
const dash = read('dashboard.html');
const suConsent = (dash.match(/<input[^>]*id="suConsent"[^>]*>/) || [''])[0];
check('dashboard: #suConsent required-consent checkbox exists', suConsent.length > 0, suConsent);
check('dashboard: #suConsent is NOT prechecked', suConsent && !/\bchecked\b/.test(suConsent), suConsent);
const suMk = (dash.match(/<input[^>]*id="suMarketing"[^>]*>/) || [''])[0];
check('dashboard: optional #suMarketing opt-in exists', suMk.length > 0, suMk);
check('dashboard: #suMarketing is NOT prechecked', suMk && !/\bchecked\b/.test(suMk), suMk);

// belfed-auth.js must gate signup on consent and carry marketing consent separately.
const auth = read('belfed-auth.js');
check('auth: signup gated on suConsent', /getElementById\('suConsent'\)/.test(auth) && /!consentBox\.checked/.test(auth));
check('auth: marketing_consent captured in signup metadata', /marketing_consent\s*:/.test(auth));

// ---------- legal links resolve ----------
for (const f of ['privacy.html', 'terms.html', 'disclaimer.html']) {
  check(`legal: ${f} exists`, existsSync(join(root, f)));
}

// ---------- legal page facts / versions ----------
const privacy = read('privacy.html');
const terms = read('terms.html');
const disclaimer = read('disclaimer.html');

check('privacy: has last-updated/version line', /Last updated:.*Version/i.test(privacy));
check('terms: has last-updated/version line', /Last updated:.*Version/i.test(terms));
check('disclaimer: has last-updated/version line', /Last updated:.*Version/i.test(disclaimer));

// Operator described as individual entrepreneur, not "самозанятый/self-employed".
check('privacy: operator is Individual entrepreneur (ИП)', /Individual entrepreneur/i.test(privacy));
check('privacy: does NOT call operator "Самозанятый"', !/Самозанятый|self-employed/i.test(privacy));

// Tribute described as primary payment provider.
check('privacy: mentions Tribute as payment provider', /Tribute/.test(privacy));
check('terms: Tribute is primary payment method', /Primary payment method: Tribute/i.test(terms));

// Differentiated rights timelines, not a blanket 30-day promise.
check('privacy: uses differentiated statutory periods (7 working days)', /7 working days/i.test(privacy));
check('privacy: no blanket "respond within 30 calendar days" wording',
  !/respond within 30 calendar days/i.test(privacy));

// ---------- prohibited / high-risk wording ----------
check('index: no "recommendations on asset allocation" suitability claim',
  !/recommendations on asset allocation/i.test(index));
check('index: no "concrete recommendations on asset allocation"',
  !/concrete recommendations on asset allocation/i.test(index));

// Refund wording: remove categorical no-refund-after-access; keep ст.32 right.
check('terms: no categorical "non-refundable" after access',
  !/is non-refundable/i.test(terms));
check('terms: preserves right to cancel with actual-expenses deduction',
  /actually incurred|actual expenses/i.test(terms));
check('terms: references consumer right to refuse services (Art. 32)',
  /Article 32|Art\.?\s*32/i.test(terms));

// Renewal/cancellation disclosed.
check('terms: renewal/cancellation disclosed', /renews automatically/i.test(terms) && /cancel/i.test(terms));

// No promises of returns / guaranteed profit in public copy.
for (const [name, html] of [['index', index], ['products.html', existsSync(join(root,'products.html')) ? read('products.html') : ''], ['disclaimer', disclaimer]]) {
  check(`${name}: no guaranteed-returns promise`,
    !/guaranteed (returns|profit|income)|guarantee[sd]? (you )?(a )?(profit|return)/i.test(html));
}

// ---------- report ----------
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : (r.detail ? `\n      -> ${String(r.detail).slice(0,160)}` : '')}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed.`);
process.exit(failures ? 1 : 0);
