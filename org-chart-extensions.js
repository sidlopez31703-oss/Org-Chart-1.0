document.head.insertAdjacentHTML('beforeend', `<style>
/* Separate indirect relationships into side branches with their own connectors. */
.tree-branch{position:relative;display:flex;flex-direction:row;align-items:flex-start;gap:36px}
.tree-main{display:flex;flex-direction:column;align-items:center;flex:0 0 auto}
.tree-main>.tree-children{display:flex;align-items:flex-start;justify-content:center;gap:18px;margin-top:40px}
.tree-indirect-children{display:flex;align-items:flex-start;gap:36px;flex:0 0 auto}
.tree-branch::before,.tree-branch::after,.tree-children::before,.tree-children::after{display:none!important}
.org-connectors{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.org-connectors path{fill:none;stroke:#9eb1a7;stroke-width:1;stroke-linejoin:round}
.org-connectors .connector-indirect{stroke-dasharray:4 4}
.org-label-node{cursor:pointer}
.org-label-node:disabled{cursor:default;opacity:1}
.org-label-node:focus-visible{outline:2px solid #003b5c;outline-offset:3px}
.label-placement{display:block;margin-top:18px;font-size:12px;font-weight:700;color:#003b5c}
.label-placement select{display:block;width:100%;margin:8px 0;padding:9px;border:1px solid #b9cbd4;background:#fff;color:#003b5c}
.label-placement small{display:block;font-size:10px;font-weight:400;line-height:1.4;color:#52636b}
.branch-order-controls{margin-top:18px;padding-top:14px;border-top:1px solid #d6ddd8}
.branch-order-controls strong{font-size:12px;color:#003b5c}
.branch-order-buttons{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.branch-order-buttons button{border:1px solid #b9cbd4;background:#fff;color:#003b5c;padding:7px 10px;font-size:11px;font-weight:700;cursor:pointer}
.branch-order-buttons button:disabled{opacity:.45;cursor:default}
.branch-order-controls small{display:block;margin-top:8px;font-size:10px;line-height:1.4;color:#52636b}
.department-label-row .branch-order-buttons{margin-top:0}
.indirect-line-swatch{display:inline-block;width:26px;height:0;flex:none;border-top:1px dashed #9eb1a7}
#org-print-sheet .indirect-line-swatch{width:18pt}
.node.node-top-level{background:linear-gradient(135deg,rgba(255,255,255,0),rgba(255,255,255,.35)),repeating-linear-gradient(135deg,#dfeaf0 0px,#dfeaf0 8px,#edf3f7 8px,#edf3f7 16px)}
.node-leader::after{content:"";position:absolute;inset:5px;border:3px double #53616b;pointer-events:none}
.leadership-swatch{position:relative;display:inline-block;width:26px;height:20px;flex:none;border:1px solid #aab5bc;background:#fff}
.leadership-swatch::after{content:"";position:absolute;inset:3px;border:3px double #53616b}
.employee-reuse-note{display:block;font-size:11px;line-height:1.4;color:#52636b;margin-top:5px}
#org-print-sheet .leadership-swatch{width:18pt;height:14pt}
#org-print-sheet .leadership-swatch::after{inset:2pt;border-width:2.25pt}
</style>`);

function normalizedPid(value) { return String(value || '').trim().toLowerCase(); }

function pidExistsInDepartment(pid, department, exceptId = '') {
  return people.some(person => person[0] !== exceptId && person[3] === department && normalizedPid(person[5]) === normalizedPid(pid));
}

function syncEmployeeDetails(source) {
  if (source[11] || !normalizedPid(source[5])) return;
  for (const person of people) {
    if (person[0] === source[0] || person[11] || normalizedPid(person[5]) !== normalizedPid(source[5])) continue;
    for (const index of [1, 6, 7, 8, 9]) person[index] = source[index];
  }
}

