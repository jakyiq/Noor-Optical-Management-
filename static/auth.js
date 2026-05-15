/* auth.js - extracted from index.html. Plain script, globals intentionally preserved. */
function switchAuthPane(pane) {
  ['signin','signup','reset'].forEach(p => {
    document.getElementById(`pane-${p}`)?.classList.toggle('active', p === pane);
  });
  // Tab highlight — only signin/signup tabs exist
  ['signin','signup'].forEach(p => {
    const tab = document.getElementById(`tab-${p}`);
    if (!tab) return;
    const active = p === pane;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
  });
  // Clear all messages on switch
  ['signin-error','signup-error','signup-success','reset-error','reset-success'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.closest('.auth-message')?.classList.remove('show');
  });
}

function _authSetLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
}

function _authShowError(errTextId, msg) {
  const el = document.getElementById(errTextId);
  if (!el) return;
  el.textContent = msg;
  el.closest('.auth-message').classList.add('show');
}

function _authHideMsg(msgId) {
  document.getElementById(msgId)?.classList.remove('show');
}

function togglePwVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const isText = input.type === 'text';
  input.type = isText ? 'password' : 'text';
  const svg = btn.querySelector('svg');
  if (svg) svg.innerHTML = isText
    ? '<path d="M1 12S5 5 12 5s11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>';
}

// ── Sign In ──────────────────────────────────────────────
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  _authHideMsg('signin-error');

  if (!username || !password) {
    _authShowError('signin-error-text', t('errorRequired'));
    return;
  }

  _authSetLoading('login-btn', true);
  try {
    const data = await post('/api/login', { username, password });
    NOOR.user      = data.data;
    NOOR.role      = data.data.role;
    NOOR.clinicId  = data.data.clinic_id;
    NOOR.csrfToken = data.data.csrf_token;
    NOOR.license   = data.data.license || null;

    if (data.data.grace_warning) {
      document.getElementById('license-banner-text').textContent = data.data.grace_warning;
      document.getElementById('license-banner').classList.add('show');
    }
    scheduleSessionWarning(data.data.expires_at);
    bootApp();
    if (data.data.must_change_password) openModal('modal-change-password');
  } catch(e) {
    _authShowError('signin-error-text', e.message || t('invalidCredentials'));
  } finally {
    _authSetLoading('login-btn', false);
  }
}

// ── Sign Up ──────────────────────────────────────────────
async function doSignup() {
  const email        = document.getElementById('signup-email').value.trim();
  const password     = document.getElementById('signup-password').value;
  const clinic_name  = document.getElementById('signup-clinic').value.trim();
  const owner_name   = document.getElementById('signup-owner').value.trim();
  const phone        = document.getElementById('signup-phone').value.trim();
  _authHideMsg('signup-error');
  _authHideMsg('signup-success');

  if (!clinic_name || !owner_name || !email || password.length < 6) {
    _authShowError('signup-error-text', NOOR.lang === 'ar'
      ? 'يرجى ملء جميع الحقول المطلوبة وكلمة مرور لا تقل عن 6 أحرف'
      : 'Please fill all required fields and use a password of at least 6 characters.');
    return;
  }

  _authSetLoading('signup-btn', true);
  try {
    await post('/api/signup', { email, password, clinic_name, owner_name, phone });
    const successEl = document.getElementById('signup-success-text');
    if (successEl) successEl.textContent = NOOR.lang === 'ar'
      ? 'تم إنشاء الحساب بنجاح! تحقق من بريدك الإلكتروني إذا كان التحقق مفعّلاً، ثم سجّل الدخول.'
      : 'Account created! Check your email for verification if enabled, then sign in.';
    document.getElementById('signup-success').classList.add('show');
    // Pre-fill sign-in username for convenience
    document.getElementById('login-username').value = email;
    setTimeout(() => switchAuthPane('signin'), 2200);
  } catch(e) {
    _authShowError('signup-error-text', e.message);
  } finally {
    _authSetLoading('signup-btn', false);
  }
}

