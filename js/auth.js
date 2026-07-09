// Auth Module — Supabase-only (no localStorage auth)
var currentUser = null;
var _authEmail = '';
var _otpContext = ''; // 'login-otp' | 'signup'
var _resendTimer = null;
var _resendSeconds = 180;
var _initialAuthDone = false; // true once first INITIAL_SESSION or first SIGNED_IN is processed

// ── Init ──────────────────────────────────────────────────────────────────────

function initAuth() {
  if (_sb) {
    _sb.auth.onAuthStateChange(function(event, session) {

      // ── INITIAL_SESSION: app just opened, silently restore existing session ──
      if (event === 'INITIAL_SESSION') {
        if (session && session.user) {
          setUser(session.user);
          updateProfileUI();
        }
        _initialAuthDone = true;
        return;
      }

      // ── TOKEN_REFRESHED: background token refresh — silent ──
      if (event === 'TOKEN_REFRESHED') {
        if (session && session.user) {
          setUser(session.user);
        }
        return;
      }

      // ── SIGNED_IN ──────────────────────────────────────────────────────────
      if (event === 'SIGNED_IN' && session && session.user) {
        setUser(session.user);
        updateProfileUI();

        // Older Supabase clients fire SIGNED_IN instead of INITIAL_SESSION on
        // app open. If initial check hasn't been marked done yet, this is a
        // silent session restore — no toast, no redirect.
        if (!_initialAuthDone) {
          _initialAuthDone = true;
          return;
        }

        // Actual new login
        ensureUserRecord(session.user);
        var meta = session.user.user_metadata || {};
        if (!meta.name) {
          showAuthStep('profile-setup');
        } else {
          if (currentPage === 'login') {
            showPage('home');
          }
          showToast('Login successful!');
        }
        return;
      }

      // ── SIGNED_OUT ─────────────────────────────────────────────────────────
      if (event === 'SIGNED_OUT') {
        clearUser();
        updateProfileUI();
        showToast('Logged out.');
        return;
      }

      // ── USER_UPDATED ───────────────────────────────────────────────────────
      if (event === 'USER_UPDATED') {
        if (session && session.user) {
          setUser(session.user);
          updateProfileUI();
        }
        return;
      }
    });
  }

  renderOTPBoxes();
  updateProfileUI();
}

// ── Auto-create user in "users" table after login ─────────────────────────────

async function ensureUserRecord(user) {
  if (!_sb || !user || !user.id) return;
  try {
    var meta = user.user_metadata || {};
    var row = { id: user.id };
    if (meta.name)   row.name   = meta.name;
    if (meta.gender) row.gender = meta.gender;
    if (meta.age)    row.age    = meta.age;
    console.log('[USER] ensureUserRecord →', JSON.stringify(row));
    await _sb.from('users').upsert(row, { onConflict: 'id', ignoreDuplicates: false });
  } catch (e) {
    console.log('[USER] ensureUserRecord error:', e.message);
  }
}

// ── User State ────────────────────────────────────────────────────────────────

function setUser(user) {
  var meta = user.user_metadata || {};
  currentUser = {
    id: user.id,
    email: user.email,
    name: meta.name || '',
    username: meta.name || meta.username || (user.email ? user.email.split('@')[0] : 'User'),
    gender: meta.gender || '',
    age: meta.age || ''
  };
}

function clearUser() {
  currentUser = null;
}

// ── Profile UI ────────────────────────────────────────────────────────────────

function updateProfileUI() {
  var nameEl = document.getElementById('profile-name');
  var uidEl = document.getElementById('profile-uid');
  var copyBtn = document.getElementById('uid-copy-btn');
  var authLabel = document.getElementById('auth-label');

  if (currentUser && currentUser.id) {
    if (nameEl) nameEl.textContent = currentUser.name || currentUser.username || 'User';
    if (authLabel) authLabel.textContent = 'Logout';
    if (uidEl) {
      uidEl.textContent = 'UID: Loading…';
      loadProfileUID(currentUser.id);
    }
    if (copyBtn) copyBtn.style.display = 'inline-flex';
  } else {
    if (nameEl) nameEl.textContent = 'Guest User';
    if (uidEl) uidEl.textContent = 'UID: —';
    if (copyBtn) copyBtn.style.display = 'none';
    if (authLabel) authLabel.textContent = 'Login';
  }
}

