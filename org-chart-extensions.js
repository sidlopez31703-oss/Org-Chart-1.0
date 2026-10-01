document.head.insertAdjacentHTML('beforeend', '<style>.org-label-node{min-width:180px;padding:12px 20px;background:#e5f1f6;border:2px solid #0072a8;color:#003b5c;text-align:center;font-size:13px;font-weight:700;box-shadow:0 3px 10px #003b5c12}.node-vacant{border-style:dashed!important;background:#fffdf8}.node-vacant .vacant-avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:50%;background:#f2b544;color:#000;font-weight:700}.vacant-badge{display:inline-block;margin:8px 0;padding:4px 7px;background:#fff0c2;color:#000;font-size:10px;font-weight:700;text-transform:uppercase}.position-state-note{font-size:10px;color:#52636b;margin-top:5px}.department-label-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;margin:7px 0;background:#f4f7f8;border:1px solid #d6e0e5;font-size:12px}.department-label-row strong{color:#003b5c}.admin-modal .admin-grid label[hidden]{display:none}</style>');

function orgParentOptions(departmentName, currentId = '', selectedId = '') {
  const positionOptions = people
    .filter((person) => person[0] !== currentId && (person[3] === departmentName || person[0] === 'ceo'))
    .map((person) => `<option value="${esc(person[0])}" ${person[0] === selectedId ? 'selected' : ''}>${esc(person[1])} (${esc(person[5])})</option>`);
  const groupOptions = orgGroups
    .filter((group) => group.department === departmentName && group.id !== currentId)
    .map((group) => `<option value="${esc(group.id)}" ${group.id === selectedId ? 'selected' : ''}>Section: ${esc(group.name)}</option>`);
  return `<option value="" ${selectedId ? '' : 'selected'}>Top level / no supervisor</option>${positionOptions.join('')}${groupOptions.join('')}`;
}

function positionHasCycle(positionId, proposedParentId) {
  let parentId = proposedParentId;
  const seen = new Set();
  while (parentId) {
    if (parentId === positionId || seen.has(parentId)) return true;
    seen.add(parentId);
    const parentPerson = people.find((person) => person[0] === parentId);
    const parentGroup = orgGroups.find((group) => group.id === parentId);
    parentId = parentPerson ? parentPerson[10] || '' : parentGroup?.reportsTo || '';
  }
  return false;
}

function toggleVacancyFields(select) {
  const form = select.form;
  const vacant = select.value === 'vacant';
  const nameInput = form.querySelector('[name="name"]');
  const pidInput = form.querySelector('[name="pid"]');
  const emailInput = form.querySelector('[name="email"]');
  if (nameInput) {
    if (vacant && !nameInput.readOnly) nameInput.dataset.filledName = nameInput.value;
    nameInput.required = !vacant;
    nameInput.readOnly = vacant;
    nameInput.value = vacant ? 'Vacant' : (nameInput.value === 'Vacant' ? nameInput.dataset.filledName || '' : nameInput.value);
  }
  if (pidInput) pidInput.required = !vacant;
  if (emailInput) emailInput.required = !vacant;
  form.querySelectorAll('.vacancy-optional').forEach((field) => { field.hidden = vacant; });
  const note = form.querySelector('.position-state-note');
  if (note) note.textContent = vacant
    ? 'The chart will display the title with “Vacant” beneath it. Employee contact fields are optional.'
    : 'Enter the employee details for this filled position.';
}

