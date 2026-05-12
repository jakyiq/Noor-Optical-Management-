/* admin.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function renderSuperAdmin() {
  if (NOOR.role !== 'super_admin') return;
  try {
    const data = await get('/api/admin/clinics');
    NOOR.clinics = data.data || [];
    _renderAdminClinicsTable(NOOR.clinics);
  } catch(e) { toast(e.message,'error'); }
}

function _renderAdminClinicsTable(clinics) {
  document.getElementById('admin-clinics-tbody').innerHTML = clinics.map(c => {
    const lic = c.license || {};
    const exp = lic.expires_at ? daysDiff(lic.expires_at) : null;
    const st  = !lic.is_active?'danger':exp!==null&&exp<0?'danger':exp!==null&&exp<7?'warning':'success';
    const sl  = !lic.is_active?'Inactive':exp!==null&&exp<0?'Expired':exp!==null&&exp<7?'Expiring Soon':'Active';
    const banned = !!c.is_banned;
    const daysLabel = exp === null ? '∞' : (exp >= 0 ? exp + 'd' : 'Expired');
    return `<tr>
      <td class="td-name">${esc(c.name)}</td>
      <td>${esc(c.owner_email || c.users?.[0]?.email || '')}</td>
      <td><span class="badge badge-burgundy">${esc(lic.plan || 'none')}</span></td>
      <td style="font-family:'Figtree','DM Sans',sans-serif;font-size:.82rem">${esc(lic.expires_at||'Lifetime')}</td>
      <td style="font-family:'Figtree','DM Sans',sans-serif;font-size:.82rem;color:${exp!==null&&exp<7?'var(--danger)':'inherit'}">${daysLabel}</td>
      <td><span class="badge badge-${banned?'danger':st}">${banned?'Banned':sl}</span></td>
      <td class="td-actions-cell" style="display:flex;gap:5px;flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" onclick="openManageSubscription('${escAttr(c.id)}','${escAttr(c.name)}','${escAttr(lic.plan||'')}','${escAttr(lic.expires_at||'')}')">Subscription</button>
        <button class="btn btn-outline btn-sm" onclick="impersonateClinic('${escAttr(c.id)}')">Impersonate</button>
        <button class="btn btn-outline btn-sm" onclick="toggleClinicBan('${escAttr(c.id)}', ${!banned})">${banned?'Unban':'Ban'}</button>
        <button class="btn btn-outline btn-sm" onclick="backupClinic('${escAttr(c.id)}')">Backup</button>
        <button class="btn btn-sm" style="color:var(--danger);border:1.5px solid #fecaca;background:transparent" onclick="deleteClinic('${escAttr(c.id)}')">Delete</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--ink-light)">No clinics found</td></tr>`;
}

function filterAdminClinics() {
  const plan   = document.getElementById('admin-plan-filter')?.value || '';
  const status = document.getElementById('admin-status-filter')?.value || '';
  const q      = (document.getElementById('admin-clinic-search')?.value || '').toLowerCase();
  const filtered = (NOOR.clinics || []).filter(c => {
    const lic  = c.license || {};
    const exp  = lic.expires_at ? daysDiff(lic.expires_at) : null;
    const banned = !!c.is_banned;
    if (plan && lic.plan !== plan) return false;
    if (status) {
      if (status === 'banned' && !banned) return false;
      if (status === 'active' && (banned || (exp !== null && exp < 0))) return false;
      if (status === 'expiring' && (exp === null || exp < 0 || exp >= 7)) return false;
      if (status === 'expired' && (exp === null || exp >= 0)) return false;
    }
    if (q) {
      const hay = (c.name + ' ' + (c.owner_email||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  _renderAdminClinicsTable(filtered);
}

function openManageSubscription(cid, name, plan, expiresAt) {
  document.getElementById('sub-clinic-name').textContent = name;
  document.getElementById('sub-current-plan').textContent = plan || 'none';
  document.getElementById('sub-expires-info').textContent = expiresAt ? 'Expires: ' + expiresAt : 'No expiry';
  const planSel = document.getElementById('sub-new-plan');
  planSel.value = (['trial','monthly','quarterly','yearly','lifetime','custom'].includes(plan)) ? plan : 'monthly';
  document.getElementById('sub-notes').value = '';
  document.getElementById('sub-starts-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('sub-custom-date').value = expiresAt || '';
  onSubPlanChange();
  planSel.dataset.cid = cid;
  openModal('modal-subscription');
}

function onSubPlanChange() {
  const v = document.getElementById('sub-new-plan').value;
  const expRow = document.getElementById('sub-custom-date-row');
  expRow.style.display = (v === 'lifetime') ? 'none' : '';
  document.getElementById('sub-custom-date').required = (v === 'custom');
}

async function saveSubscription() {
  const cid    = document.getElementById('sub-new-plan').dataset.cid;
  const plan   = document.getElementById('sub-new-plan').value;
  const notes  = document.getElementById('sub-notes').value.trim();
  const starts = document.getElementById('sub-starts-date').value;
  const expiry = document.getElementById('sub-custom-date').value;

  if (!starts) { toast('Please set a start date', 'error'); return; }

  const body = { plan, notes, starts_at: starts };

  if (plan === 'custom') {
    if (!expiry) { toast('Please set an expiry date for the custom plan', 'error'); return; }
    if (expiry <= starts) { toast('Expiry date must be after the start date', 'error'); return; }
    body.expires_at = expiry;
  } else if (plan !== 'lifetime' && expiry) {
    body.expires_at = expiry;
  }

  try {
    const res = await put('/api/admin/licenses/' + cid, body);
    const d = res && res.data ? res.data : {};
    toast('Subscription updated — expires: ' + (d.expires_at || 'never'), 'success');
    closeModal('modal-subscription');
    await renderSuperAdmin();
  } catch(e) { toast(e.message, 'error'); }
}

function openAddClinic() { openModal('modal-clinic'); }

async function saveClinic() {
  const name = document.getElementById('nc-name').value; if(!name){toast('Name required','error');return;}
  try {
    await post('/api/admin/clinics', {
      name, phone: document.getElementById('nc-phone').value,
      owner_email: document.getElementById('nc-email').value,
      doctor_username: document.getElementById('nc-user').value,
      doctor_password: document.getElementById('nc-pass').value,
      plan: document.getElementById('nc-plan').value,
    });
    closeModal('modal-clinic'); toast('Clinic added'); await renderSuperAdmin();
  } catch(e) { toast(e.message,'error'); }
}

async function toggleClinicBan(cid, banned) {
  const reason = banned ? prompt('Ban reason?') || 'Manual ban' : '';
  try {
    await put(`/api/admin/clinics/${cid}`, { is_banned: banned, banned_reason: reason });
    toast(banned ? 'Clinic banned' : 'Clinic unbanned');
    await renderSuperAdmin();
  } catch(e) { toast(e.message,'error'); }
}

async function deleteClinic(cid) {
  if (!confirm('Delete this clinic and all its data?')) return;
  try {
    await del(`/api/admin/clinics/${cid}`);
    toast('Clinic deleted');
    await renderSuperAdmin();
  } catch(e) { toast(e.message,'error'); }
}

async function backupClinic(cid) {
  try {
    const data = await post(`/api/admin/clinics/${cid}/backup`, {});
    const blob = new Blob([JSON.stringify(data.data.backup, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `noor-backup-${cid}-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Backup created');
  } catch(e) { toast(e.message,'error'); }
}

async function impersonateClinic(cid) {
  try {
    const data = await post(`/api/admin/impersonate/${cid}`);
    NOOR.clinicName = data.data?.clinic?.name || '';
    NOOR.clinicId   = cid;
    document.getElementById('sidebar-clinic-name').textContent = NOOR.clinicName;
    toast(`Impersonating: ${NOOR.clinicName}`, 'warning');
    navigate('dashboard');
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// CHANGE PASSWORD
// ══════════════════════════════════════════════════════════
