// ===========================================
// BelFed Auth — Shared Identity Module (EN)
// ===========================================
// Include AFTER supabase-js CDN script.
// Each page must define: onAuthReady(profile, session)
// and onAuthSignedOut()

var SUPABASE_URL = 'https://obujqvqqmyfcfflhqvud.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9idWpxdnFxbXlmY2ZmbGhxdnVkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzNDgxNjYsImV4cCI6MjA4OTkyNDE2Nn0.syl4YBLbf8aBitxyK3gCL51pPYxWjEW99mMTXJaQQ8w';
var supaClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
var currentProfile = null;
var currentSubscription = null;

// --- Auth UI helpers ---
function showAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(function(b) { b.classList.remove('active'); });
  event.target.classList.add('active');
  document.getElementById('signinForm').style.display = tab === 'signin' ? 'block' : 'none';
  document.getElementById('signupForm').style.display = tab === 'signup' ? 'block' : 'none';
  var mlForm = document.getElementById('magiclinkForm'); if (mlForm) mlForm.style.display = tab === 'magiclink' ? 'block' : 'none';
  document.getElementById('loginError').style.display = 'none';
  document.getElementById('loginMsg').style.display = 'none';
  var fpBlock = document.getElementById('forgotPasswordBlock');
  var fpLink = document.getElementById('forgotPasswordLink');
  if (fpBlock) fpBlock.style.display = 'none';
  if (fpLink) fpLink.style.display = 'block';
  var rs = document.getElementById('resetStatus');
  if (rs) rs.style.display = 'none';
}

async function handleSignIn() {
  var email = document.getElementById('siEmail').value.trim();
  var pw = document.getElementById('siPassword').value;
  var errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if (!email || !pw) { errEl.textContent = 'Please enter email and password'; errEl.style.display = 'block'; return; }
  try {
    var res = await supaClient.auth.signInWithPassword({ email: email, password: pw });
    if (res.error) throw res.error;
  } catch (err) { errEl.textContent = err.message || 'Login failed'; errEl.style.display = 'block'; }
}

async function handleMagicLink() {
  var email = document.getElementById('mlEmail').value.trim();
  var errEl = document.getElementById('loginError');
  var msgEl = document.getElementById('loginMsg');
  errEl.style.display = 'none';
  msgEl.style.display = 'none';
  if (!email) { errEl.textContent = 'Please enter your email'; errEl.style.display = 'block'; return; }
  try {
    var res = await supaClient.auth.signInWithOtp({
      email: email,
      options: { emailRedirectTo: window.location.origin + '/confirm.html' }
    });
    if (res.error) throw res.error;
    msgEl.textContent = 'Magic link sent! Check your email and click the link to sign in.';
    msgEl.style.display = 'block';
  } catch (err) {
    errEl.textContent = err.message || 'Failed to send magic link';
    errEl.style.display = 'block';
  }
}

// ===========================================
// BelFed Auth — Signup UX patch (EN)
// ===========================================