// ── Reset Password ───────────────────────────────────────
async function doResetPassword() {
  const email = document.getElementById('reset-email').value.trim();
  _authHideMsg('reset-error');
  _authHideMsg('reset-success');

  if (!email || !email.includes('@')) {
    _authShowError('reset-error-text', NOOR.lang === 'ar' ? 'أدخل بريدك الإلكتروني أولاً' : 'Enter a valid email first.');
    return;
  }

  _authSetLoading('reset-btn', true);
  try {
    await post('/api/reset-password', { email });
    const successEl = document.getElementById('reset-success-text');
    if (successEl) successEl.textContent = NOOR.lang === 'ar'
      ? 'إذا كان البريد مسجّلاً، ستصل رسالة استرداد خلال لحظات.'
      : 'If this email is registered, a reset link has been sent.';
    document.getElementById('reset-success').classList.add('show');
  } catch(e) {
    _authShowError('reset-error-text', e.message);
  } finally {
    _authSetLoading('reset-btn', false);
  }
}

// Legacy alias kept for backwards compatibility
function resetPassword() { switchAuthPane('reset'); }

async function doLogout() {
  try { await post('/api/logout'); } catch(_) {}
  NOOR.user = null; NOOR.role = null;
  NOOR.csrfToken = null;
  clearSessionTimers();
  document.getElementById('app').classList.remove('ready');
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-password').value = '';
  // Return to sign-in pane on logout
  switchAuthPane('signin');
}

function clearSessionTimers() {
  clearTimeout(NOOR.sessionWarningTimer);
  clearTimeout(NOOR.sessionExpiryTimer);
  NOOR.sessionWarningTimer = null;
  NOOR.sessionExpiryTimer = null;
  document.getElementById('session-warning')?.classList.remove('show');
}

function scheduleSessionWarning(expiresAt) {
  clearSessionTimers();
  if (!expiresAt) return;
  const expiry = new Date(expiresAt).getTime();
  if (!expiry) return;
  const warnAt = Math.max(0, expiry - Date.now() - 5 * 60 * 1000);
  const expireAt = Math.max(0, expiry - Date.now());
  NOOR.sessionWarningTimer = setTimeout(() => {
    const text = document.getElementById('session-warning-text');
    const btn = document.getElementById('session-renew-btn');
    if (text) text.textContent = NOOR.lang === 'ar' ? 'ستنتهي الجلسة قريباً.' : 'Your session will expire soon.';
    if (btn) btn.textContent = NOOR.lang === 'ar' ? 'تجديد الجلسة' : 'Renew session';
    document.getElementById('session-warning')?.classList.add('show');
  }, warnAt);
  NOOR.sessionExpiryTimer = setTimeout(() => toast(NOOR.lang === 'ar' ? 'انتهت الجلسة. يرجى تسجيل الدخول مرة أخرى.' : 'Session expired. Please sign in again.', 'warning'), expireAt);
}

async function renewSession() {
  try {
    const data = await get('/api/me');
    NOOR.csrfToken = data.data.csrf_token;
    scheduleSessionWarning(data.data.expires_at);
    toast(NOOR.lang === 'ar' ? 'تم تجديد الجلسة' : 'Session renewed');
  } catch(e) {
    if (!e.silent) toast(e.message, 'error');
  }
}