function reuseEmployeeForPid(input) {
  const form = input.form;
  if (form.dataset.reusedPid === normalizedPid(input.value) && form.elements.namedItem('status')?.value !== 'vacant') return;
  const previous = JSON.parse(form.dataset.reusedFields || '{}');
  for (const [name, value] of Object.entries(previous)) {
    const field = form.elements.namedItem(name);
    if (field && field.value === value) field.value = '';
  }
  delete form.dataset.reusedFields;
  delete form.dataset.reusedPhoto;
  delete form.dataset.reusedPid;
  const note = form.querySelector('.employee-reuse-note');
  const person = people.find(entry => !entry[11] && normalizedPid(entry[5]) === normalizedPid(input.value) && entry[0] !== form.dataset.positionId);
  if (!person || form.elements.namedItem('status')?.value === 'vacant') {
    if (note) note.textContent = 'The same employee PID can be used in different department charts.';
    return;
  }
  const copied = {};
  for (const [name, index] of [['name',1],['phone',6],['desk',7],['email',8]]) {
    const field = form.elements.namedItem(name);
    if (field) copied[name] = field.value = person[index] || '';
  }
  const title = form.elements.namedItem('title');
  if (title && !title.value) copied.title = title.value = person[2] || '';
  form.dataset.reusedFields = JSON.stringify(copied);
  form.dataset.reusedPhoto = person[9] || '';
  form.dataset.reusedPid = normalizedPid(input.value);
  if (note) note.textContent = `${person[1]} found in ${person[3]}. Name, contacts, and photo reused. Title and reporting line can differ in this chart.`;
}

function positionIsLeader(person) {
  if (typeof person[12] === 'boolean') return person[12];
  return /\b(director|chief|ceo|president|head|boss|manager|supervisor)\b/i.test(`${person[2] || ''} ${person[4] || ''}`);
}

function leadershipOptions(person = []) {
  return `<option value="auto" ${typeof person[12] !== 'boolean' ? 'selected' : ''}>Auto — from title / category</option><option value="standard" ${person[12] === false ? 'selected' : ''}>Standard position</option><option value="leader" ${person[12] === true ? 'selected' : ''}>Leadership</option>`;
}

function leadershipValue(formData) {
  const value = formData.get('leadership');
  return value === 'leader' ? true : value === 'standard' ? false : null;
}

// Connection type belongs to a chart position, independent of shared employee details.
function connectionOptions(person = []) {
  return '<option value="direct" ' + (person[13] !== 'indirect' ? 'selected' : '') + '>Direct reporting — solid line</option><option value="indirect" ' + (person[13] === 'indirect' ? 'selected' : '') + '>Indirect relationship — dashed line</option>';
}

function syncReportingConnection(form) {
  const field = form.elements.namedItem('connectionType');
  const hasParent = Boolean(form.elements.namedItem('reportsTo').value);
  field.disabled = !hasParent;
  if (!hasParent) field.value = 'direct';
  const placement = form.elements.namedItem('placementLevel');
  if (placement) { placement.disabled = !hasParent; if (!hasParent) placement.value = '0'; }
}

function connectionValue(data, reportsTo) {
  return reportsTo && data.get('connectionType') === 'indirect' ? 'indirect' : 'direct';
}

function placementLevel(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 5 ? number : 0;
}

function placementField(person = []) {
  const level = person[10] ? placementLevel(person[14]) : 0;
  return '<label class="admin-wide">Placement level<select name="placementLevel" ' + (!person[10] ? 'disabled' : '') + '>' + Array.from({length:6}, (_, index) => '<option value="' + index + '" ' + (level === index ? 'selected' : '') + '>' + (index === 0 ? 'Standard row below supervisor' : index + (index === 1 ? ' level lower' : ' levels lower')) + '</option>').join('') + '</select><small class="hierarchy-note">Move this position and its reports lower without changing who it reports to.</small></label>';
}

function connectionField(person = []) {
  return '<label class="admin-wide">Connection type<select name="connectionType" ' + (!person[10] ? 'disabled' : '') + '>' + connectionOptions(person) + '</select><small class="hierarchy-note">Choose a Reports to position first. Indirect positions have their own dashed line from the supervisor, separate from the shared direct-report line.</small></label>';
}

function leadershipKeyMarkup(print = false) {
  return print
    ? '<div class="print-key-row leadership-key"><span class="leadership-swatch" aria-hidden="true"></span><strong>Leadership</strong></div><div class="print-key-row indirect-key"><span class="indirect-line-swatch" aria-hidden="true"></span><strong>Dashed line = indirect relationship</strong></div>'
    : '<div class="legend-item leadership-key"><span class="leadership-swatch" aria-hidden="true"></span><span><strong>Leadership</strong><small>Double inset border; category color stays the same</small></span></div><div class="legend-item indirect-key"><span class="indirect-line-swatch" aria-hidden="true"></span><span><strong>Indirect relationship</strong><small>Separate dashed line from the supervisor</small></span></div>';
}