(function () {
  function injectStyles() {
    if (document.getElementById('belfed-signup-styles')) return;
    var css = ''
      + '.signup-consent{margin:14px 0 8px;font-size:12px;line-height:1.55;display:flex;align-items:flex-start;gap:8px;letter-spacing:0.02em}'
      + '.signup-consent input[type="checkbox"]{margin-top:3px;flex-shrink:0;cursor:pointer;width:14px;height:14px}'
      + '.signup-consent label{cursor:pointer;color:var(--gray,#666)}'
      + '.signup-consent a{color:inherit;text-decoration:underline;text-underline-offset:2px}'
      + '.signup-consent a:hover{color:var(--green,#1a7a1a)}'
      + '.signup-success{padding:24px 22px;border:1px solid #000;background:#fff;margin-top:18px}'
      + '.signup-success h3{margin:0 0 12px;font-size:14px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase}'
      + '.signup-success p{margin:0 0 20px;font-size:13px;line-height:1.6;color:#222}'
      + '.signup-success .cta-tg{display:block;width:100%;text-align:center;padding:16px 18px;background:#000;color:#fff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;border:1px solid #000;transition:background .15s ease,color .15s ease}'
      + '.signup-success .cta-tg:hover{background:#1a7a1a;border-color:#1a7a1a;color:#fff}'
      + '.signup-success .signup-success-note{margin:14px 0 0;font-size:11px;color:var(--gray,#999);text-align:center;letter-spacing:0.04em}'
      + '.signup-success .signup-success-note a{color:inherit;text-decoration:underline}';
    var st = document.createElement('style');
    st.id = 'belfed-signup-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function injectConsent() {
    document.querySelectorAll('#signupForm').forEach(function (form) {
      if (form.querySelector('.signup-consent')) return;
      var btn = form.querySelector('.login-btn');
      if (!btn) return;
      var wrap = document.createElement('div');
      wrap.className = 'signup-consent';
      wrap.innerHTML = ''
        + '<input type="checkbox" id="suConsent">'
        + '<label for="suConsent">I agree to the <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a> and <a href="/terms.html" target="_blank" rel="noopener">Terms of Service</a></label>';
      form.insertBefore(wrap, btn);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { injectStyles(); injectConsent(); });
  } else {
    injectStyles();
    injectConsent();
  }
})();

async function handleSignUp() {
  var email = document.getElementById('suEmail').value.trim();
  var pw  = document.getElementById('suPassword').value;
  var pw2 = document.getElementById('suPassword2').value;
  var consentBox = document.getElementById('suConsent');
  var errEl = document.getElementById('loginError');
  var msgEl = document.getElementById('loginMsg');
  errEl.style.display = 'none'; msgEl.style.display = 'none';
  msgEl.innerHTML = '';

  if (!email || !pw || !pw2) { errEl.textContent = 'Please fill in all fields'; errEl.style.display = 'block'; return; }
  if (pw !== pw2) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
  if (pw.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; errEl.style.display = 'block'; return; }
  if (!consentBox || !consentBox.checked) {
    errEl.textContent = 'You must agree to the Privacy Policy and Terms of Service';
    errEl.style.display = 'block';
    return;
  }

  var btn = document.querySelector('#signupForm .login-btn');
  var prevBtnText = null;
  if (btn) { prevBtnText = btn.textContent; btn.disabled = true; btn.textContent = 'Creating account...'; }

  try {
    var res = await supaClient.auth.signUp({
      email: email,
      password: pw,
      options: { emailRedirectTo: window.location.origin + '/confirm.html' }
    });
    if (res.error) throw res.error;

    var intentRes = await fetch(SUPABASE_URL + '/functions/v1/trial-intent-create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        lang: 'en',
        source: 'web_signup',
        accept_privacy: true,
        accept_terms: true
      })
    });
    var intentData = await intentRes.json();
    var deepLink = (intentData && intentData.ok && intentData.deep_link)
      ? intentData.deep_link
      : 'https://t.me/BelfedBot?start=trial_link';

    msgEl.innerHTML = ''
      + '<div class="signup-success">'
      + '  <h3>Account created</h3>'
      + '  <p>To activate your 14-day access to the dashboard and receive our trades in real time — join our trading group.</p>'
      + '  <a class="cta-tg" href="' + deepLink + '" target="_blank" rel="noopener">Join our trading group</a>'
      + '  <div class="signup-success-note">Link is single-use and valid for 15 minutes. If it expires — <a href="#" onclick="document.getElementById(\'signupForm\').querySelector(\'.login-btn\').click();return false;">request a new one</a>.</div>'
      + '</div>';
    msgEl.style.display = 'block';

    if (res.data.session) {
      await checkProfile();
    }
  } catch (err) {
    errEl.textContent = err.message || 'Sign up failed';
    errEl.style.display = 'block';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prevBtnText || 'START FREE TRIAL'; }
  }
}