async function loadProfileUID(userId) {
  var uidEl = document.getElementById('profile-uid');
  if (!_sb || !userId) {
    if (uidEl) uidEl.textContent = 'UID: —';
    return;
  }
  try {
    var res = await _sb.from('users').select('custom_uid').eq('id', userId).maybeSingle();
    var uid = res && res.data && res.data.custom_uid ? res.data.custom_uid : null;
    if (uidEl) uidEl.textContent = uid ? 'UID: ' + uid : 'UID: —';
    window._currentUID = uid;
  } catch (e) {
    console.log('[PROFILE] loadProfileUID error:', e.message);
    if (uidEl) uidEl.textContent = 'UID: —';
  }
}

function copyUID() {
  var uid = window._currentUID;
  if (!uid) { showToast('UID not available'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(uid).then(function() {
      showToast('UID copied');
    }).catch(function() {
      _fallbackCopy(uid);
    });
  } else {
    _fallbackCopy(uid);
  }
}

function _fallbackCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { document.execCommand('copy'); showToast('UID copied'); }
  catch (e) { showToast('Copy failed'); }
  document.body.removeChild(ta);
}

function handleAuthClick() {
  if (isLoggedIn()) {
    logoutUser();
  } else {
    openLoginPage();
  }
}

async function logoutUser() {
  if (_sb) await _sb.auth.signOut();
  clearUser();
  updateProfileUI();
  showToast('Logged out successfully.');
  showPage('home');
}

// ── Open Login Page ───────────────────────────────────────────────────────────

function openLoginPage(mode) {
  mode = mode || 'login';
  showPage('login');
  switchAuthMode(mode);
}

// ── Step Management ───────────────────────────────────────────────────────────

var _allAuthSteps = [
  'login-pass', 'login-otp-send', 'otp-verify', 'signup-email', 'profile-setup'
];

function showAuthStep(step) {
  _allAuthSteps.forEach(function(s) {
    var el = document.getElementById('step-' + s);
    if (el) el.classList.add('hidden');
  });
  var target = document.getElementById('step-' + step);
  if (target) target.classList.remove('hidden');

  var title = document.getElementById('auth-title');
  var subtitle = document.getElementById('auth-subtitle');
  var tabs = document.getElementById('auth-tabs');
  var guestBtn = document.getElementById('guest-btn');
  var backBtn = document.getElementById('auth-back-btn');

  if (title && subtitle && tabs) {
    switch (step) {
      case 'login-pass':
        title.textContent = 'Welcome Back';
        subtitle.textContent = 'Login to continue your journey';
        tabs.classList.remove('hidden');
        if (guestBtn) guestBtn.classList.remove('hidden');
        if (backBtn) backBtn.classList.add('hidden');
        break;
      case 'login-otp-send':
        title.textContent = 'Login via OTP';
        subtitle.textContent = 'We\'ll send a code to your email';
        tabs.classList.add('hidden');
        if (guestBtn) guestBtn.classList.add('hidden');
        if (backBtn) backBtn.classList.remove('hidden');
        break;
      case 'otp-verify':
        title.textContent = 'Enter OTP';
        subtitle.textContent = 'Check your email: ' + (_authEmail ? _authEmail.split('@')[0] + '@...' : '');
        tabs.classList.add('hidden');
        if (guestBtn) guestBtn.classList.add('hidden');
        if (backBtn) backBtn.classList.remove('hidden');
        break;
      case 'signup-email':
        title.textContent = 'Create Account';
        subtitle.textContent = 'Join Emperor FM today';
        tabs.classList.remove('hidden');
        if (guestBtn) guestBtn.classList.remove('hidden');
        if (backBtn) backBtn.classList.add('hidden');
        break;
      case 'profile-setup':
        title.textContent = 'Setup Profile';
        subtitle.textContent = 'Tell us a bit about yourself';
        tabs.classList.add('hidden');
        if (guestBtn) guestBtn.classList.add('hidden');
        if (backBtn) backBtn.classList.add('hidden');
        break;
    }
  }

  setAuthMsg('');
  clearOTPBoxes();
}