document.head.insertAdjacentHTML('beforeend', '<style>.org-label-node{min-width:180px;padding:12px 20px;background:#e5f1f6;border:2px solid #0072a8;color:#003b5c;text-align:center;font-size:13px;font-weight:700;box-shadow:0 3px 10px #003b5c12}.node-vacant{border-style:dashed!important;background:#fffdf8}.node-vacant .vacant-avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:0;background:#f2b544;color:#000;font-weight:700}.vacant-badge{display:inline-block;margin:8px 0;padding:4px 7px;background:#fff0c2;color:#000;font-size:10px;font-weight:700;text-transform:uppercase}.position-state-note{font-size:10px;color:#52636b;margin-top:5px}.department-label-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;margin:7px 0;background:#f4f7f8;border:1px solid #d6e0e5;font-size:12px}.department-label-row strong{color:#003b5c}.admin-modal .admin-grid label[hidden]{display:none}</style>');

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

function orgLabelNodeMarkup(group) {
  const admin = window.orgAuthRole === 'admin';
  return `<button type="button" class="org-label-node" data-label-id="${esc(group.id)}" ${admin ? '' : 'disabled'} aria-label="${esc(admin ? 'Edit label: ' + group.name : group.name)}" onclick="selectOrgLabel('${esc(group.id)}')">${esc(group.name)}</button>`;
}

function selectOrgLabel(id) {
  requireAdmin(() => {
    if (!orgGroups.some(group => group.id === id && group.department === dept)) return;
    selected = {orgLabelId:id};
    render();
  });
}

function labelPlacementOptions(group) {
  const record = [];
  record[10] = group.reportsTo || '';
  record[14] = group.placementLevel;
  return placementField(record);
}

function orgLabelDetails(group) {
  const placement = placementLevel(group.reportsTo ? group.placementLevel : 0);
  const options = Array.from({length:6}, (_,index) => `<option value="${index}" ${index === placement ? 'selected' : ''}>${index === 0 ? 'Standard row below supervisor' : index + (index === 1 ? ' level lower' : ' levels lower')}</option>`).join('');
  return `<aside class="panel org-label-panel"><button type="button" class="close" onclick="selected=null;render()">×</button><h3>${esc(group.name)}</h3><div class="details-actions"><button type="button" class="text-button" onclick="showEditOrgLabel('${esc(group.id)}')">Edit label</button></div><label class="label-placement">Placement level<select name="labelPlacementLevel" ${group.reportsTo ? '' : 'disabled'} onchange="setOrgLabelPlacement('${esc(group.id)}',this.value)">${options}</select><small>Moves the label and its entire branch lower. Changes save automatically.</small></label>${branchOrderControls(group.id)}</aside>`;
}

function setOrgLabelPlacement(id, value) {
  requireAdmin(() => {
    const group = orgGroups.find(entry => entry.id === id && entry.department === dept);
    if (!group?.reportsTo) return;
    group.placementLevel = placementLevel(value);
    localStorage.setItem('org-chart-groups',JSON.stringify(orgGroups));
    selected = {orgLabelId:id};
    render();
  });
}

function syncLabelPlacement(form) {
  const field = form.elements.namedItem('placementLevel');
  field.disabled = !form.elements.namedItem('reportsTo').value;
  if (field.disabled) field.value = '0';
}

function showEditOrgLabel(id) {
  requireAdmin(() => {
    const group = orgGroups.find(entry => entry.id === id && entry.department === dept);
    if (!group) return;
    const parents = orgParentOptions(group.department,group.id,group.reportsTo || '');
    document.getElementById('modal').innerHTML = `<div class="modal"><form class="form admin-modal" onsubmit="saveEditedOrgLabel(event,'${esc(group.id)}')"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">${esc(group.department)} section</span><h2>Edit label</h2><div class="admin-grid"><label class="admin-wide">Label name<input name="labelName" value="${esc(group.name)}" required></label><label class="admin-wide">Reports to<select name="reportsTo" onchange="syncLabelPlacement(this.form)">${parents}</select></label>${labelPlacementOptions(group)}</div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Cancel</button><button class="primary">Save label</button></div></form></div>`;
  });
}

