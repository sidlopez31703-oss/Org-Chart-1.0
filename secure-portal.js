(() => {
  const gateId = 'org-security-gate';
  let client;
  let currentUser = null;
  let currentRole = null;
  let saveTimer;
  let realtimeChannel = null;
  let lastServerState = null;
  let lastActivatedSessionKey = null;
  let activationQueue = Promise.resolve();
  let suppressStorageSync = false;
  const dataKeys = new Set([
    'org-chart-people',
    'org-chart-departments',
    'org-chart-department-levels',
    'org-chart-levels',
    'org-chart-category-keys',
    'org-chart-site-settings',
    'org-chart-pending-import',
  ]);
  const originalSetItem = localStorage.setItem.bind(localStorage);

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

  window.orgAuthRole = null;
  window.requireAdmin = (callback) => {
    if (currentRole === 'admin') callback();
    else alert('This action is available to directory administrators only.');
  };

  localStorage.setItem = function(key, value) {
    originalSetItem(key, value);
    if (!suppressStorageSync && currentRole === 'admin' && dataKeys.has(key)) scheduleSave();
  };

  function showLogin(message = 'This directory is shared by invitation. Sign in with the email address that was invited.') {
    showGate('Sign in to continue', message, `<form id="org-login-form"><label>Invited email address<input name="email" type="email" autocomplete="email" required></label><label>Optional one-time migration file<input name="migrationFile" type="file" accept="application/json"><small>Use only if you exported your existing local directory.</small></label><button type="submit">Email me a sign-in link</button></form>`);
    document.getElementById('org-login-form').addEventListener('submit', sendSignInLink);
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

  async function sendSignInLink(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = formData.get('email').trim().toLowerCase();
    const feedback = document.getElementById('security-feedback');
    feedback.textContent = 'Checking invitation and sending sign-in link…';
    const importFile = formData.get('migrationFile');
    if (importFile instanceof File && importFile.size > 0) {
      try {
        const imported = JSON.parse(await importFile.text());
        if (!Array.isArray(imported.departments) || !Array.isArray(imported.people)) throw new Error();
        originalSetItem('org-chart-pending-import', JSON.stringify(imported));
      } catch {
        feedback.textContent = 'That migration file is not a valid org chart export.';
        return;
      }
    }
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: window.location.href },
    });
    feedback.textContent = error
      ? `Supabase could not send the sign-in link: ${error.message}`
      : 'If this email has been invited, a secure sign-in link is on its way.';
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
      people: read('org-chart-people', window.people),
      departmentLevels: read('org-chart-department-levels', window.departmentLevels || {}),
      levelLabels: read('org-chart-levels', window.levelLabels || []),
      categoryKeys: read('org-chart-category-keys', window.categoryKeys || []),
      siteSettings: read('org-chart-site-settings', window.siteSettings || {}),
    };
  }

  function clearLocalDirectory() {
    window.people = [];
    window.depts.splice(0, window.depts.length);
    window.departmentLevels = {};
    window.levelLabels = [];
    window.categoryKeys = [];
    for (const key of dataKeys) localStorage.removeItem(key);
  }

  function writeLocalState(state) {
    suppressStorageSync = true;
    originalSetItem('org-chart-departments', JSON.stringify(state.departments));
    originalSetItem('org-chart-people', JSON.stringify(state.people));
    originalSetItem('org-chart-department-levels', JSON.stringify(state.departmentLevels));
    originalSetItem('org-chart-levels', JSON.stringify(state.levelLabels));
    originalSetItem('org-chart-category-keys', JSON.stringify(state.categoryKeys));
    originalSetItem('org-chart-site-settings', JSON.stringify(state.siteSettings));
    suppressStorageSync = false;
  }

  function applySharedState(state) {
    if (!state || !Array.isArray(state.departments) || !Array.isArray(state.people)) {
      throw new Error('The shared directory has not been initialized by an administrator yet.');
    }
    window.depts.splice(0, window.depts.length, ...state.departments);
    window.people = state.people;
    window.departmentLevels = state.departmentLevels || {};
    window.levelLabels = state.levelLabels || [];
    window.categoryKeys = state.categoryKeys || [];
    window.siteSettings = state.siteSettings || window.siteSettings;
    writeLocalState({
      departments: window.depts,
      people: window.people,
      departmentLevels: window.departmentLevels,
      levelLabels: window.levelLabels,
      categoryKeys: window.categoryKeys,
      siteSettings: window.siteSettings,
    });
    window.applySiteSettings?.();
    window.render?.();
  }

  function collectState() {
    return {
      departments: window.depts,
      people: window.people,
      departmentLevels: window.departmentLevels || {},
      levelLabels: window.levelLabels || [],
      categoryKeys: window.categoryKeys || [],
      siteSettings: window.siteSettings || {},
    };
  }

  function setSaveStatus(message, isError = false) {
    const status = document.getElementById('org-save-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#963d3d' : '#003b5c';
  }

  function scheduleSave() {
    setSaveStatus('Saving shared changes…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const state = collectState();
      const { error } = await client.from('org_state').update({
        state,
        updated_at: new Date().toISOString(),
        updated_by: currentUser.id,
      }).eq('id', 1);
      if (error) {
        setSaveStatus('Could not save shared changes. Check your connection.', true);
      } else {
        lastServerState = JSON.stringify(state);
        setSaveStatus('All changes saved for everyone.');
      }
    }, 450);
  }

  function watchSharedChanges() {
    if (realtimeChannel) client.removeChannel(realtimeChannel);
    realtimeChannel = client.channel('org-directory-state')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'org_state', filter: 'id=eq.1' }, (payload) => {
        const incoming = payload.new?.state;
        if (!incoming) return;
        const localIsSaved = JSON.stringify(collectState()) === lastServerState;
        if (currentRole === 'viewer' || localIsSaved) {
          applySharedState(incoming);
          lastServerState = JSON.stringify(incoming);
        } else {
          setSaveStatus('A shared update arrived. Save your changes, then reload to see it.');
        }
      })
      .subscribe();
  }

  function setRoleControls() {
    document.body.classList.remove('org-security-locked');
    document.querySelector('.org-session-toolbar')?.remove();
    const toolbar = document.createElement('div');
    toolbar.className = 'org-session-toolbar';
    toolbar.innerHTML = `<span>Signed in: ${escapeHtml(currentUser.email)} · ${currentRole === 'admin' ? 'Administrator' : 'Viewer'}</span><span id="org-save-status">Shared directory</span><button id="org-sign-out" type="button">Sign out</button>`;
    const header = document.querySelector('.top');
    header?.insertAdjacentElement('afterend', toolbar);
    document.getElementById('org-sign-out').addEventListener('click', async () => {
      clearLocalDirectory();
      currentRole = null;
      currentUser = null;
      window.orgAuthRole = null;
      await client.auth.signOut();
    });

    const footerActions = document.querySelector('.editor-footer>div');
    const websiteButton = footerActions?.querySelector('button[onclick*="showAdmin"]');
    const globalPositionButton = footerActions?.querySelector('button[onclick*="showPositionAdmin"]');
    if (websiteButton) websiteButton.hidden = currentRole !== 'admin';
    if (globalPositionButton) globalPositionButton.hidden = true;

    const shareButton = document.createElement('button');
    shareButton.type = 'button';
    shareButton.className = 'secondary';
    shareButton.id = 'org-share-access';
    shareButton.textContent = 'Share access';
    shareButton.hidden = currentRole !== 'admin';
    shareButton.addEventListener('click', showSharingPanel);
    document.getElementById('org-share-access')?.remove();
    footerActions?.appendChild(shareButton);
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
    if (!session?.user) {
      currentUser = null;
      currentRole = null;
      showLogin();
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
      applySharedState(shared);
    } catch (loadError) {
      showLogin(loadError.message || 'Could not load the shared directory.');
      return;
    }
    lastServerState = JSON.stringify(shared);
    watchSharedChanges();
    setRoleControls();
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
    lastServerState = JSON.stringify(state);
    watchSharedChanges();
    setRoleControls();
  }

  async function callSharingFunction(body) {
    const { data, error } = await client.functions.invoke('manage-sharing', { body });
    if (error) throw new Error(data?.error || error.message || 'Request failed.');
    if (data?.error) throw new Error(data.error);
    return data;
  }

  async function refreshShareList() {
    const target = document.getElementById('org-share-members');
    if (!target) return;
    target.innerHTML = '<p>Loading people with access…</p>';
    try {
      const result = await callSharingFunction({ action: 'list' });
      target.innerHTML = (result.members || []).map((member) => `<div class="share-member"><strong>${escapeHtml(member.email)}</strong><select aria-label="Role for ${escapeHtml(member.email)}"><option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option><option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Administrator</option></select><button type="button" data-share-action="role" data-email="${escapeHtml(member.email)}">Save role</button><button type="button" class="remove-share" data-share-action="remove" data-email="${escapeHtml(member.email)}">Remove</button></div>`).join('') || '<p>No one has been shared yet.</p>';
      target.querySelectorAll('button[data-share-action]').forEach((button) => button.addEventListener('click', async () => {
        try {
          const action = button.dataset.shareAction === 'remove' ? 'remove' : 'set-role';
          const role = button.parentElement.querySelector('select').value;
          await callSharingFunction({ action, email: button.dataset.email, role });
          await refreshShareList();
        } catch (error) { alert(error.message); }
      }));
    } catch (error) {
      target.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    }
  }

  function showSharingPanel() {
    window.requireAdmin(() => {
      document.getElementById('modal').innerHTML = `<div class="modal"><section class="form admin-modal"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">Access control</span><h2>Share the directory</h2><p>Only invited email addresses can sign in. A maximum of two accounts can be administrators.</p><form id="org-invite-form" class="admin-section"><h3>Invite someone</h3><div class="admin-grid"><label class="admin-wide">Email address<input name="email" type="email" required placeholder="name@work.org"></label><label>Access level<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="primary" type="submit">Share access</button></div></form><div class="admin-section"><h3>People with access</h3><div id="org-share-members" class="share-list"></div></div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Close</button></div></section></div>`;
      document.getElementById('org-invite-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const feedback = event.currentTarget.querySelector('button[type="submit"]');
        feedback.disabled = true;
        try {
          const result = await callSharingFunction({ action: 'invite', email: data.get('email'), role: data.get('role') });
          alert(result.invitationSent ? 'Invitation sent. The recipient can follow the email link to sign in.' : 'Access granted. This email already has an account; ask them to request a sign-in link from the directory.');
          event.currentTarget.reset();
          await refreshShareList();
        } catch (error) { alert(error.message); }
        finally { feedback.disabled = false; }
      });
      refreshShareList();
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

  async function start() {
    const config = window.ORG_CHART_CONFIG || {};
    if (!config.url || !config.anonKey || !window.supabase?.createClient) {
      showGate('Secure setup required', 'This directory is locked until a Supabase project URL and public anon key are configured. Follow SUPABASE_SETUP.md to connect authentication and shared storage.', '<button id="org-export-local" type="button">Export this browser’s directory for migration</button>');
      document.getElementById('org-export-local').addEventListener('click', downloadLocalSnapshot);
      return;
    }
    client = window.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => queueSessionActivation(session), 0);
    });
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    await queueSessionActivation(session);
  }

  start().catch((error) => showGate('Could not connect', error.message || 'The secure directory service could not be reached.'));
})();