function switchAuthMode(mode) {
  var tabs = document.querySelectorAll('.auth-tab');
  tabs.forEach(function(t) {
    t.classList.toggle('active', t.dataset.mode === mode);
  });
  if (mode === 'login') {
    showAuthStep('login-pass');
  } else {
    showAuthStep('signup-email');
  }
}

function switchToOTPLogin() {
  _otpContext = 'login-otp';
  showAuthStep('login-otp-send');
}

function switchToPasswordLogin() {
  showAuthStep('login-pass');
}

function goBackInAuth() {
  if (_otpContext === 'login-otp') {
    showAuthStep('login-otp-send');
  } else if (_otpContext === 'signup') {
    showAuthStep('signup-email');
  } else {
    showAuthStep('login-pass');
  }
  stopResendTimer();
}

function continueAsGuest() {
  showPage('home');
}

// ── Login with Password ───────────────────────────────────────────────────────

async function loginWithPassword() {
  var emailEl = document.getElementById('login-email');
  var passEl = document.getElementById('login-password');
  var email = emailEl ? emailEl.value.trim() : '';
  var password = passEl ? passEl.value : '';

  if (!email) { setAuthMsg('Please enter your email.'); return; }
  if (!password) { setAuthMsg('Please enter your password.'); return; }
  if (!_sb) { setAuthMsg('Supabase not connected.'); return; }

  setAuthMsg('Logging in...', false);
  setBtnLoading('btn-login-pass', true);

  try {
    var result = await _sb.auth.signInWithPassword({ email: email, password: password });
    if (result.error) throw result.error;
    setAuthMsg('');
  } catch (e) {
    setAuthMsg(e.message || 'Login failed. Check credentials.');
  } finally {
    setBtnLoading('btn-login-pass', false);
  }
}

// ── Login via OTP ─────────────────────────────────────────────────────────────

async function sendLoginOTP() {
  var emailEl = document.getElementById('login-otp-email');
  var email = emailEl ? emailEl.value.trim() : '';
  if (!email) { setAuthMsg('Please enter your email.'); return; }
  if (!_sb) { setAuthMsg('Supabase not connected.'); return; }

  _authEmail = email;
  _otpContext = 'login-otp';

  setAuthMsg('Sending OTP...', false);
  setBtnLoading('btn-send-login-otp', true);
  try {
    var result = await _sb.auth.signInWithOtp({ email: email });
    if (result.error) throw result.error;
    showAuthStep('otp-verify');
    startResendTimer();
    setAuthMsg('OTP sent! Check your inbox.', false, true);
  } catch (e) {
    setAuthMsg(e.message || 'Error sending OTP.');
  } finally {
    setBtnLoading('btn-send-login-otp', false);
  }
}

// ── Signup OTP ────────────────────────────────────────────────────────────────

async function sendSignupOTP() {
  var emailEl = document.getElementById('signup-email');
  var email = emailEl ? emailEl.value.trim() : '';
  if (!email) { setAuthMsg('Please enter your email.'); return; }
  if (!_sb) { setAuthMsg('Supabase not connected.'); return; }

  _authEmail = email;
  _otpContext = 'signup';

  setAuthMsg('Sending OTP...', false);
  setBtnLoading('btn-send-signup-otp', true);
  try {
    var result = await _sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } });
    if (result.error) throw result.error;
    showAuthStep('otp-verify');
    startResendTimer();
    setAuthMsg('OTP sent! Check your inbox.', false, true);
  } catch (e) {
    setAuthMsg(e.message || 'Error sending OTP.');
  } finally {
    setBtnLoading('btn-send-signup-otp', false);
  }
}

// ── OTP Verify ────────────────────────────────────────────────────────────────

