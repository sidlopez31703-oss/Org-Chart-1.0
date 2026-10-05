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
  let suppressStorageSync = false;
  let photoMigrationActive = false;
  let photoRefreshTimer;
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
      options: { shouldCreateUser: false, emailRedirectTo: authRedirectUrl },
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
    const displayUser = currentRole === 'link-viewer' ? 'Shared viewing link' : currentUser?.email || 'Signed in';
    const displayRole = currentRole === 'admin' ? 'Administrator' : 'Viewer';
    toolbar.innerHTML = `<span>${escapeHtml(displayUser)} · ${displayRole}</span><span id="org-save-status">Shared directory</span><button id="org-sign-out" type="button">${currentRole === 'link-viewer' ? 'Exit shared view' : 'Sign out'}</button>`;
    const header = document.querySelector('.top');
    header?.insertAdjacentElement('afterend', toolbar);
    document.getElementById('org-sign-out').addEventListener('click', async () => {
      clearLocalDirectory();
      if (currentRole === 'link-viewer') {
        localStorage.removeItem('org-chart-view-token');
        viewerLinkActive = false;
        if (viewerPollTimer) clearInterval(viewerPollTimer);
        showLogin();
        return;
      }
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
      document.getElementById('modal').innerHTML = `<div class="modal"><section class="form admin-modal"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">Access control</span><h2>Share the directory</h2><p>Anyone with the private viewer link can view. Link holders can forward it, and the same link stays valid without expiration. Signed-in administrators can edit. Up to ten admins are allowed.</p><div class="admin-section"><h3>Viewer link</h3><p id="org-view-link-status">Checking link status…</p><div class="link-tools"><button type="button" class="primary" id="org-create-view-link">Get permanent viewer link</button></div><div id="org-view-link-result"></div></div><form id="org-invite-form" class="admin-section"><h3>Named access</h3><p>Optional email-based accounts can be assigned Viewer or Administrator access.</p><div class="admin-grid"><label class="admin-wide">Email address<input name="email" type="email" required placeholder="person@example.com"></label><label>Access level<select name="role"><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button class="primary" type="submit">Invite by email</button></div></form><div class="admin-section"><h3>Named accounts</h3><p>Change an account email or role, or revoke that account’s access. Revoking access does not delete their Supabase identity.</p><div id="org-share-members" class="share-list"></div></div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Close</button></div></section></div>`;
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
      modal.innerHTML = `<div class="modal"><section class="form admin-modal"><button type="button" class="close" id="org-photo-close">×</button><h2>Photo storage</h2><p>New JPG, PNG, and WebP uploads are automatically resized without cropping and saved privately.</p><p>Move the existing embedded photos to private storage to make the directory faster. Download a backup first; it keeps your original embedded photos.</p><div class="admin-actions"><button type="button" class="secondary" id="org-photo-backup">Download directory backup</button><button type="button" class="primary" id="org-photo-migrate" disabled>Move existing photos</button></div><p id="org-photo-progress" role="status"></p><button type="button" class="cancel" id="org-photo-done">Close</button></section></div>`;
      let backupState;
      let revision;
      const status = document.getElementById('org-photo-progress');
      const migrateButton = document.getElementById('org-photo-migrate');
      const backupButton = document.getElementById('org-photo-backup');
      for (const id of ['org-photo-close', 'org-photo-done']) document.getElementById(id).onclick = () => { if (!photoMigrationActive) window.closeAdd(); };
      backupButton.onclick = async () => {
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
          status.textContent = count ? `${count} embedded photos found. Keep the downloaded backup, then click Move existing photos.` : 'Your photos are already stored separately. No move is needed.';
          migrateButton.disabled = !count;
        } catch (error) { status.textContent = error.message; }
        finally { backupButton.disabled = false; }
      };
      migrateButton.onclick = async () => {
        if (!backupState || photoMigrationActive) return;
        if (stateFingerprint(collectState()) !== lastServerState) { status.textContent = 'Wait for changes to save, then download a fresh backup.'; return; }
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

  async function activateViewerLink(token) {
    const { data, error } = await client.functions.invoke('manage-sharing', { body: { action: 'read-link', token } });
    if (error || !data?.state) {
      viewerLinkActive = false;
      localStorage.removeItem('org-chart-view-token');
      showGate('Viewer link unavailable', data?.error || error?.message || 'This viewer link is invalid or the directory is temporarily unavailable.');
      return;
    }
    viewerLinkActive = true;
    currentUser = null;
    currentRole = 'link-viewer';
    window.orgAuthRole = 'viewer';
    await window.OrgPhotos.ensure(data.state, data.photoUrls || []);
    applySharedState(data.state);
    // Remembering a verified link is convenient, but storage failure must not
    // deny viewing. If it cannot be saved, keep the original URL token intact.
    try {
      localStorage.setItem('org-chart-view-token', token);
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    } catch (error) {
      console.warn('Viewer link could not be remembered in this browser.', error.name);
    }
    setRoleControls();
    if (viewerPollTimer) clearInterval(viewerPollTimer);
    viewerPollTimer = setInterval(async () => {
      if (!viewerLinkActive) return;
      const result = await client.functions.invoke('manage-sharing', { body: { action: 'read-link', token } });
      if (result.error || !result.data?.state) {
        viewerLinkActive = false;
        localStorage.removeItem('org-chart-view-token');
        clearInterval(viewerPollTimer);
        clearLocalDirectory();
        currentRole = null;
        window.orgAuthRole = null;
        showGate('Viewer link unavailable', 'The directory could not be loaded. Reopen your saved viewer link to try again.');
        return;
      }
      await window.OrgPhotos.ensure(result.data.state, result.data.photoUrls || []);
      applySharedState(result.data.state);
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
    const urlViewerToken = new URLSearchParams(window.location.hash.slice(1)).get('view');
    const viewerToken = urlViewerToken || localStorage.getItem('org-chart-view-token');
    viewerLinkActive = Boolean(viewerToken);
    client.auth.onAuthStateChange((_event, session) => {
      setTimeout(() => {
        if (viewerLinkActive && !session) return;
        if (session && viewerLinkActive) {
          viewerLinkActive = false;
          localStorage.removeItem('org-chart-view-token');
        }
        queueSessionActivation(session);
      }, 0);
    });
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    if (session) {
      if (viewerLinkActive) {
        viewerLinkActive = false;
        localStorage.removeItem('org-chart-view-token');
        history.replaceState(null, '', `${location.pathname}${location.search}`);
      }
      await queueSessionActivation(session);
    } else if (viewerToken) {
      await activateViewerLink(viewerToken);
    } else {
      await queueSessionActivation(null);
    }
  }

  start().catch((error) => showGate('Could not connect', error.message || 'The secure directory service could not be reached.'));
})();