function saveEditedOrgLabel(event, id) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  requireAdmin(() => {
    const group = orgGroups.find(entry => entry.id === id && entry.department === dept);
    if (!group) return;
    const name = String(data.get('labelName') || '').trim();
    const reportsTo = String(data.get('reportsTo') || '');
    if (!name) { alert('Enter a section label.'); return; }
    if (orgGroups.some(entry => entry.id !== id && entry.department === group.department && entry.name.toLowerCase() === name.toLowerCase())) {
      alert('That label already exists in this department.'); return;
    }
    const validParent = people.some(person => person[0] === reportsTo && (person[3] === group.department || person[0] === 'ceo')) || orgGroups.some(entry => entry.id === reportsTo && entry.department === group.department);
    if (reportsTo && (!validParent || positionHasCycle(id,reportsTo))) {
      alert('Choose a valid parent that does not create a reporting loop.'); return;
    }
    if ((group.reportsTo || '') !== reportsTo) group.chartOrder = null;
    group.name = name;
    group.reportsTo = reportsTo;
    group.placementLevel = reportsTo ? placementLevel(data.get('placementLevel')) : 0;
    localStorage.setItem('org-chart-groups',JSON.stringify(orgGroups));
    selected = {orgLabelId:id};
    closeAdd();
    render();
  });
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
  if (selected?.orgLabelId === id) selected = null;
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
    document.getElementById('modal').innerHTML = `<div class="modal"><form class="form admin-modal" onsubmit="addManagedPosition(event)"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">${esc(dept)} positions</span><h2>Manage positions</h2><p>Add filled or vacant positions and organize them under reporting lines or section labels.</p><div class="admin-section"><h3>Add position</h3><div class="admin-grid"><label>Position status<select name="status" onchange="toggleVacancyFields(this)"><option value="filled">Filled position</option><option value="vacant">Vacant position</option></select><small class="position-state-note">Enter the employee details for this filled position.</small></label><label>Person name<input name="name" required></label><label>Position ID<input name="pid" required onchange="reuseEmployeeForPid(this)"><small class="employee-reuse-note">The same employee PID can be used in different department charts.</small></label><label class="admin-wide">Full position title<input name="title" required placeholder="e.g. Deputy Director"></label><label class="admin-wide">Department<input name="department" value="${esc(dept)}" readonly></label><label>Responsibility category<select name="level">${positionLevelOptions(dept, '')}</select></label><label>Chart appearance<select name="leadership">${leadershipOptions()}</select></label><label class="admin-wide">Reports to<select name="reportsTo" onchange="syncReportingConnection(this.form)">${parentOptions}</select><small class="hierarchy-note">Choose a position or section label. This node will connect underneath it.</small></label>${connectionField()}${placementField()}<label class="vacancy-optional">Email<input name="email" type="email" required></label><label class="vacancy-optional">Mobile phone<input name="phone"></label><label class="vacancy-optional">Desk phone<input name="desk"></label><label class="admin-wide vacancy-optional">Photo URL<input name="photo" placeholder="https://... or choose a file"></label><label class="admin-wide vacancy-optional">Or choose a photo file<input name="photoFile" type="file" accept="image/jpeg,image/png,image/webp"></label></div></div><section class="admin-section"><h3>Department labels / sections</h3><p>Add a heading such as “Inspection Area 5”; positions and nested labels can report to it.</p><div id="org-label-form" class="admin-grid"><label>Section label<input name="labelName" placeholder="e.g. Inspection Area 5"></label><label>Reports to<select name="labelParent">${parentOptions}</select></label><button type="button" class="primary" onclick="addDepartmentLabel()">Add section label</button></div>${departmentGroups.map((group) => `<div class="department-label-row"><span><strong>${esc(group.name)}</strong><small>${group.reportsTo ? ' · Nested section' : ' · Top-level section'}</small></span>${branchOrderButtons(group.id)}<button type="button" class="delete-admin" onclick="removeDepartmentLabel('${esc(group.id)}')">Delete label</button></div>`).join('') || '<p>No department labels yet.</p>'}</section><div class="admin-section"><h3>Delete position</h3>${departmentPeople.map((person) => `<div class="position-delete-row"><span>${person[11] ? `${esc(person[2])} · Vacant` : esc(person[1])} <small>${esc(person[5])}</small></span><button type="button" class="delete-admin" onclick="deleteManagedPosition('${esc(person[0])}')">Delete</button></div>`).join('') || '<p>No positions in this department yet.</p>'}</div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Close</button><button class="primary">Add position</button></div></form></div>`;
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
  if (pidExistsInDepartment(pid, dept)) { alert('That PID is already in use in this department. It can be reused in another department chart.'); return; }
  const id = `managed-${crypto.randomUUID()}`;
  const reportsTo = String(data.get('reportsTo') || '');
  const validParent = people.some((person) => person[0] === reportsTo && (person[3] === dept || person[0] === 'ceo')) || orgGroups.some((group) => group.id === reportsTo && group.department === dept);
  if (reportsTo && !validParent) { alert('Choose a parent position or section from this department.'); return; }
  const photo = vacant ? '' : await readImageFile(form.querySelector('[name="photoFile"]'), String(data.get('photo') || form.dataset.reusedPhoto || `https://i.pravatar.cc/160?u=${id}`));
  people.push([id, vacant ? 'Vacant' : String(data.get('name')).trim(), title, dept, String(data.get('level')), pid, vacant ? '' : String(data.get('phone') || ''), vacant ? '' : String(data.get('desk') || ''), vacant ? '' : email, photo, reportsTo, vacant, leadershipValue(data), connectionValue(data, reportsTo), reportsTo ? placementLevel(data.get('placementLevel')) : 0]);
  syncEmployeeDetails(people[people.length - 1]);
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
  return `<button class="node ${person[10] ? '' : 'node-top-level'} ${positionIsLeader(person) ? 'node-leader' : ''} ${vacant ? 'node-vacant' : ''}" data-position-id="${esc(person[0])}" style="border-left-color:${color}" onclick="selected=people.find(x=>x[0]==='${esc(person[0])}');render()">${vacant ? '<span class="vacant-avatar">V</span>' : `<img class="employee-photo" src="${esc(orgPhotoUrl(person[9]))}" alt="">`}<span class="node-copy"><strong>${esc(vacant ? person[2] : person[1])}</strong><span>${vacant ? 'Vacant' : esc(person[2])}</span><small>${esc(person[5])}</small></span></button>`;
}