function addDepartmentLabel() {
  const form = document.getElementById('org-label-form');
  if (!form || !dept) return;
  const name = String(form.querySelector('[name="labelName"]').value || '').trim();
  const reportsTo = String(form.querySelector('[name="labelParent"]').value || '');
  if (!name) { alert('Enter a section label.'); return; }
  if (orgGroups.some((group) => group.department === dept && group.name.toLowerCase() === name.toLowerCase())) {
    alert('That label already exists in this department.');
    return;
  }
  const id = `group-${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
  orgGroups.push({ id, name, department: dept, reportsTo });
  localStorage.setItem('org-chart-groups', JSON.stringify(orgGroups));
  showPositionAdmin();
  render();
}

function removeDepartmentLabel(id) {
  const group = orgGroups.find((entry) => entry.id === id);
  if (!group || !confirm(`Delete “${group.name}”? Its direct children will move to the label’s parent.`)) return;
  for (const person of people) if (person[10] === id) person[10] = group.reportsTo || '';
  for (const child of orgGroups) if (child.reportsTo === id) child.reportsTo = group.reportsTo || '';
  orgGroups = orgGroups.filter((entry) => entry.id !== id);
  localStorage.setItem('org-chart-groups', JSON.stringify(orgGroups));
  localStorage.setItem('org-chart-people', JSON.stringify(people));
  showPositionAdmin();
  render();
}

showPositionAdmin = function() {
  if (!dept) return;
  requireAdmin(() => {
    const departmentPeople = people.filter((person) => person[3] === dept);
    const departmentGroups = orgGroups.filter((group) => group.department === dept);
    const parentOptions = orgParentOptions(dept);
    document.getElementById('modal').innerHTML = `<div class="modal"><form class="form admin-modal" onsubmit="addManagedPosition(event)"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">${esc(dept)} positions</span><h2>Manage positions</h2><p>Add filled or vacant positions and organize them under reporting lines or section labels.</p><div class="admin-section"><h3>Add position</h3><div class="admin-grid"><label>Position status<select name="status" onchange="toggleVacancyFields(this)"><option value="filled">Filled position</option><option value="vacant">Vacant position</option></select><small class="position-state-note">Enter the employee details for this filled position.</small></label><label>Person name<input name="name" required></label><label>Position ID<input name="pid" required></label><label class="admin-wide">Full position title<input name="title" required placeholder="e.g. Deputy Director"></label><label class="admin-wide">Department<input name="department" value="${esc(dept)}" readonly></label><label>Responsibility category<select name="level">${positionLevelOptions(dept, '')}</select></label><label class="admin-wide">Reports to<select name="reportsTo">${parentOptions}</select><small class="hierarchy-note">Choose a position or section label. This node will connect underneath it.</small></label><label class="vacancy-optional">Email<input name="email" type="email" required></label><label class="vacancy-optional">Mobile phone<input name="phone"></label><label class="vacancy-optional">Desk phone<input name="desk"></label><label class="admin-wide vacancy-optional">Photo URL<input name="photo" placeholder="https://... or choose a file"></label><label class="admin-wide vacancy-optional">Or choose a photo file<input name="photoFile" type="file" accept="image/*"></label></div></div><section class="admin-section"><h3>Department labels / sections</h3><p>Add a heading such as “Inspection Area 5”; positions and nested labels can report to it.</p><div id="org-label-form" class="admin-grid"><label>Section label<input name="labelName" placeholder="e.g. Inspection Area 5"></label><label>Reports to<select name="labelParent">${parentOptions}</select></label><button type="button" class="primary" onclick="addDepartmentLabel()">Add section label</button></div>${departmentGroups.map((group) => `<div class="department-label-row"><span><strong>${esc(group.name)}</strong><small>${group.reportsTo ? ' · Nested section' : ' · Top-level section'}</small></span><button type="button" class="delete-admin" onclick="removeDepartmentLabel('${esc(group.id)}')">Delete label</button></div>`).join('') || '<p>No department labels yet.</p>'}</section><div class="admin-section"><h3>Delete position</h3>${departmentPeople.map((person) => `<div class="position-delete-row"><span>${person[11] ? `${esc(person[2])} · Vacant` : esc(person[1])} <small>${esc(person[5])}</small></span><button type="button" class="delete-admin" onclick="deleteManagedPosition('${esc(person[0])}')">Delete</button></div>`).join('') || '<p>No positions in this department yet.</p>'}</div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Close</button><button class="primary">Add position</button></div></form></div>`;
  });
};

addManagedPosition = async function(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const vacant = data.get('status') === 'vacant';
  const title = String(data.get('title') || '').trim();
  const email = String(data.get('email') || '').trim();
  let pid = String(data.get('pid') || '').trim();
  if (!title) { alert('Enter the full position title.'); return; }
  if (!vacant && !email) { alert('An email address is required for a filled position.'); form.querySelector('[name="email"]').focus(); return; }
  if (vacant && !pid) pid = `VAC-${Date.now().toString().slice(-7)}`;
  if (people.some((person) => String(person[5]).toLowerCase() === pid.toLowerCase())) { alert('That PID is already in use.'); return; }
  const id = `managed-${Date.now()}`;
  const reportsTo = String(data.get('reportsTo') || '');
  const validParent = people.some((person) => person[0] === reportsTo && (person[3] === dept || person[0] === 'ceo')) || orgGroups.some((group) => group.id === reportsTo && group.department === dept);
  if (reportsTo && !validParent) { alert('Choose a parent position or section from this department.'); return; }
  const photo = vacant ? '' : await readImageFile(form.querySelector('[name="photoFile"]'), String(data.get('photo') || `https://i.pravatar.cc/160?u=${id}`));
  people.push([id, vacant ? 'Vacant' : String(data.get('name')).trim(), title, dept, String(data.get('level')), pid, vacant ? '' : String(data.get('phone') || ''), vacant ? '' : String(data.get('desk') || ''), vacant ? '' : email, photo, reportsTo, vacant]);
  localStorage.setItem('org-chart-people', JSON.stringify(people));
  selected = null;
  const searchInput = document.getElementById('search');
  if (searchInput) searchInput.value = '';
  closeAdd();
  render();
};