async function handleForgotPassword() {
  var email = document.getElementById('resetEmail').value.trim();
  var statusEl = document.getElementById('resetStatus');
  statusEl.style.display = 'block';
  if (!email) { statusEl.textContent = 'Please enter your email'; statusEl.style.color = 'var(--red, #c50000)'; return; }
  statusEl.textContent = 'Sending reset link...'; statusEl.style.color = 'var(--gray, #999)';
  try {
    var res = await supaClient.auth.resetPasswordForEmail(email, { redirectTo: 'https://belfed.com/reset-password.html' });
    if (res.error) throw res.error;
    statusEl.textContent = 'Reset link sent! Check your email.'; statusEl.style.color = 'var(--green, #1a7a1a)';
  } catch (err) { statusEl.textContent = err.message || 'Error sending reset link'; statusEl.style.color = 'var(--red, #c50000)'; }
}

async function handleLogout() {
  await supaClient.auth.signOut();
  currentProfile = null;
  currentSubscription = null;
  if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
}

// --- Entitlement engine ---
async function getEntitlement(uid) {
  var subRes = await supaClient.from('subscriptions').select('*').eq('user_id', uid).in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1);
  if (subRes.data && subRes.data.length > 0) {
    var sub = subRes.data[0];
    if (sub.current_period_end && new Date(sub.current_period_end) > new Date()) {
      return { access: true, reason: 'subscription', status: sub.status, subscription: sub };
    }
    return { access: false, reason: 'subscription_expired', status: 'expired', subscription: sub };
  }
  var profRes = await supaClient.from('profiles').select('*').eq('id', uid).single();
  if (profRes.error || !profRes.data) return { access: false, reason: 'no_profile', status: 'none', profile: null };
  var p = profRes.data;
  currentProfile = p;
  if (p.subscription_status === 'admin') return { access: true, reason: 'admin', status: 'admin', profile: p };
  if (p.subscription_status === 'active') return { access: true, reason: 'active', status: 'active', profile: p };
  if (p.subscription_status === 'trial') {
    if (p.trial_end && new Date(p.trial_end) > new Date()) {
      return { access: true, reason: 'trial', status: 'trial', profile: p };
    }
    await supaClient.from('profiles').update({ subscription_status: 'expired' }).eq('id', uid);
    p.subscription_status = 'expired';
    return { access: false, reason: 'trial_expired', status: 'expired', profile: p };
  }
  return { access: false, reason: 'expired', status: p.subscription_status || 'none', profile: p };
}

async function checkProfile() {
  var sess = await supaClient.auth.getSession();
  if (!sess.data.session) {
    if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
    return;
  }
  var uid = sess.data.session.user.id;
  var ent = await getEntitlement(uid);
  if (!currentProfile) {
    var pr = await supaClient.from('profiles').select('*').eq('id', uid).single();
    if (pr.data) currentProfile = pr.data;
  }
  currentSubscription = ent.subscription || null;
  if (typeof onAuthReady === 'function') onAuthReady(currentProfile, sess.data.session, ent);
}

async function checkAuth() {
  var hash = window.location.hash;
  if (hash && hash.includes('access_token')) {
    var params = new URLSearchParams(hash.substring(1));
    var at = params.get('access_token');
    var rt = params.get('refresh_token');
    if (at && rt) {
      await supaClient.auth.setSession({ access_token: at, refresh_token: rt });
      window.location.hash = '';
    }
  }
  var sess = await supaClient.auth.getSession();
  if (sess.data.session) { await checkProfile(); }
  else { if (typeof onAuthSignedOut === 'function') onAuthSignedOut(); }
}

supaClient.auth.onAuthStateChange(function(event, session) {
  if (event === 'SIGNED_IN' && session) { checkProfile(); }
  if (event === 'SIGNED_OUT') {
    currentProfile = null;
    currentSubscription = null;
    if (typeof onAuthSignedOut === 'function') onAuthSignedOut();
  }
});

checkAuth();