function chartBranchOrder(entity) {
  const value = entity.type === 'person' ? entity.person[15] : entity.group.chartOrder;
  return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
}

function sortChartBranches(entities) {
  // Stable fallback retains existing order; new positions append after ordered ones.
  return [...entities].sort((a,b) => {
    const left = chartBranchOrder(a), right = chartBranchOrder(b);
    return left === right ? 0 : left < right ? -1 : 1;
  });
}

function branchOrderPeers(id) {
  if (!dept) return [];
  const entities = [
    ...people.filter(person => person[3] === dept || person[0] === 'ceo').map(person => ({id:person[0],parentId:person[10] || '',type:'person',person})),
    ...orgGroups.filter(group => group.department === dept).map(group => ({id:group.id,parentId:group.reportsTo || '',type:'group',group})),
  ];
  const entity = entities.find(entry => entry.id === id);
  if (!entity?.parentId || !entities.some(entry => entry.id === entity.parentId)) return [];
  const indirect = entry => entry.type === 'person' && entry.person[13] === 'indirect';
  return sortChartBranches(entities.filter(entry => entry.parentId === entity.parentId && indirect(entry) === indirect(entity)));
}

function branchOrderButtons(id) {
  if (window.orgAuthRole !== 'admin') return '';
  const peers = branchOrderPeers(id), index = peers.findIndex(entry => entry.id === id);
  if (index < 0) return '';
  return `<div class="branch-order-buttons"><button type="button" data-branch-move="left" ${index === 0 ? 'disabled' : ''} onclick="moveChartBranch('${esc(id)}', -1)">← Move left</button><button type="button" data-branch-move="right" ${index === peers.length - 1 ? 'disabled' : ''} onclick="moveChartBranch('${esc(id)}', 1)">Move right →</button></div>`;
}