function positionNodeMarkup(person) {
  const vacant = Boolean(person[11]);
  const category = levelsFor(person[3]).find((entry) => entry.name.toLowerCase() === String(person[4]).toLowerCase());
  const color = category ? levelColorMap[category.color] || '#66727a' : '#66727a';
  return `<button class="node ${vacant ? 'node-vacant' : ''}" style="border-left-color:${color}" onclick="selected=people.find(x=>x[0]==='${esc(person[0])}');render()">${vacant ? '<span class="vacant-avatar">V</span>' : `<img src="${esc(person[9])}" alt="">`}<span class="node-copy"><strong>${esc(vacant ? person[2] : person[1])}</strong><span>${vacant ? 'Vacant' : esc(person[2])}</span><small>${esc(person[5])}</small></span></button>`;
}

function combinedTreeBranch(entity, allEntities) {
  const children = allEntities.filter((candidate) => candidate.parentId === entity.id);
  const node = entity.type === 'group' ? `<div class="org-label-node">${esc(entity.name)}</div>` : positionNodeMarkup(entity.person);
  return `<div class="tree-branch">${node}${children.length ? `<div class="tree-children">${children.map((child) => combinedTreeBranch(child, allEntities)).join('')}</div>` : ''}</div>`;
}

orgTree = function(list) {
  const departmentGroups = orgGroups.filter((group) => group.department === dept);
  const entities = [
    ...list.map((person) => ({ id: person[0], parentId: person[10] || '', type: 'person', person })),
    ...departmentGroups.map((group) => ({ id: group.id, parentId: group.reportsTo || '', type: 'group', name: group.name })),
  ];
  const ids = new Set(entities.map((entity) => entity.id));
  const roots = entities.filter((entity) => !entity.parentId || !ids.has(entity.parentId));
  return roots.map((root) => combinedTreeBranch(root, entities)).join('') || '<div class="empty">No positions found</div>';
};

nodes = function(list) { return list.map(positionNodeMarkup).join('') || '<div class="empty">No positions found</div>'; };

details = function(person) {
  const vacant = Boolean(person[11]);
  const contacts = vacant ? '' : `<div><span>Mobile</span><b>${esc(person[6] || 'Not listed')}</b></div><div><span>Desk phone</span><b>${esc(person[7] || 'Not listed')}</b></div><div><span>Email</span><b>${esc(person[8] || 'Not listed')}</b></div>`;
  return `<aside class="panel"><button class="close" onclick="selected=null;render()">×</button>${person[9] ? `<img src="${esc(person[9])}" alt="">` : ''}<h3>${esc(vacant ? person[2] : person[1])}</h3><p>${vacant ? '<span class="vacant-badge">Vacant</span><br>' : ''}<b>${esc(person[2])}</b><br>${esc(person[3])}</p><div class="details"><div><span>Position ID</span><b>${esc(person[5])}</b></div>${contacts}</div><div class="details-actions"><button class="text-button" onclick="showEditPosition('${esc(person[0])}')">Edit position</button><button class="delete" onclick="requireAdmin(() => { if (confirm('Delete this position?')) { deleteManagedPosition('${esc(person[0])}'); selected=null; render(); } })">Delete position</button></div></aside>`;
};

function updateEditDepartmentWithGroups(select, id) {
  const person = people.find((entry) => entry[0] === id);
  if (!person) return;
  const form = select.form;
  form.querySelector('[name="level"]').innerHTML = positionLevelOptions(select.value, person[4]);
  form.querySelector('[name="reportsTo"]').innerHTML = orgParentOptions(select.value, id, '');
}