function bootApp() {
  document.getElementById('login-screen').style.display = 'none';
  const app = document.getElementById('app');
  app.style.display = 'flex';
  app.classList.add('ready');
  document.getElementById('user-name').textContent    = NOOR.user.full_name;
  document.getElementById('user-role').textContent    = NOOR.user.role === 'super_admin' ? 'Super Admin' : t(NOOR.user.role);
  document.getElementById('user-avatar').textContent  = (NOOR.user.full_name || '?')[0];
  if (NOOR.role === 'super_admin') {
    document.getElementById('nav-superadmin').style.display = '';
    document.getElementById('more-superadmin').style.display = 'flex';
  }
  applyLang();
  ensureLensCatalog().catch(()=>{});
  // Preload clinic settings so default_checkup_fee and other defaults are ready
  // immediately without requiring the user to visit the Settings tab first.
  get('/api/settings').then(s => {
    const st = s.data?.settings || {};
    NOOR.settings = Object.assign(NOOR.settings || {}, st);
    NOOR._settingsLoaded = true;
    NOOR.clinicName = s.data?.clinic?.name || NOOR.clinicName || '';
    const el = document.getElementById('sidebar-clinic-name');
    if (el && NOOR.clinicName) el.textContent = NOOR.clinicName;
  }).catch(() => {});
  navigate('dashboard');
}

// Check if already logged in (page reload)
async function checkSession() {
  try {
    const data = await get('/api/me');
    NOOR.user     = data.data;
    NOOR.role     = data.data.role;
    NOOR.clinicId = data.data.clinic_id;
    NOOR.csrfToken = data.data.csrf_token;
    NOOR.license = data.data.license || null;
    // /api/me now always returns full_name; fallback to username if somehow missing
    if (!NOOR.user.full_name) NOOR.user.full_name = NOOR.user.username || '?';
    if (data.data.grace_warning) {
      document.getElementById('license-banner-text').textContent = data.data.grace_warning;
      document.getElementById('license-banner').classList.add('show');
    }
    scheduleSessionWarning(data.data.expires_at);
    bootApp();
    if (data.data.must_change_password) openModal('modal-change-password');
  } catch(_) {
    // Not logged in — show login screen (already visible)
  }
}

// ══════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════