function branchOrderControls(id) {
  const buttons = branchOrderButtons(id);
  return buttons ? `<div class="branch-order-controls"><strong>Branch order</strong>${buttons}<small>Moves this branch and its reports within the same reporting group. Changes save automatically.</small></div>` : '';
}

function moveChartBranch(id, direction) {
  requireAdmin(() => {
    if (direction !== -1 && direction !== 1) return;
    const peers = branchOrderPeers(id), index = peers.findIndex(entry => entry.id === id);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= peers.length) return;
    [peers[index],peers[next]] = [peers[next],peers[index]];
    let groupsChanged = false;
    peers.forEach((entity,order) => {
      if (entity.type === 'person') entity.person[15] = order;
      else { entity.group.chartOrder = order; groupsChanged = true; }
    });
    localStorage.setItem('org-chart-people',JSON.stringify(people));
    if (groupsChanged) localStorage.setItem('org-chart-groups',JSON.stringify(orgGroups));
    // Keep the contact card open; descendants follow their parent branch naturally.
    render();
    if (orgGroups.some(group => group.id === id) && selected?.orgLabelId !== id) showPositionAdmin();
  });
}


function combinedTreeBranch(entity, allEntities, nested = false) {
  const children = sortChartBranches(allEntities.filter((candidate) => candidate.parentId === entity.id));
  const indirect = children.filter(child => child.type === 'person' && child.person[13] === 'indirect');
  const direct = children.filter(child => !indirect.includes(child));
  const node = entity.type === 'group' ? orgLabelNodeMarkup(entity.group) : positionNodeMarkup(entity.person);
  const lower = nested ? placementLevel(entity.type === 'person' ? entity.person[14] : entity.group.placementLevel) * 122 : 0;
  return `<div class="tree-branch" data-entity-id="${esc(entity.id)}" style="margin-top:${lower}px"><div class="tree-main">${node}${direct.length ? `<div class="tree-children">${direct.map(child => combinedTreeBranch(child, allEntities, true)).join('')}</div>` : ''}</div>${indirect.length ? `<div class="tree-indirect-children">${indirect.map(child => combinedTreeBranch(child, allEntities, true)).join('')}</div>` : ''}</div>`;
}

function refreshOrgConnectors(container) {
  const branches = [...container.querySelectorAll('.tree-branch')];
  // Set side-branch spacing before measuring any paths, including nested sections.
  for (const branch of branches) {
    const node = branch.querySelector(':scope > .tree-main > .node, :scope > .tree-main > .org-label-node');
    const side = branch.querySelector(':scope > .tree-indirect-children');
    if (node && side) side.style.marginTop = `${node.offsetHeight + 40}px`;
  }
  for (const branch of branches) {
    const main = branch.querySelector(':scope > .tree-main');
    const node = main?.querySelector(':scope > .node, :scope > .org-label-node');
    if (!node) continue;
    const direct = [...(main.querySelector(':scope > .tree-children')?.children || [])];
    const indirect = [...(branch.querySelector(':scope > .tree-indirect-children')?.children || [])];
    branch.querySelector(':scope > .org-connectors')?.remove();
    if (!direct.length && !indirect.length) continue;
    const bounds = branch.getBoundingClientRect();
    const style = getComputedStyle(branch);
    const width = parseFloat(style.width), height = parseFloat(style.height);
    if (!(width > 0 && height > 0)) continue;
    const scaleX = bounds.width / width, scaleY = bounds.height / height;
    const rect = element => {
      const value = element.getBoundingClientRect();
      return {left:(value.left-bounds.left)/scaleX, right:(value.right-bounds.left)/scaleX, top:(value.top-bounds.top)/scaleY, bottom:(value.bottom-bounds.top)/scaleY, center:(value.left+value.width/2-bounds.left)/scaleX};
    };
    const parent = rect(node);
    const childNode = child => child.querySelector(':scope > .tree-main > .node, :scope > .tree-main > .org-label-node');
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('class','org-connectors'); svg.setAttribute('aria-hidden','true');
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const path = (d, kind, child) => {
      const line = document.createElementNS(svg.namespaceURI,'path');
      line.setAttribute('d',d); line.setAttribute('class',kind);
      if (child) line.setAttribute('data-child-id',child.dataset.entityId);
      svg.appendChild(line);
    };
    if (direct.length) {
      const bus = parent.bottom + 20;
      const targets = direct.map(child => rect(childNode(child)));
      path(`M ${parent.center} ${parent.bottom} V ${bus}`,'connector-direct-stem');
      const xs = [parent.center,...targets.map(target => target.center)];
      path(`M ${Math.min(...xs)} ${bus} H ${Math.max(...xs)}`,'connector-direct-bus');
      direct.forEach((child,index) => path(`M ${targets[index].center} ${bus} V ${targets[index].top}`,'connector-direct',child));
    }
    // Each dashed line starts on the supervisor's side and bypasses the solid bus.
    // Farther side branches leave higher on the box so their lines remain distinct.
    indirect.forEach((child,index) => {
      const target = rect(childNode(child));
      const port = parent.bottom - 12 - index * Math.min(8,(parent.bottom-parent.top-24)/Math.max(1,indirect.length-1));
      path(`M ${parent.right} ${port} H ${target.center} V ${target.top}`,'connector-indirect',child);
    });
    branch.appendChild(svg);
  }
}