showEditPosition = function(id) {
  requireAdmin(() => {
    const person = people.find((entry) => entry[0] === id);
    if (!person) return;
    const vacant = Boolean(person[11]);
    const parentOptions = orgParentOptions(person[3], person[0], person[10] || '');
    document.getElementById('modal').innerHTML = `<div class="modal"><form class="form admin-modal" onsubmit="saveEditedPosition(event, '${esc(id)}')"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">${esc(person[3])} position</span><h2>Edit position</h2><div class="admin-grid"><label>Position status<select name="status" onchange="toggleVacancyFields(this)"><option value="filled" ${vacant ? '' : 'selected'}>Filled position</option><option value="vacant" ${vacant ? 'selected' : ''}>Vacant position</option></select><small class="position-state-note">${vacant ? 'Contact fields are optional for a vacant position.' : 'Employee details are required.'}</small></label><label>Person name<input name="name" value="${esc(vacant ? 'Vacant' : person[1])}" ${vacant ? 'readonly' : 'required'}></label><label>Position ID<input name="pid" value="${esc(person[5])}" ${vacant ? '' : 'required'}></label><label class="admin-wide">Full position title<input name="title" value="${esc(person[2])}" required></label><label>Department<select name="department" onchange="updateEditDepartmentWithGroups(this, '${esc(id)}')">${departmentOptions(person[3])}</select></label><label>Responsibility category<select name="level">${positionLevelOptions(person[3], person[4])}</select></label><label class="admin-wide">Reports to<select name="reportsTo">${parentOptions}</select></label><label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Email<input name="email" type="email" value="${esc(person[8])}" ${vacant ? '' : 'required'}></label><label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Mobile phone<input name="phone" value="${esc(person[6])}"></label><label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Desk phone<input name="desk" value="${esc(person[7])}"></label><label class="admin-wide vacancy-optional" ${vacant ? 'hidden' : ''}>Photo URL<input name="photo" value="${esc(person[9])}" placeholder="https://... or choose a file"></label><label class="admin-wide vacancy-optional" ${vacant ? 'hidden' : ''}>Or choose a new photo file<input name="photoFile" type="file" accept="image/*"></label></div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Cancel</button><button class="primary">Save position</button></div></form></div>`;
  });
};

saveEditedPosition = async function(event, id) {
  event.preventDefault();
  const person = people.find((entry) => entry[0] === id);
  if (!person) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const vacant = data.get('status') === 'vacant';
  const email = String(data.get('email') || '').trim();
  let pid = String(data.get('pid') || '').trim();
  if (!vacant && !email) { alert('An email address is required for a filled position.'); form.querySelector('[name="email"]').focus(); return; }
  if (vacant && !pid) pid = `VAC-${Date.now().toString().slice(-7)}`;
  if (people.some((entry) => entry[0] !== id && String(entry[5]).toLowerCase() === pid.toLowerCase())) { alert('That PID is already in use.'); return; }
  const department = String(data.get('department'));
  const reportsTo = String(data.get('reportsTo') || '');
  if (reportsTo && positionHasCycle(id, reportsTo)) { alert('That reporting line would create a loop. Choose a different parent.'); return; }
  const parentExists = people.some((entry) => entry[0] === reportsTo && (entry[3] === department || entry[0] === 'ceo')) || orgGroups.some((group) => group.id === reportsTo && group.department === department);
  if (reportsTo && !parentExists) { alert('Choose a parent position or section from this department.'); return; }
  const photo = vacant ? '' : await readImageFile(form.querySelector('[name="photoFile"]'), String(data.get('photo') || person[9]));
  person[1] = vacant ? 'Vacant' : String(data.get('name')).trim(); person[2] = String(data.get('title')).trim(); person[3] = department; person[4] = String(data.get('level')); person[5] = pid; person[6] = vacant ? '' : String(data.get('phone') || ''); person[7] = vacant ? '' : String(data.get('desk') || ''); person[8] = vacant ? '' : email; person[9] = photo; person[10] = reportsTo; person[11] = vacant;
  localStorage.setItem('org-chart-people', JSON.stringify(people));
  selected = person; dept = department; closeAdd(); render();
};

function deleteManagedPosition(id) {
  const person = people.find((entry) => entry[0] === id);
  if (!person || !confirm(`Delete ${person[1]} (${person[5]})? Direct reports will move to its parent.`)) return;
  for (const child of people) if (child[10] === id) child[10] = person[10] || '';
  for (const group of orgGroups) if (group.reportsTo === id) group.reportsTo = person[10] || '';
  people = people.filter((entry) => entry[0] !== id);
  localStorage.setItem('org-chart-people', JSON.stringify(people));
  localStorage.setItem('org-chart-groups', JSON.stringify(orgGroups));
  showPositionAdmin();
}

loadSecurityScript('./supabase-config.js', () => loadSecurityScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', () => loadSecurityScript('./secure-portal.js')));
*** End Patch