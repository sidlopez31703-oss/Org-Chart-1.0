(() => {
  const gateId = 'org-security-gate';
  let client;
  let authRedirectUrl = '';
  let currentUser = null;
  let currentRole = null;
  let saveTimer;
  let realtimeChannel = null;
  let lastServerState = null;
  let viewerLinkActive = false;
  let viewerPollTimer = null;
  let lastActivatedSessionKey = null;
  let activationQueue = Promise.resolve();
  let accessVersion = 0;
  const callbackParams = new URLSearchParams(location.hash.slice(1));
  let callbackError = callbackParams.get('error_description');
  const failedEmailCallback = Boolean(callbackError);
  let passwordSetupRequired = ['invite', 'recovery'].includes(callbackParams.get('type'));
  try { passwordSetupRequired ||= sessionStorage.getItem('org-password-setup') === 'pending'; } catch {}
  let suppressStorageSync = false;
  let photoMigrationActive = false;
  let photoRefreshTimer;
  let refreshPhotoStorageStatus = null;
  const dataKeys = new Set([
    'org-chart-people',
    'org-chart-departments',
    'org-chart-groups',
    'org-chart-department-levels',
    'org-chart-levels',
    'org-chart-category-keys',
    'org-chart-site-settings',
    'org-chart-pending-import',
  ]);
  // Supabase is the saved source of shared data. Keep its potentially large
  // photo-bearing records in memory, not localStorage's small string quota.
  // The legacy editor still calls Storage methods; these wrappers preserve that
  // interface while leaving authentication keys and sessionStorage untouched.
  const directoryKeys = new Set([...dataKeys].filter(key => key !== 'org-chart-pending-import'));
  const directoryCache = new Map();
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const originalGetItem = localStorage.getItem.bind(localStorage);
  const originalRemoveItem = localStorage.removeItem.bind(localStorage);
  for (const key of directoryKeys) {
    const value = originalGetItem(key);
    if (value !== null) directoryCache.set(key, value);
  }

  localStorage.getItem = function(key) {
    key = String(key);
    return directoryKeys.has(key) ? directoryCache.get(key) ?? null : originalGetItem(key);
  };
  localStorage.removeItem = function(key) {
    key = String(key);
    directoryCache.delete(key);
    originalRemoveItem(key);
  };


  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
  }

  function showGate(title, message, formMarkup = '') {
    let gate = document.getElementById(gateId);
    if (!gate) {
      gate = document.createElement('main');
      gate.id = gateId;
      document.body.prepend(gate);
    }
    gate.innerHTML = `<section class="security-card"><div class="security-mark">CC</div><span class="security-eyebrow">Clark County · Organization directory</span><h1>${escapeHtml(title)}</h1><p id="security-message">${escapeHtml(message)}</p>${formMarkup}<div id="security-feedback" role="status"></div></section>`;
    document.body.classList.add('org-security-locked');
    document.body.style.visibility = 'visible';
    document.documentElement.style.visibility = 'visible';
  }

  document.head.insertAdjacentHTML('beforeend', '<style>body.org-security-locked>:not(#org-security-gate){display:none!important}#org-security-gate{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:22px;background:#eef3f5;font-family:Arial,Helvetica,sans-serif;color:#14374b}.security-card{width:min(100%,460px);padding:34px;background:#fff;border:1px solid #cad7dd;box-shadow:0 18px 55px #003b5c20}.security-mark{width:42px;height:42px;display:grid;place-items:center;margin-bottom:24px;background:#003b5c;color:#fff;font-size:14px;font-weight:700}.security-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.13em;color:#0072a8}.security-card h1{font-family:Arial,Helvetica,sans-serif;font-size:27px;letter-spacing:0;margin:10px 0}.security-card p{font-size:14px;line-height:1.5;color:#52636b}.security-card label{display:block;font-weight:700;font-size:12px;margin:18px 0}.security-card input,.security-card select{display:block;width:100%;padding:12px;margin-top:7px;border:1px solid #aebfc8;background:#fff;color:#000;font:inherit}.security-card button{border:1px solid #003b5c;background:#003b5c;color:#fff;padding:12px 15px;font-weight:700;cursor:pointer}.security-card button.secondary-action{background:#fff;color:#003b5c}.security-card .security-actions{display:flex;gap:8px;flex-wrap:wrap}.security-card #security-feedback{margin-top:14px;font-size:12px;color:#003b5c}.org-session-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:12px;padding:8px 6%;background:#eaf2f5;color:#14374b;font-size:11px}.org-session-toolbar button{border:1px solid #b9cbd4;background:white;padding:6px 10px;color:#003b5c;font-size:11px}.share-list{display:grid;gap:8px;margin-top:18px}.share-member{display:grid;grid-template-columns:minmax(0,1fr) 115px auto auto;gap:8px;align-items:center;padding:10px;background:#f2f6f8;border:1px solid #cfdae0;font-size:12px}.share-member select{margin:0}.share-member button{padding:8px;font-size:11px}.share-member button.remove-share{color:#963d3d;border-color:#d2b5b5;background:white}@media(max-width:520px){.security-card{padding:25px}.share-member{grid-template-columns:1fr 95px}.share-member button{grid-row:2}}</style>');

  document.head.insertAdjacentHTML('beforeend', '<style>.share-member input{min-width:0;width:100%;padding:8px;border:1px solid #b9cbd4;background:#fff;color:#000}.link-tools{display:flex;gap:8px;flex-wrap:wrap}.link-result{display:flex;gap:8px;align-items:center;margin-top:10px}.link-result input{min-width:0;flex:1;padding:8px;border:1px solid #b9cbd4}.link-warning{font-size:11px;color:#52636b;margin-top:8px}</style>');
  window.orgAuthRole = null;
  window.requireAdmin = (callback) => {
    if (photoMigrationActive) { alert('Please wait for the photo move to finish.'); return; }
    if (currentRole === 'admin') callback();
    else alert('This action is available to directory administrators only.');
  };

  localStorage.setItem = function(key, value) {
    key = String(key);
    if (directoryKeys.has(key)) directoryCache.set(key, String(value));
    else originalSetItem(key, value);
    if (!suppressStorageSync && currentRole === 'admin' && dataKeys.has(key)) scheduleSave();
  };

  const passwordHelp = 'Sign in with your administrator email and website password. You do not need an email link to sign in.';
  const eyeIcon = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const hiddenEyeIcon = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m3 3 18 18M9.8 5.2A12 12 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 3.9M6.1 6.1A21 21 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.9-1.6M10 10a3 3 0 0 0 4 4"/></svg>';

  function enablePasswordVisibility() {
    document.querySelectorAll('#' + gateId + ' input[type="password"]').forEach((input, index) => {
      if (input.closest('.password-field')) return;
      input.id ||= 'org-visible-password-' + index;
      const field = document.createElement('span');
      field.className = 'password-field';
      input.replaceWith(field);
      field.appendChild(input);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'password-toggle';
      button.setAttribute('aria-controls', input.id);
      button.setAttribute('aria-label', 'Show password');
      button.setAttribute('aria-pressed', 'false');
      button.title = 'Show password';
      button.innerHTML = eyeIcon;
      button.addEventListener('click', () => {
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        const label = visible ? 'Hide password' : 'Show password';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(visible));
        button.title = label;
        button.innerHTML = visible ? hiddenEyeIcon : eyeIcon;
      });
      field.appendChild(button);
    });
  }

  function clearEmailLinkError() {
    if (!callbackError) return;
    callbackError = null;
    const fragment = new URLSearchParams(location.hash.slice(1));
    for (const key of ['error', 'error_code', 'error_description']) fragment.delete(key);
    const remaining = fragment.toString();
    history.replaceState(null, '', location.pathname + location.search + (remaining ? '#' + remaining : ''));
  }

  document.head.insertAdjacentHTML('beforeend', '<style>.security-card{max-height:calc(100dvh - 44px);overflow-y:auto}.security-card .password-field{display:block;position:relative;margin-top:7px}.security-card .password-field input{margin-top:0;padding-right:52px}.security-card .password-toggle{position:absolute;right:1px;top:1px;bottom:1px;width:44px;padding:0;display:grid;place-items:center;border:0;background:transparent;color:#003b5c}.security-card .password-toggle:focus-visible{outline:2px solid #0072a8;outline-offset:-4px}.security-card .password-toggle:hover{background:#eaf2f5}.security-card #security-feedback:empty{display:none}</style>');

  function showLogin(message = passwordHelp) {
    showGate('Administrator sign-in', message, '<form id="org-login-form"><label>Email address<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form><div class="security-actions"><button type="button" class="secondary-action" id="org-forgot-password">Set or reset password</button><button type="button" class="secondary-action" id="org-return-viewer">Back to directory</button></div>');
    enablePasswordVisibility();
    const loginForm = document.getElementById('org-login-form');
    loginForm.addEventListener('input', () => {
      clearEmailLinkError();
      document.getElementById('security-message').textContent = passwordHelp;
      document.getElementById('security-feedback').textContent = '';
    });
    loginForm.addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const feedback = document.getElementById('security-feedback');
      const button = form.querySelector('button[type="submit"]');
      clearEmailLinkError();
      document.getElementById('security-message').textContent = passwordHelp;
      feedback.textContent = 'Checking your email and password…';
      button.disabled = true;
      try {
        const { data, error } = await client.auth.signInWithPassword({ email: String(values.get('email')).trim().toLowerCase(), password: String(values.get('password')) });
        if (error) throw error;
        form.reset();
        await queueSessionActivation(data.session);
      } catch (error) {
        feedback.textContent = error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message || '')
          ? 'Email or password not recognized. Check your administrator email and website password. You can use the eye button to check what you typed, or select Set or reset password.'
          : (error.message || 'Could not sign in. Check your connection and try again.');
      }
      finally { button.disabled = false; }
    });
    document.getElementById('org-forgot-password').addEventListener('click', showPasswordRecovery);
    document.getElementById('org-return-viewer').addEventListener('click', () => {
      activateViewerLink().catch(error => showLogin(error.message));
    });
  }

  function queueSessionActivation(session) {
    const sessionKey = session?.access_token || 'signed-out';
    if (sessionKey === lastActivatedSessionKey) return activationQueue;
    lastActivatedSessionKey = sessionKey;
    activationQueue = activationQueue.then(() => activateSession(session)).catch((error) => {
      lastActivatedSessionKey = null;
      showLogin(`Could not complete sign-in: ${error.message || 'Unknown authentication error.'}`);
    });
    return activationQueue;
  }

  const recoverySendAfter = new Map();
  let recoverySending = false;

  function recoveryError(error) {
    if (error.status === 429 || /rate.?limit|too many/i.test(error.message || '')) {
      return 'Supabase has temporarily limited requests. This attempt did not complete. Stop requesting codes and wait before trying again. Email sending limits still apply.';
    }
    return error.message || 'Could not complete the request. Check your connection and try again.';
  }

  async function sendRecoveryCode(email) {
    if (recoverySending) throw new Error('A code request is already in progress.');
    if (Date.now() < (recoverySendAfter.get(email) || 0)) throw new Error('Wait at least 60 seconds between code requests. Use the newest email you already received.');
    recoverySending = true;
    try {
      const {error} = await client.auth.resetPasswordForEmail(email, {redirectTo: authRedirectUrl});
      if (error) throw error;
      recoverySendAfter.set(email, Date.now() + 60000);
    } catch (error) {
      if (error.status === 429 || /rate.?limit|too many/i.test(error.message || '')) recoverySendAfter.set(email, Date.now() + 60000);
      throw error;
    } finally { recoverySending = false; }
  }

  function showPasswordRecovery(prefillEmail = '') {
    // Click listeners receive an Event, not an email string.
    const email = typeof prefillEmail === 'string' ? prefillEmail : '';
    showGate('Set or reset password', 'Request a verification code for your existing invited account. Enter the code here, then choose a new password. You do not need to click a reset link in your email.', '<form id="org-recovery-form"><label>Invited email address<input name="email" type="email" autocomplete="username" required value="' + escapeHtml(email) + '"></label><button type="submit">Email verification code</button><button type="button" class="secondary-action" id="org-have-code">I already have a code</button></form><button type="button" class="secondary-action" id="org-back-login">Back to sign-in</button>');
    document.getElementById('org-back-login').addEventListener('click', () => showLogin());
    const form = document.getElementById('org-recovery-form');
    document.getElementById('org-have-code').addEventListener('click', () => {
      if (form.reportValidity()) showRecoveryCode(String(new FormData(form).get('email')).trim().toLowerCase());
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const email = String(new FormData(form).get('email')).trim().toLowerCase();
      const button = form.querySelector('button[type="submit"]');
      const feedback = document.getElementById('security-feedback');
      feedback.textContent = 'Requesting a verification code…';
      button.disabled = true;
      try {
        await sendRecoveryCode(email);
        if (form.isConnected) showRecoveryCode(email, 'If this address is eligible, a code will arrive by email. Use only the newest code.');
      } catch (error) { feedback.textContent = 'Could not send the password code: ' + recoveryError(error); }
      finally { button.disabled = false; }
    });
  }

  function showRecoveryCode(email, message = 'Enter the verification code from your newest password email. Keep this page open while checking Outlook.') {
    showGate('Enter your verification code', message, '<form id="org-code-form"><label>Email address<input name="email" type="email" autocomplete="username" readonly value="' + escapeHtml(email) + '"></label><label>Verification code<input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,20}" maxlength="20" required aria-describedby="org-code-help"></label><p id="org-code-help">Enter every digit shown in the email, including any zeros at the beginning. If the email only contains a reset button, the website administrator needs to update the Supabase Reset password email template.</p><button type="submit">Verify code</button></form><div class="security-actions"><button type="button" class="secondary-action" id="org-resend-code">Request another code</button><button type="button" class="secondary-action" id="org-change-recovery-email">Change email</button><button type="button" class="secondary-action" id="org-code-back-login">Back to sign-in</button></div>');
    document.getElementById('org-change-recovery-email').addEventListener('click', () => showPasswordRecovery(email));
    document.getElementById('org-code-back-login').addEventListener('click', () => showLogin());
    const form = document.getElementById('org-code-form');
    const resend = document.getElementById('org-resend-code');
    let verifying = false;
    function updateResend() {
      const seconds = Math.max(0, Math.ceil(((recoverySendAfter.get(email) || 0) - Date.now()) / 1000));
      resend.disabled = verifying || recoverySending || seconds > 0;
      resend.textContent = seconds ? 'Request another code (' + seconds + 's)' : 'Request another code';
    }
    updateResend();
    const countdown = setInterval(() => {
      if (!form.isConnected) { clearInterval(countdown); return; }
      updateResend();
    }, 1000);
    resend.addEventListener('click', async () => {
      resend.disabled = true;
      const feedback = document.getElementById('security-feedback');
      try {
        await sendRecoveryCode(email);
        feedback.textContent = 'If the address is eligible, another code will arrive. Use only the newest code.';
      } catch (error) { feedback.textContent = 'Could not send another code: ' + recoveryError(error); }
      finally { if (form.isConnected) updateResend(); }
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (verifying) return;
      const token = String(new FormData(form).get('code')).replace(/\s/g, '');
      const feedback = document.getElementById('security-feedback');
      if (!/^[0-9]{6,10}$/.test(token)) { feedback.textContent = 'Enter the complete numeric code from the email.'; return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      verifying = true;
      updateResend();
      feedback.textContent = 'Verifying your code…';
      const previousSetupRequired = passwordSetupRequired;
      passwordSetupRequired = true;
      try {
        // Only Supabase can exchange a valid recovery code for a session.
        const {data, error} = await client.auth.verifyOtp({email, token, type: 'recovery'});
        if (error) throw error;
        if (!data?.session?.user) throw new Error('Verification did not create a session. Please try a new code.');
        form.reset();
        lastActivatedSessionKey = null;
        await queueSessionActivation(data.session);
      } catch (error) {
        passwordSetupRequired = previousSetupRequired;
        feedback.textContent = error.code === 'otp_expired' || /expired|invalid.*token|token.*invalid/i.test(error.message || '')
          ? 'That code is invalid, expired, or already used. Check the newest email and the address above. Request a new code when the wait ends if needed.'
          : recoveryError(error);
      } finally { verifying = false; button.disabled = false; if (form.isConnected) updateResend(); }
    });
  }

  function showPasswordSetup() {
    try { sessionStorage.setItem('org-password-setup', 'pending'); } catch {}
    showGate('Choose your password', 'Set a password for your verified account. Use at least 12 characters and a password you do not use elsewhere.', '<form id="org-password-form"><label>New password<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="12" required></label><button type="submit">Save password</button></form><button type="button" class="secondary-action" id="org-cancel-password">Cancel and sign out</button>');
    enablePasswordVisibility();
    document.getElementById('org-cancel-password').addEventListener('click', async () => {
      const {error} = await client.auth.signOut();
      if (error) { document.getElementById('security-feedback').textContent = error.message; return; }
      passwordSetupRequired = false;
      try { sessionStorage.removeItem('org-password-setup'); } catch {}
      await queueSessionActivation(null);
    });
    document.getElementById('org-password-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = new FormData(form);
      const feedback = document.getElementById('security-feedback');
      const password = String(values.get('password'));
      if (password.length < 12 || password !== values.get('confirm')) { feedback.textContent = 'Enter matching passwords of at least 12 characters.'; return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const {error} = await client.auth.updateUser({password});
        if (error) throw error;
        passwordSetupRequired = false;
        try { sessionStorage.removeItem('org-password-setup'); } catch {}
        history.replaceState(null, '', location.pathname + location.search);
        form.reset();
        const {data, error: sessionError} = await client.auth.getSession();
        if (sessionError) throw sessionError;
        lastActivatedSessionKey = null;
        await queueSessionActivation(data.session);
      } catch (error) { feedback.textContent = error.message || 'Could not save the password.'; }
      finally { button.disabled = false; }
    });
  }

  function readLocalState() {
    try {
      const pendingImport = JSON.parse(localStorage.getItem('org-chart-pending-import') || 'null');
      if (pendingImport && Array.isArray(pendingImport.departments) && Array.isArray(pendingImport.people)) return pendingImport;
    } catch {
      localStorage.removeItem('org-chart-pending-import');
    }
    const read = (key, fallback) => {
      try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : JSON.parse(value);
      } catch {
        return fallback;
      }
    };
    return {
      departments: read('org-chart-departments', window.depts),
      groups: read('org-chart-groups', window.orgGroups || []),
      people: read('org-chart-people', window.people),
      departmentLevels: read('org-chart-department-levels', window.departmentLevels || {}),
      levelLabels: read('org-chart-levels', window.levelLabels || []),
      categoryKeys: read('org-chart-category-keys', window.categoryKeys || []),
      siteSettings: read('org-chart-site-settings', window.siteSettings || {}),
    };
  }

  function clearLocalDirectory() {
    window.OrgPhotos.clear();
    clearInterval(photoRefreshTimer);
    window.people = [];
    window.depts.splice(0, window.depts.length);
    window.orgGroups = [];
    window.departmentLevels = {};
    window.levelLabels = [];
    window.categoryKeys = [];
    for (const key of dataKeys) localStorage.removeItem(key);
  }

  function writeLocalState(state) {
    suppressStorageSync = true;
    try {
      localStorage.setItem('org-chart-departments', JSON.stringify(state.departments));
      localStorage.setItem('org-chart-groups', JSON.stringify(state.groups || []));
      localStorage.setItem('org-chart-people', JSON.stringify(state.people));
      localStorage.setItem('org-chart-department-levels', JSON.stringify(state.departmentLevels));
      localStorage.setItem('org-chart-levels', JSON.stringify(state.levelLabels));
      localStorage.setItem('org-chart-category-keys', JSON.stringify(state.categoryKeys));
      localStorage.setItem('org-chart-site-settings', JSON.stringify(state.siteSettings));
      // Only after a validated shared state is loaded, discard stale disk copies
      // to free space for auth/session tokens. The data above stays in memory
      // and in Supabase; pending migration imports are preserved separately.
      for (const key of directoryKeys) originalRemoveItem(key);
    } finally {
      suppressStorageSync = false;
    }
  }

  function applySharedState(state) {
    if (!state || !Array.isArray(state.departments) || !Array.isArray(state.people)) {
      throw new Error('The shared directory has not been initialized by an administrator yet.');
    }
    window.depts.splice(0, window.depts.length, ...state.departments);
    window.orgGroups = state.groups || [];
    window.people = state.people;
    window.departmentLevels = state.departmentLevels || {};
    window.levelLabels = state.levelLabels || [];
    window.categoryKeys = state.categoryKeys || [];
    window.siteSettings = state.siteSettings || window.siteSettings;
    writeLocalState({
      departments: window.depts,
      groups: window.orgGroups,
      people: window.people,
      departmentLevels: window.departmentLevels,
      levelLabels: window.levelLabels,
      categoryKeys: window.categoryKeys,
      siteSettings: window.siteSettings,
    });
    window.applySiteSettings?.();
    window.render?.();
    refreshPhotoStorageStatus?.();
  }

  function collectState() {
    return {
      departments: window.depts,
      groups: window.orgGroups || [],
      people: window.people,
      departmentLevels: window.departmentLevels || {},
      levelLabels: window.levelLabels || [],
      categoryKeys: window.categoryKeys || [],
      siteSettings: window.siteSettings || {},
    };
  }

  // PostgreSQL JSONB may return object keys in a different order.
  // Compare data values consistently while preserving array/reporting order.
  function stateFingerprint(state) {
    const normalized = {
      departments: state.departments || [], people: state.people || [],
      groups: state.groups || [], departmentLevels: state.departmentLevels || {},
      levelLabels: state.levelLabels || [], categoryKeys: state.categoryKeys || [],
      siteSettings: state.siteSettings || {},
    };
    return JSON.stringify(normalized, (_key, value) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
      }
      return value;
    });
  }

  function setSaveStatus(message, isError = false) {
    const status = document.getElementById('org-save-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#963d3d' : '#003b5c';
  }

  function scheduleSave() {
    if (photoMigrationActive) return;
    setSaveStatus('Saving shared changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (currentRole !== 'admin' || !currentUser) return;
      const state = structuredClone(collectState());
      const { error } = await client.from('org_state').update({
        state,
        updated_at: new Date().toISOString(),
        updated_by: currentUser.id,
      }).eq('id', 1);
      if (error) {
        setSaveStatus('Could not save shared changes. Check your connection.', true);
      } else {
        lastServerState = stateFingerprint(state);
        setSaveStatus('All changes saved for everyone.');
      }
    }, 450);
  }

  function watchSharedChanges() {
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = client.channel('org-directory-state')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'org_state', filter: 'id=eq.1' }, async (payload) => {
        const incoming = payload.new?.state;
        if (!incoming || photoMigrationActive) return;
        const localIsSaved = stateFingerprint(collectState()) === lastServerState;
        if (currentRole === 'viewer' || localIsSaved) {
          try { await window.OrgPhotos.ensure(incoming); }
          catch { setSaveStatus('A shared update arrived, but its photos could not load. Reload to retry.', true); return; }
          if (photoMigrationActive) return;
          applySharedState(incoming);
          lastServerState = stateFingerprint(collectState());
        } else {
          setSaveStatus('A shared update arrived. Save your changes, then reload to see it.');
        }
      })
      .subscribe();
  }

  function setRoleControls() {
    document.getElementById(gateId)?.remove();
    document.body.classList.remove('org-security-locked');
    document.documentElement.style.visibility = 'visible';
    document.body.style.visibility = 'visible';
    document.querySelector('.org-session-toolbar')?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'org-session-toolbar';
    const admin = currentRole === 'admin';
    toolbar.innerHTML = '<span>' + (admin ? escapeHtml(currentUser?.email) + ' · Administrator' : 'Viewer') + '</span><span id="org-save-status">Shared directory</span><button id="org-sign-out" type="button">' + (admin ? 'Sign out' : 'Administrator sign-in') + '</button>';
    document.querySelector('.top')?.insertAdjacentElement('afterend', toolbar);
    document.getElementById('org-sign-out').addEventListener('click', async () => {
      if (!admin) { showLogin(); return; }
      if (photoMigrationActive || stateFingerprint(collectState()) !== lastServerState) {
        alert('Wait for all changes to save before signing out.'); return;
      }
      const {error} = await client.auth.signOut();
      if (error) { alert('Could not sign out: ' + error.message); return; }
      window.closeAdd?.();
      await queueSessionActivation(null);
    });
    if (admin) {
      const passwordButton = document.createElement('button');
      passwordButton.type = 'button';
      passwordButton.textContent = 'Change password';
      passwordButton.addEventListener('click', () => { passwordSetupRequired = true; showPasswordSetup(); });
      toolbar.appendChild(passwordButton);
    }

    const footerActions = document.querySelector('.editor-footer>div');
    const websiteButton = footerActions?.querySelector('button[onclick*="showAdmin"]');
    const globalPositionButton = footerActions?.querySelector('button[onclick*="showPositionAdmin"]');
    if (websiteButton) websiteButton.hidden = currentRole !== 'admin';
    if (globalPositionButton) globalPositionButton.hidden = true;

    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'secondary';
    shareButton.id = 'org-share-access';
    shareButton.textContent = 'Sharing & admins';
    shareButton.hidden = currentRole !== 'admin';
    shareButton.addEventListener('click', showSharingPanel);
    document.getElementById('org-share-access')?.remove();
    footerActions?.appendChild(shareButton);
    const photosButton = document.createElement('button');
    photosButton.type = 'button';
    photosButton.className = 'secondary';
    photosButton.id = 'org-manage-photos';
    photosButton.textContent = 'Photo storage';
    photosButton.hidden = currentRole !== 'admin';
    photosButton.addEventListener('click', showPhotoStoragePanel);
    document.getElementById('org-manage-photos')?.remove();
    footerActions?.appendChild(photosButton);
    updateRoleSensitiveControls();
  }

  function updateRoleSensitiveControls() {
    const admin = currentRole === 'admin';
    document.querySelectorAll('.department-manage-button,.details-actions .text-button,.details-actions .delete').forEach((button) => { button.hidden = !admin; });
    document.querySelectorAll('.print-chart-button').forEach((button) => { button.hidden = false; });
  }

  const originalRender = window.render;
  window.render = function(...args) {
    const result = originalRender.apply(this, args);
    if (currentRole) updateRoleSensitiveControls();
    return result;
  };

  async function activateSession(session) {
    // Refreshing the same administrator session must not replace an in-progress edit.
    if (session?.user?.id === currentUser?.id && currentRole === 'admin' && !passwordSetupRequired && !document.getElementById(gateId)) {
      currentUser = session.user;
      return;
    }
    ++accessVersion;
    viewerLinkActive = false;
    clearInterval(viewerPollTimer);
    clearInterval(photoRefreshTimer);
    clearTimeout(saveTimer);
    if (realtimeChannel) { client.removeChannel(realtimeChannel); realtimeChannel = null; }
    currentRole = null;
    window.orgAuthRole = null;
    if (!session?.user) {
      currentUser = null;
      passwordSetupRequired = false;
      try { sessionStorage.removeItem('org-password-setup'); } catch {}
      await activateViewerLink();
      return;
    }
    currentUser = session.user;
    const { data: member, error: memberError } = await client.from('org_members')
      .select('role,email').eq('user_id', currentUser.id).maybeSingle();
    if (memberError || !member) {
      currentUser = null;
      currentRole = null;
      clearLocalDirectory();
      await client.auth.signOut();
      showLogin('This account has not been shared into the directory. Ask an administrator to invite this email address.');
      return;
    }
    currentRole = member.role;
    window.orgAuthRole = currentRole;
    if (passwordSetupRequired) { showPasswordSetup(); return; }
    const { data: row, error } = await client.from('org_state').select('state').eq('id', 1).single();
    if (error) {
      currentRole = null;
      window.orgAuthRole = null;
      clearLocalDirectory();
      showLogin('You are signed in, but the shared directory could not be loaded. Contact an administrator.');
      return;
    }
    let shared = row.state;
    if ((!shared || !Array.isArray(shared.departments) || !Array.isArray(shared.people)) && currentRole === 'admin') {
      window.orgAuthRole = currentRole;
      showInitialSetup();
      return;
    }
    if (!shared || !Array.isArray(shared.departments) || !Array.isArray(shared.people)) {
      currentRole = null;
      clearLocalDirectory();
      showLogin('An administrator needs to initialize the shared directory before it can be viewed.');
      return;
    }
    try {
      await window.OrgPhotos.ensure(shared);
      applySharedState(shared);
    } catch (loadError) {
      showLogin(loadError.message || 'Could not load the shared directory.');
      return;
    }
    lastServerState = stateFingerprint(collectState());
    watchSharedChanges();
    setRoleControls();
    clearInterval(photoRefreshTimer);
    photoRefreshTimer = setInterval(async () => {
      if (!currentUser || photoMigrationActive) return;
      try {
        await window.OrgPhotos.ensure(collectState());
        window.applySiteSettings?.();
        window.render?.();
      } catch { setSaveStatus('Photos could not refresh. Reload when your connection returns.', true); }
    }, 30 * 60 * 1000);
  }

  function showInitialSetup() {
    showGate('Initialize the shared directory', 'The database is empty. Import your existing JSON export, or intentionally use the directory currently stored in this browser.', '<form id="org-initialize-form"><label>Migration JSON file<input name="migrationFile" type="file" accept="application/json"></label><div class="security-actions"><button type="submit" name="choice" value="import">Import and initialize</button><button type="button" class="secondary-action" id="org-initialize-current">Initialize current directory</button></div></form>');
    const form = document.getElementById('org-initialize-form');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const file = new FormData(form).get('migrationFile');
      if (!(file instanceof File) || file.size === 0) {
        document.getElementById('security-feedback').textContent = 'Choose a migration JSON file, or use Initialize current directory.';
        return;
      }
      try {
        const state = JSON.parse(await file.text());
        if (!Array.isArray(state.departments) || !Array.isArray(state.people)) throw new Error();
        await saveInitialState(state);
      } catch (error) {
        document.getElementById('security-feedback').textContent = error.message || 'That file is not a valid org chart export.';
      }
    });
    document.getElementById('org-initialize-current').addEventListener('click', () => saveInitialState(readLocalState()));
  }

  async function saveInitialState(state) {
    document.getElementById('security-feedback').textContent = 'Saving the initial shared directory…';
    const { error } = await client.from('org_state').update({
      state,
      updated_at: new Date().toISOString(),
      updated_by: currentUser.id,
    }).eq('id', 1);
    if (error) {
      document.getElementById('security-feedback').textContent = 'Could not initialize shared storage. Check the database permissions and try again.';
      return;
    }
    localStorage.removeItem('org-chart-pending-import');
    applySharedState(state);
    lastServerState = stateFingerprint(state);
    watchSharedChanges();
    setRoleControls();
  }

  async function callSharingFunction(body) {
    const { data, error } = await client.functions.invoke('manage-sharing', { body });
    if (error) {
      let detail = data?.error;
      if (!detail && typeof error.context?.json === 'function') {
        try {
          const response = typeof error.context.clone === 'function' ? error.context.clone() : error.context;
          const payload = await response.json();
          detail = payload?.error || payload?.message || payload?.msg;
        } catch { /* Non-JSON gateway failures retain their original error. */ }
      }
      if (typeof detail !== 'string' || !detail.trim()) detail = error.message || 'Request failed.';
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function refreshShareList() {
    const target = document.getElementById('org-share-members');
    if (!target) return;
    target.innerHTML = '<p>Loading people with access…</p>';
    try {
      const result = await callSharingFunction({ action: 'list' });
      target.innerHTML = (result.members || []).map((member) => `<div class="share-member"><input type="email" aria-label="Email for ${escapeHtml(member.email)}" value="${escapeHtml(member.email)}"><select aria-label="Role for ${escapeHtml(member.email)}"><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Administrator</option></select><button type="button" data-share-action="update-member" data-email="${escapeHtml(member.email)}">Save</button><button type="button" class="remove-share" data-share-action="remove" data-email="${escapeHtml(member.email)}">Revoke</button></div>`).join('') || '<p>No named accounts have access yet. People with the viewer link can view without email accounts.</p>';
      target.querySelectorAll('button[data-share-action]').forEach((button) => button.addEventListener('click', async () => {
        try {
          const action = button.dataset.shareAction;
          if (action === 'update-member') {
            const row = button.closest('.share-member');
            const newEmail = row.querySelector('input[type="email"]').value.trim();
            const role = row.querySelector('select').value;
            await callSharingFunction({ action, email: button.dataset.email, newEmail, role });
          } else {
            if (!confirm(`Revoke directory access for ${button.dataset.email}?`)) return;
            await callSharingFunction({ action, email: button.dataset.email });
          }
          await refreshShareList();
        } catch (error) { alert(error.message); }
      }));
    } catch (error) {
      target.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    }
  }

  function showPermanentViewerLink(result) {
    const target = document.getElementById('org-view-link-result');
    if (!result.url) {
      throw new Error('The sharing service needs the latest update. Apply generate-permanent-view-link.sql and deploy manage-sharing to generate your link.');
    }
    target.innerHTML = `<div class="link-result"><input id="org-view-link-url" aria-label="Permanent viewer link" readonly value="${escapeHtml(result.url)}"><button type="button" class="secondary" id="org-copy-view-link">Copy link</button></div><p class="link-warning">This same link has no expiration. You can email it or copy it again anytime. Anyone holding it can view and print.</p>`;
    document.getElementById('org-copy-view-link').addEventListener('click', async () => {
      const input = document.getElementById('org-view-link-url');
      try { await navigator.clipboard.writeText(input.value); }
      catch { input.focus(); input.select(); document.execCommand('copy'); }
      alert('Permanent viewer link copied.');
    });
    document.getElementById('org-view-link-status').textContent = 'Permanent viewer link active. Getting or copying it never changes it.';
  }

  function showSharingPanel() {
    window.requireAdmin(() => {
      document.getElementById('modal').innerHTML = `<div class="modal"><section class="form admin-modal"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">Access control</span><h2>Share the directory</h2><p>Anyone can view and print using the normal website address. Existing viewer links also continue to work. Only signed-in administrators can edit. Up to ten admins are allowed.</p><div class="admin-section"><h3>Viewer link</h3><p id="org-view-link-status">Checking link status…</p><div class="link-tools"><button type="button" class="primary" id="org-create-view-link">Get permanent viewer link</button></div><div id="org-view-link-result"></div></div><form id="org-invite-form" class="admin-section"><h3>Named access</h3><p>Viewing needs no account. Invite an administrator here to verify their email and set their own password. Existing Viewer accounts remain read-only.</p><div class="admin-grid"><label class="admin-wide">Email address<input name="email" type="email" required placeholder="person@example.com"></label><label>Access level<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="primary" type="submit">Invite by email</button></div></form><div class="admin-section"><h3>Named accounts</h3><p>Change an account email or role, or revoke that account’s access. Revoking access does not delete their Supabase identity.</p><div id="org-share-members" class="share-list"></div></div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Close</button></div></section></div>`;
      document.getElementById('org-create-view-link').addEventListener('click', async () => {
        const button = document.getElementById('org-create-view-link');
        button.disabled = true;
        try {
          const result = await callSharingFunction({ action: 'create-view-link' });
          showPermanentViewerLink(result);
        } catch (error) { alert(error.message); }
        finally { button.disabled = false; }
      });
      document.getElementById('org-invite-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const inviteForm = event.currentTarget;
        const data = new FormData(inviteForm);
        const feedback = inviteForm.querySelector('button[type="submit"]');
        feedback.disabled = true;
        try {
          const result = await callSharingFunction({ action: 'invite', email: data.get('email'), role: data.get('role') });
          alert(result.invitationSent ? 'Invitation sent. The recipient can follow the email link to verify their email and set a password.' : 'Access granted. This email already has an account; ask them to sign in with their password, or use Set or reset password.');
          inviteForm.reset();
          await refreshShareList();
        } catch (error) { alert(error.message); }
        finally { feedback.disabled = false; }
      });
      refreshShareList();
      refreshViewLinkStatus();
    });
  }

  async function refreshViewLinkStatus() {
    const target = document.getElementById('org-view-link-status');
    if (!target) return;
    try {
      const result = await callSharingFunction({ action: 'view-link-status' });
      target.textContent = result.active ? 'Permanent viewer link is active.' : 'Get a permanent viewer link to share the directory.';
    } catch (error) { target.textContent = error.message; }
  }

  function showPhotoStoragePanel() {
    window.requireAdmin(() => {
      const modal = document.getElementById('modal');
      modal.innerHTML = '<div class="modal"><section class="form admin-modal"><button type="button" class="close" id="org-photo-close">×</button><h2>Photo storage</h2><section class="admin-section" id="org-photo-summary" aria-live="polite"><h3 id="org-photo-migration-title"></h3><p id="org-photo-migration-description"></p><p id="org-photo-counts"></p></section><p><strong>Moving older photos is not a routine task.</strong> New uploaded image files are resized without cropping and stored separately automatically. You do not repeat migration after each upload. Only use Move existing photos if this panel finds older embedded images, for example after importing an old backup.</p><section class="admin-section"><h3>Directory backups</h3><p>Download directory backup saves the current records and settings. It does not move photos. Images already stored separately are represented by references; this JSON file alone does not back up those image files.</p><p>A photo folder on your computer is a separate backup. The website cannot check or update that folder. Keep current image copies and directory backups in an approved location.</p></section><div class="admin-actions"><button type="button" class="secondary" id="org-photo-backup">Download directory backup</button><button type="button" class="primary" id="org-photo-migrate" disabled>Move existing photos</button></div><p id="org-photo-progress" role="status"></p><button type="button" class="cancel" id="org-photo-done">Close</button></section></div>';
      let backupState;
      let revision;
      const status = document.getElementById('org-photo-progress');
      const migrateButton = document.getElementById('org-photo-migrate');
      const backupButton = document.getElementById('org-photo-backup');
      const summary = document.getElementById('org-photo-summary');
      function refreshMigrationSummary() {
        if (!summary.isConnected) { refreshPhotoStorageStatus = null; return; }
        const state = collectState();
        const images = window.OrgPhotos.slots(state).map(slot => slot.owner[slot.key]).filter(value => typeof value === 'string' && value.trim());
        const embedded = images.filter(value => value.startsWith('data:image/')).length;
        const separate = images.filter(value => value.startsWith('org-photo:')).length;
        const external = images.filter(value => /^https?:\/\//i.test(value)).length;
        document.getElementById('org-photo-migration-title').textContent = embedded ? 'Older embedded photos found: ' + embedded : 'No migration needed';
        document.getElementById('org-photo-migration-description').textContent = embedded
          ? 'These older images are still inside the directory data. Download a current directory backup first, then move them once. New file uploads do not need this step.'
          : external ? 'Your images use separate storage or external links. No embedded photos need moving.'
          : separate ? 'Your photos are already stored separately. No move is needed.'
          : 'There are no embedded photos to move.';
        document.getElementById('org-photo-counts').textContent = 'Embedded image references: ' + embedded + ' · Private-storage image references: ' + separate + ' · External image links: ' + external;
        const backupIsCurrent = backupState && stateFingerprint(backupState) === stateFingerprint(state) && stateFingerprint(state) === lastServerState;
        migrateButton.disabled = photoMigrationActive || !embedded || !backupIsCurrent;
        migrateButton.title = !embedded ? 'No older embedded photos were found. No move is needed.' : !backupIsCurrent ? 'Download a current directory backup before moving older photos.' : 'Move the older embedded photos to separate storage.';
      }
      refreshPhotoStorageStatus = refreshMigrationSummary;
      refreshMigrationSummary();
      for (const id of ['org-photo-close', 'org-photo-done']) document.getElementById(id).onclick = () => { if (!photoMigrationActive) window.closeAdd(); };
      backupButton.onclick = async () => {
        backupState = null;
        revision = null;
        migrateButton.disabled = true;
        backupButton.disabled = true;
        try {
          if (stateFingerprint(collectState()) !== lastServerState) throw new Error('Wait for all changes to save before downloading this backup.');
          const { data, error } = await client.from('org_state').select('state,updated_at').eq('id', 1).single();
          if (error || !data?.state) throw new Error('Could not download the directory. Try again.');
          if (stateFingerprint(data.state) !== stateFingerprint(collectState())) throw new Error('The directory changed on another device. Reload before moving photos.');
          backupState = data.state;
          revision = data.updated_at;
          const backupUrl = URL.createObjectURL(new Blob([JSON.stringify(backupState)], { type: 'application/json' }));
          const anchor = document.createElement('a');
          anchor.href = backupUrl;
          anchor.download = `org-chart-original-photos-${new Date().toISOString().slice(0, 10)}.json`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(backupUrl), 60000);
          const count = window.OrgPhotos.slots(backupState).filter(slot => String(slot.owner[slot.key] || '').startsWith('data:image/')).length;
          status.textContent = count ? `${count} embedded photos found. Keep the downloaded backup, then click Move existing photos.` : 'Directory backup downloaded. No migration needed; you do not need to move photos again after new uploads.';
          refreshMigrationSummary();
        } catch (error) { status.textContent = error.message; }
        finally { backupButton.disabled = false; }
      };
      migrateButton.onclick = async () => {
        if (!backupState || photoMigrationActive) return;
        if (stateFingerprint(collectState()) !== lastServerState || stateFingerprint(collectState()) !== stateFingerprint(backupState)) { status.textContent = 'The directory has changed. Wait for changes to save, then download a fresh backup.'; refreshMigrationSummary(); return; }
        photoMigrationActive = true;
        migrateButton.disabled = backupButton.disabled = true;
        clearTimeout(saveTimer);
        status.textContent = 'Preparing photos to move. Keep this page open.';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const preventLeave = event => { event.preventDefault(); event.returnValue = ''; };
        window.addEventListener('beforeunload', preventLeave);
        try {
          const next = structuredClone(backupState);
          await window.OrgPhotos.moveEmbedded(next, (done, total) => { status.textContent = `Moving photos: ${done} of ${total}. Keep this page open.`; });
          // Compare-and-swap: never overwrite another administrator's newer work.
          const { data, error } = await client.from('org_state').update({ state: next, updated_at: new Date().toISOString(), updated_by: currentUser.id }).eq('id', 1).eq('updated_at', revision).select('updated_at').single();
          if (error || !data) throw new Error('The move was not saved. The directory may have changed on another device. Reload and download a fresh backup; your original records remain intact.');
          await window.OrgPhotos.ensure(next);
          applySharedState(next);
          lastServerState = stateFingerprint(collectState());
          const before = new Blob([JSON.stringify(backupState)]).size;
          const after = new Blob([JSON.stringify(next)]).size;
          status.textContent = `Photos moved successfully. Directory data: ${(before / 1048576).toFixed(1)} MB → ${(after / 1048576).toFixed(2)} MB. Keep your backup.`;
          setSaveStatus('All changes saved for everyone.');
          backupState = null;
          refreshMigrationSummary();
        } catch (error) { status.textContent = error.message; }
        finally {
          photoMigrationActive = false;
          window.removeEventListener('beforeunload', preventLeave);
          backupButton.disabled = false;
          migrateButton.disabled = true;
        }
      };
    });
  }

  function downloadLocalSnapshot() {
    const blob = new Blob([JSON.stringify(readLocalState(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `org-chart-migration-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function activateViewerLink() {
    const version = ++accessVersion;
    const result = await callSharingFunction({ action: 'read-public' });
    if (version !== accessVersion) return;
    await window.OrgPhotos.ensure(result.state, result.photoUrls || []);
    if (version !== accessVersion) return;
    viewerLinkActive = true;
    currentUser = null;
    currentRole = 'public-viewer';
    window.orgAuthRole = 'viewer';
    applySharedState(result.state);
    localStorage.removeItem('org-chart-view-token');
    if (new URLSearchParams(location.hash.slice(1)).has('view')) history.replaceState(null, '', location.pathname + location.search);
    setRoleControls();
    clearInterval(viewerPollTimer);
    viewerPollTimer = setInterval(async () => {
      if (!viewerLinkActive || document.getElementById(gateId)) return;
      try {
        const update = await callSharingFunction({ action: 'read-public' });
        if (!viewerLinkActive || version !== accessVersion || document.getElementById(gateId)) return;
        await window.OrgPhotos.ensure(update.state, update.photoUrls || []);
        if (!viewerLinkActive || version !== accessVersion || document.getElementById(gateId)) return;
        applySharedState(update.state);
        setSaveStatus('Shared directory');
      } catch { setSaveStatus('Could not refresh. Reload when your connection returns.', true); }
    }, 5 * 60 * 1000);
  }

  async function start() {
    const config = window.ORG_CHART_CONFIG || {};
    if (!config.url || !config.anonKey || !window.supabase?.createClient) {
      showGate('Secure setup required', 'This directory is locked until a Supabase project URL and public anon key are configured. Follow SUPABASE_SETUP.md to connect authentication and shared storage.', '<button id="org-export-local" type="button">Export this browser’s directory for migration</button>');
      document.getElementById('org-export-local').addEventListener('click', downloadLocalSnapshot);
      return;
    }
    authRedirectUrl = config.redirectUrl || `${window.location.origin}${window.location.pathname}`;
    client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    window.OrgPhotos.configure(client, () => currentRole === 'admin');
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') passwordSetupRequired = true;
      setTimeout(() => {
        if (event === 'INITIAL_SESSION' && failedEmailCallback && !session) return;
        queueSessionActivation(session);
      }, 0);
    });
    const { data: { session }, error } = await client.auth.getSession();
    if (error) { showLogin('Could not complete sign-in: ' + error.message); return; }
    if (callbackError && !session) {
      clearEmailLinkError();
      showLogin('This email sign-in or password-reset link is invalid or has expired. It did not verify your password or authorize a password change. If you already set a website password, sign in below. Otherwise request a new password setup email.');
      return;
    }
    await queueSessionActivation(session);
  }

  start().catch((error) => showGate('Could not connect', error.message || 'The secure directory service could not be reached.'));
})();