orgTree = function(list) {
  const departmentGroups = orgGroups.filter((group) => group.department === dept);
  const entities = [
    ...list.map((person) => ({ id: person[0], parentId: person[10] || '', type: 'person', person })),
    ...departmentGroups.map((group) => ({ id: group.id, parentId: group.reportsTo || '', type: 'group', name: group.name, group })),
  ];
  const ids = new Set(entities.map((entity) => entity.id));
  const roots = entities.filter((entity) => !entity.parentId || !ids.has(entity.parentId));
  return sortChartBranches(roots).map((root) => combinedTreeBranch(root, entities)).join('') || '<div class="empty">No positions found</div>';
};

nodes = function(list) { return list.map(positionNodeMarkup).join('') || '<div class="empty">No positions found</div>'; };

details = function(person) {
  if (person.orgLabelId) {
    const group = orgGroups.find(entry => entry.id === person.orgLabelId);
    return group && window.orgAuthRole === 'admin' ? orgLabelDetails(group) : legend();
  }
  const vacant = Boolean(person[11]);
  const contacts = vacant ? '' : `<div><span>Mobile</span><b>${esc(person[6] || 'Not listed')}</b></div><div><span>Desk phone</span><b>${esc(person[7] || 'Not listed')}</b></div><div><span>Email</span><b>${esc(person[8] || 'Not listed')}</b></div>`;
  return `<aside class="panel"><button class="close" onclick="selected=null;render()">×</button>${person[9] ? `<img class="employee-photo" src="${esc(orgPhotoUrl(person[9]))}" alt="">` : ''}<h3>${esc(vacant ? person[2] : person[1])}</h3><p>${vacant ? '<span class="vacant-badge">Vacant</span><br>' : ''}<b>${esc(person[2])}</b><br>${esc(person[3])}</p><div class="details"><div><span>Position ID</span><b>${esc(person[5])}</b></div>${contacts}</div>${branchOrderControls(person[0])}<div class="details-actions"><button class="text-button" onclick="showEditPosition('${esc(person[0])}')">Edit position</button><button class="delete" onclick="requireAdmin(() => { if (confirm('Delete this position?')) { deleteManagedPosition('${esc(person[0])}'); selected=null; render(); } })">Delete position</button></div></aside>`;
};

function updateEditDepartmentWithGroups(select, id) {
  const person = people.find((entry) => entry[0] === id);
  if (!person) return;
  const form = select.form;
  form.querySelector('[name="level"]').innerHTML = positionLevelOptions(select.value, person[4]);
  form.querySelector('[name="reportsTo"]').innerHTML = orgParentOptions(select.value, id, '');
  syncReportingConnection(form);
}