async function verifyOTP() {
  var token = getOTPValue();
  if (!token || token.length < 6) { setAuthMsg('Please enter the complete OTP.'); return; }
  if (!_authEmail) { setAuthMsg('Email missing. Please go back.'); return; }
  if (!_sb) { setAuthMsg('Supabase not connected.'); return; }

  setAuthMsg('Verifying...', false);
  setBtnLoading('btn-verify-otp', true);
  try {
    var result = await _sb.auth.verifyOtp({ email: _authEmail, token: token, type: 'email' });
    if (result.error) throw result.error;
    stopResendTimer();
    setAuthMsg('');
  } catch (e) {
    setAuthMsg(e.message || 'Invalid OTP. Please try again.');
    shakeOTPBoxes();
  } finally {
    setBtnLoading('btn-verify-otp', false);
  }
}

async function resendOTP() {
  if (!_authEmail || !_sb) return;
  try {
    if (_otpContext === 'signup') {
      await _sb.auth.signInWithOtp({ email: _authEmail, options: { shouldCreateUser: true } });
    } else {
      await _sb.auth.signInWithOtp({ email: _authEmail });
    }
    clearOTPBoxes();
    startResendTimer();
    setAuthMsg('OTP resent! Check your inbox.', false, true);
  } catch (e) {
    setAuthMsg(e.message || 'Failed to resend OTP.');
  }
}

// ── Profile Setup ─────────────────────────────────────────────────────────────

async function saveProfile() {
  var name = document.getElementById('setup-name') ? document.getElementById('setup-name').value.trim() : '';
  var gender = document.getElementById('setup-gender') ? document.getElementById('setup-gender').value : '';
  var age = document.getElementById('setup-age') ? document.getElementById('setup-age').value.trim() : '';
  var pass = document.getElementById('setup-password') ? document.getElementById('setup-password').value : '';
  var passConfirm = document.getElementById('setup-password-confirm') ? document.getElementById('setup-password-confirm').value : '';

  if (!name) { setAuthMsg('Please enter your name.'); return; }
  if (!gender) { setAuthMsg('Please select your gender.'); return; }
  if (!age || parseInt(age) < 13) { setAuthMsg('Please enter a valid age (13+).'); return; }
  if (!pass || pass.length < 6) { setAuthMsg('Password must be at least 6 characters.'); return; }
  if (pass !== passConfirm) { setAuthMsg('Passwords do not match.'); return; }
  if (!_sb) { setAuthMsg('Supabase not connected.'); return; }

  setAuthMsg('Saving profile...', false);
  setBtnLoading('btn-save-profile', true);

  try {
    var result = await _sb.auth.updateUser({
      password: pass,
      data: { name: name, gender: gender, age: age }
    });
    if (result.error) throw result.error;

    var savedUser = result.data && result.data.user;
    if (savedUser) {
      setUser(savedUser);
      updateProfileUI();

      var row = { id: savedUser.id, name: name, gender: gender, age: age };
      console.log('[PROFILE] Upserting users table →', JSON.stringify(row));
      try {
        var upsertResult = await _sb.from('users').upsert(row, { onConflict: 'id' });
        if (upsertResult.error) {
          console.log('[PROFILE] users upsert error:', upsertResult.error.message);
        } else {
          console.log('[PROFILE] users upsert success ✓');
        }
      } catch (dbErr) {
        console.log('[PROFILE] users upsert exception:', dbErr.message);
      }
    }

    showPage('home');
    showToast('Welcome to Emperor FM, ' + name + '!');
    setAuthMsg('');
  } catch (e) {
    setAuthMsg(e.message || 'Failed to save profile.');
  } finally {
    setBtnLoading('btn-save-profile', false);
  }
}

// ── OTP Box UI ────────────────────────────────────────────────────────────────

function renderOTPBoxes() {
  var container = document.getElementById('otp-boxes');
  if (!container) return;
  container.innerHTML = '';
  for (var i = 0; i < 8; i++) {
    var input = document.createElement('input');
    input.type = 'tel';
    input.maxLength = 1;
    input.className = 'otp-box';
    input.dataset.index = i;
    input.setAttribute('autocomplete', 'one-time-code');
    input.addEventListener('input', onOTPInput);
    input.addEventListener('keydown', onOTPKeydown);
    input.addEventListener('paste', onOTPPaste);
    container.appendChild(input);
  }
}