async function saveNewPassword() {
  const pw   = document.getElementById('new-pw').value;
  const conf = document.getElementById('new-pw-confirm').value;
  if (!pw || pw.length<6)  { toast('Min 6 characters','error'); return; }
  if (pw !== conf)         { toast('Passwords do not match','error'); return; }
  try {
    await post('/api/change-password', { password: pw });
    closeModal('modal-change-password'); toast(t('successSaved'));
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// GLOBAL SEARCH
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// SUPABASE AUTH CALLBACK HANDLER
// Runs on page load when Supabase redirects back from an
// email confirmation or password-reset link.
//
// Supabase appends either:
//   /?type=signup&token_hash=XXX          (email confirmation)
//   /#access_token=XXX&type=recovery&...  (password reset — hash fragment)
// ══════════════════════════════════════════════════════════
(async function handleAuthCallback() {
  // ── Parse both query string and hash fragment ──
  const params      = new URLSearchParams(window.location.search);
  const hashParams  = new URLSearchParams(window.location.hash.replace(/^#/, ''));

  const type        = params.get('type') || hashParams.get('type');
  const tokenHash   = params.get('token_hash');
  const accessToken = hashParams.get('access_token');
  const refreshToken= hashParams.get('refresh_token');

  if (!type) return; // Normal page load — nothing to do

  // Clean the URL immediately so tokens don't linger in browser history
  history.replaceState(null, '', '/');

  // ── Email confirmation (type=signup or type=email) ──
  if ((type === 'signup' || type === 'email') && tokenHash) {
    try {
      await post('/api/auth/confirm', { token_hash: tokenHash, type });
      // Show login pane with a success message
      switchAuthPane('signin');
      const msgEl = document.getElementById('signin-success') || document.getElementById('signup-success');
      if (msgEl) {
        msgEl.querySelector('span') && (msgEl.querySelector('span').textContent =
          NOOR.lang === 'ar'
            ? 'تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.'
            : 'Email confirmed! You can now sign in.');
        msgEl.classList.add('show');
      }
    } catch (e) {
      switchAuthPane('signin');
      _authShowError('signin-error-text',
        NOOR.lang === 'ar'
          ? 'رابط التأكيد غير صالح أو منتهي الصلاحية. يرجى إنشاء حساب مجدداً.'
          : 'Confirmation link is invalid or expired. Please sign up again.');
    }
    return;
  }

  // ── Password reset (type=recovery) ──
  if (type === 'recovery' && accessToken) {
    // Show the set-new-password modal/pane pre-filled with the tokens
    _showResetPasswordModal(accessToken, refreshToken);
    return;
  }
})();

// Called when user submits the new password after clicking a reset email link
async function submitNewPasswordFromLink(accessToken, refreshToken) {
  const pw  = (document.getElementById('reset-link-pw')  || {}).value || '';
  const pw2 = (document.getElementById('reset-link-pw2') || {}).value || '';
  const errEl = document.getElementById('reset-link-error');

  if (pw.length < 8) {
    if (errEl) errEl.textContent = NOOR.lang === 'ar' ? 'كلمة المرور يجب أن تكون 8 أحرف على الأقل' : 'Password must be at least 8 characters';
    return;
  }
  if (pw !== pw2) {
    if (errEl) errEl.textContent = NOOR.lang === 'ar' ? 'كلمتا المرور غير متطابقتين' : 'Passwords do not match';
    return;
  }

  const btn = document.getElementById('reset-link-btn');
  if (btn) btn.disabled = true;
  try {
    await post('/api/auth/set-new-password', { access_token: accessToken, refresh_token: refreshToken, password: pw });
    closeModal('modal-reset-link-pw');
    switchAuthPane('signin');
    const msgEl = document.getElementById('signin-success') || document.getElementById('reset-success');
    if (msgEl) {
      const span = msgEl.querySelector('span');
      if (span) span.textContent = NOOR.lang === 'ar' ? 'تم تحديث كلمة المرور. سجّل الدخول الآن.' : 'Password updated. Sign in now.';
      msgEl.classList.add('show');
    }
  } catch (e) {
    if (errEl) errEl.textContent = e.message || (NOOR.lang === 'ar' ? 'حدث خطأ' : 'An error occurred');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _showResetPasswordModal(accessToken, refreshToken) {
  // Build a minimal modal on-the-fly if it doesn't already exist in the DOM
  let modal = document.getElementById('modal-reset-link-pw');
  if (!modal) {
    const isAr = NOOR.lang === 'ar';
    modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.id = 'modal-reset-link-pw';
    modal.innerHTML = `
      <div class="modal" style="width:min(420px,100%)">
        <div class="modal-header">
          <div class="modal-title">${isAr ? 'تعيين كلمة مرور جديدة' : 'Set New Password'}</div>
        </div>
        <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
          <div class="form-group">
            <label class="form-label">${isAr ? 'كلمة المرور الجديدة' : 'New Password'}</label>
            <input type="password" class="form-input" id="reset-link-pw" autocomplete="new-password" placeholder="${isAr ? '٨ أحرف على الأقل' : 'Minimum 8 characters'}">
          </div>
          <div class="form-group">
            <label class="form-label">${isAr ? 'تأكيد كلمة المرور' : 'Confirm Password'}</label>
            <input type="password" class="form-input" id="reset-link-pw2" autocomplete="new-password">
          </div>
          <div id="reset-link-error" style="color:var(--danger);font-size:.83rem;min-height:18px"></div>
        </div>
        <div class="modal-footer">
          <!-- Bug fix #16: handler attached via addEventListener below to avoid XSS via token interpolation in onclick -->
          <button class="btn btn-burgundy" id="reset-link-btn">
            ${isAr ? 'حفظ كلمة المرور' : 'Save Password'}
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
  }
  // Store tokens in a closure — never interpolate untrusted values into HTML/attribute strings
  const btn = modal.querySelector('#reset-link-btn');
  // Remove any previously attached handler to avoid duplicate listeners on re-open
  const newBtn = btn.cloneNode(true);
  btn.parentNode.replaceChild(newBtn, btn);
  newBtn.addEventListener('click', () => submitNewPasswordFromLink(accessToken, refreshToken));

  modal.classList.add('show');
  setTimeout(() => document.getElementById('reset-link-pw')?.focus(), 100);
}