showEditPosition = function(id) {
  requireAdmin(() => {
    const person = people.find((entry) => entry[0] === id);
    if (!person) return;
    const vacant = Boolean(person[11]);
    const parentOptions = orgParentOptions(person[3], person[0], person[10] || '');
    document.getElementById('modal').innerHTML = `<div class="modal"><form class="form admin-modal" data-position-id="${esc(id)}" onsubmit="saveEditedPosition(event, '${esc(id)}')"><button type="button" class="close" onclick="closeAdd()">×</button><span class="kicker">${esc(person[3])} position</span><h2>Edit position</h2><div class="admin-grid"><label>Position status<select name="status" onchange="toggleVacancyFields(this)"><option value="filled" ${vacant ? '' : 'selected'}>Filled position</option><option value="vacant" ${vacant ? 'selected' : ''}>Vacant position</option></select><small class="position-state-note">${vacant ? 'Contact fields are optional for a vacant position.' : 'Employee details are required.'}</small></label><label>Person name<input name="name" value="${esc(vacant ? 'Vacant' : person[1])}" ${vacant ? 'readonly' : 'required'}></label><label>Position ID<input name="pid" value="${esc(person[5])}" ${vacant ? '' : 'required'} onchange="reuseEmployeeForPid(this)"><small class="employee-reuse-note">The same employee PID can be used in different department charts.</small></label><label class="admin-wide">Full position title<input name="title" value="${esc(person[2])}" required></label><label>Department<select name="department" onchange="updateEditDepartmentWithGroups(this, '${esc(id)}')">${departmentOptions(person[3])}</select></label><label>Responsibility category<select name="level">${positionLevelOptions(person[3], person[4])}</select></label><label>Chart appearance<select name="leadership">${leadershipOptions(person)}</select></label><label class="admin-wide">Reports to<select name="reportsTo" onchange="syncReportingConnection(this.form)">${parentOptions}</select></label>${connectionField(person)}${placementField(person)}<label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Email<input name="email" type="email" value="${esc(person[8])}" ${vacant ? '' : 'required'}></label><label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Mobile phone<input name="phone" value="${esc(person[6])}"></label><label class="vacancy-optional" ${vacant ? 'hidden' : ''}>Desk phone<input name="desk" value="${esc(person[7])}"></label><label class="admin-wide vacancy-optional" ${vacant ? 'hidden' : ''}>Photo URL<input name="photo" value="${esc(person[9])}" placeholder="https://... or choose a file"></label><label class="admin-wide vacancy-optional" ${vacant ? 'hidden' : ''}>Or choose a new photo file<input name="photoFile" type="file" accept="image/jpeg,image/png,image/webp"></label></div><div class="admin-actions"><button type="button" class="cancel" onclick="closeAdd()">Cancel</button><button class="primary">Save position</button></div></form></div>`;
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
  if (pidExistsInDepartment(pid, String(data.get('department')), id)) { alert('That PID is already in use in this department. It can be reused in another department chart.'); return; }
  const department = String(data.get('department'));
  const reportsTo = String(data.get('reportsTo') || '');
  if (reportsTo && positionHasCycle(id, reportsTo)) { alert('That reporting line would create a loop. Choose a different parent.'); return; }
  const parentExists = people.some((entry) => entry[0] === reportsTo && (entry[3] === department || entry[0] === 'ceo')) || orgGroups.some((group) => group.id === reportsTo && group.department === department);
  if (reportsTo && !parentExists) { alert('Choose a parent position or section from this department.'); return; }
  const photo = vacant ? '' : await readImageFile(form.querySelector('[name="photoFile"]'), String(data.get('photo') || form.dataset.reusedPhoto || person[9]));
  if (person[3] !== department || (person[10] || '') !== reportsTo || (person[13] === 'indirect') !== (connectionValue(data, reportsTo) === 'indirect')) person[15] = null;
  person[1] = vacant ? 'Vacant' : String(data.get('name')).trim(); person[2] = String(data.get('title')).trim(); person[3] = department; person[4] = String(data.get('level')); person[5] = pid; person[6] = vacant ? '' : String(data.get('phone') || ''); person[7] = vacant ? '' : String(data.get('desk') || ''); person[8] = vacant ? '' : email; person[9] = photo; person[10] = reportsTo; person[11] = vacant; person[12] = leadershipValue(data); person[13] = connectionValue(data, reportsTo); person[14] = reportsTo ? placementLevel(data.get('placementLevel')) : 0;
  syncEmployeeDetails(person);
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


const categoryLegendMarkup = legend;
legend = function() {
  const markup = categoryLegendMarkup();
  const note = '<p style="margin-top:20px">';
  return markup.includes(note) ? markup.replace(note, leadershipKeyMarkup() + note) : markup.replace('</aside>', leadershipKeyMarkup() + '</aside>');
};