function onOTPInput(e) {
  var input = e.target;
  var val = input.value.replace(/\D/g, '');
  input.value = val.slice(-1);
  var idx = parseInt(input.dataset.index);
  if (val && idx < 7) {
    var next = document.querySelector('.otp-box[data-index="' + (idx + 1) + '"]');
    if (next) next.focus();
  }
  input.classList.toggle('filled', !!input.value);
}

function onOTPKeydown(e) {
  var input = e.target;
  var idx = parseInt(input.dataset.index);
  if (e.key === 'Backspace' && !input.value && idx > 0) {
    var prev = document.querySelector('.otp-box[data-index="' + (idx - 1) + '"]');
    if (prev) { prev.value = ''; prev.classList.remove('filled'); prev.focus(); }
  }
}

function onOTPPaste(e) {
  e.preventDefault();
  var text = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 8);
  var boxes = document.querySelectorAll('.otp-box');
  for (var i = 0; i < boxes.length; i++) {
    boxes[i].value = text[i] || '';
    boxes[i].classList.toggle('filled', !!boxes[i].value);
  }
  var focusIdx = Math.min(text.length, 7);
  var focusBox = document.querySelector('.otp-box[data-index="' + focusIdx + '"]');
  if (focusBox) focusBox.focus();
}

function getOTPValue() {
  var boxes = document.querySelectorAll('.otp-box');
  var val = '';
  boxes.forEach(function(b) { val += b.value; });
  return val;
}

function clearOTPBoxes() {
  var boxes = document.querySelectorAll('.otp-box');
  boxes.forEach(function(b) { b.value = ''; b.classList.remove('filled', 'error'); });
}

function shakeOTPBoxes() {
  var container = document.getElementById('otp-boxes');
  if (!container) return;
  container.classList.add('shake');
  var boxes = document.querySelectorAll('.otp-box');
  boxes.forEach(function(b) { b.classList.add('error'); });
  setTimeout(function() {
    container.classList.remove('shake');
    clearOTPBoxes();
    var first = document.querySelector('.otp-box[data-index="0"]');
    if (first) first.focus();
  }, 600);
}

// ── Resend Timer ──────────────────────────────────────────────────────────────

function startResendTimer() {
  stopResendTimer();
  _resendSeconds = 180;
  updateResendBtn();
  _resendTimer = setInterval(function() {
    _resendSeconds--;
    updateResendBtn();
    if (_resendSeconds <= 0) stopResendTimer();
  }, 1000);
}

function stopResendTimer() {
  if (_resendTimer) { clearInterval(_resendTimer); _resendTimer = null; }
  _resendSeconds = 0;
  var btn = document.getElementById('resend-btn');
  var txt = document.getElementById('resend-text');
  if (btn) btn.disabled = false;
  if (txt) txt.textContent = 'Resend OTP';
}

function updateResendBtn() {
  var btn = document.getElementById('resend-btn');
  var txt = document.getElementById('resend-text');
  if (!btn || !txt) return;
  if (_resendSeconds > 0) {
    btn.disabled = true;
    var m = Math.floor(_resendSeconds / 60);
    var s = _resendSeconds % 60;
    txt.textContent = 'Resend OTP (' + m + ':' + (s < 10 ? '0' : '') + s + ')';
  } else {
    btn.disabled = false;
    txt.textContent = 'Resend OTP';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setAuthMsg(msg, isError, isSuccess) {
  var el = document.getElementById('auth-msg');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isSuccess ? 'var(--primary)' : (isError === false ? 'var(--text-light)' : 'var(--accent)');
}

function setBtnLoading(id, loading) {
  var btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.dataset.origText = btn.textContent;
    btn.textContent = 'Please wait...';
  } else {
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
  }
}

function showContactSupport() {
  window.open('mailto:support@emperorfm.app', '_blank');
}
