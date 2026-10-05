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

  document.head.insertAdjacentHTML('beforeend', '<style>.share-member input{min-width:0;width:100%;padding:8px;border:1px solid #b9cbd4;background:#fff;color:#000}.link-tools{display:flex;gap:8px;flex-wrap:wrap}.link-result{display:flex;gap:8px;align-items:center;margin-top:10px}.link-result input{min-width:0;flex:1;padding:8px;border:1px solid #b9cbd4}.link-warning{font-size:11px;color:#52636b;margin-top:8px}</style>');
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
    originalSetItem('org-chart-departments', JSON.stringify(state.departments));
    originalSetItem('org-chart-groups', JSON.stringify(state.groups || []));
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
    if (result.needsExistingLink) {
      target.innerHTML = `<form id="org-save-existing-link"><p>Keep the link you already emailed: paste it once below. It will become the permanent link.</p><label>Existing viewer link<input id="org-existing-view-link" type="url" required placeholder="Paste the full viewer link"></label><button type="submit" class="secondary">Save existing link</button><p id="org-existing-link-feedback" role="status"></p></form>`;
      document.getElementById('org-save-existing-link').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        button.disabled = true;
        try {
          const url = new URL(document.getElementById('org-existing-view-link').value.trim());
          const token = new URLSearchParams(url.hash.slice(1)).get('view');
          if (!token) throw new Error('Paste the complete viewer link, including #view= at the end.');
          showPermanentViewerLink(await callSharingFunction({ action: 'create-view-link', token }));
        } catch (error) {
          document.getElementById('org-existing-link-feedback').textContent = error.message;
          button.disabled = false;
        }
      });
      document.getElementById('org-view-link-status').textContent = 'Your existing link remains valid. Save it once to enable copying it here.';
      return;
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
    localStorage.setItem('org-chart-view-token', token);
    currentUser = null;
    currentRole = 'link-viewer';
    window.orgAuthRole = 'viewer';
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    applySharedState(data.state);
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
      applySharedState(result.data.state);
    }, 60000);
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
