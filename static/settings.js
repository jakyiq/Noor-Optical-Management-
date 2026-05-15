/* settings.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function renderSettings() {
  try {
    const data = await get('/api/settings');
    const cl = data.data?.clinic || {};
    const st = data.data?.settings || {};
    NOOR.settings = st;
    NOOR.clinicName = cl.name || NOOR.clinicName;
    document.getElementById('sidebar-clinic-name').textContent = NOOR.clinicName;
    document.getElementById('set-clinic-name').value    = cl.name||'';
    document.getElementById('set-clinic-phone').value   = cl.phone||'';
    document.getElementById('set-clinic-address').value = cl.address||'';
    document.getElementById('set-clinic-logo').value    = cl.logo_url||'';
    document.getElementById('set-print-header').value   = st.print_header_text||'';
    // set-print-cert removed — credentials now go to set-print-doctor-cred
    document.getElementById('set-print-warning').value  = st.print_warning_text||'';
    document.getElementById('set-default-checkup-fee').value = st.default_checkup_fee||0;
    document.getElementById('set-print-financials').checked = st.print_show_financials !== false;
    // New print fields
    document.getElementById('set-print-doctor-name').value = st.print_doctor_name||'';
    document.getElementById('set-print-doctor-cred').value = st.print_doctor_credentials||'';
    document.getElementById('set-print-logo-align').value  = st.print_logo_align||'center';
    document.getElementById('set-print-logo-w').value      = st.print_logo_width||120;
    document.getElementById('set-print-logo-h').value      = st.print_logo_height||60;
    if (st.print_logo_data) {
      const prev = document.getElementById('set-print-logo-preview');
      const img  = document.getElementById('set-print-logo-img');
      if (prev && img) { img.src = st.print_logo_data; prev.style.display='block'; }
    }
    if (st.print_qr_data) {
      const prev = document.getElementById('set-print-qr-preview');
      const img  = document.getElementById('set-print-qr-img');
      if (prev && img) { img.src = st.print_qr_data; prev.style.display='block'; }
    }
    _renderAssociateRows(JSON.parse(st.print_associates||'[]'));
    document.getElementById('wa-tpl-1').value = st.wa_template_1||'';
    document.getElementById('wa-tpl-2').value = st.wa_template_2||'';
    document.getElementById('wa-tpl-3').value = st.wa_template_3||'';
    // PDF message settings
    const pdfSend = st.wa_pdf_send_message !== false;
    document.getElementById('wa-pdf-send-message').checked = pdfSend;
    document.getElementById('wa-pdf-msg-wrap').style.opacity = pdfSend ? '1' : '.4';
    document.getElementById('wa-pdf-message').value = st.wa_pdf_message||'';
    document.getElementById('set-followup-months').value = st.followup_months_default||3;
    NOOR.waTemplates = { wa_template_1: st.wa_template_1||'', wa_template_2: st.wa_template_2||'', wa_template_3: st.wa_template_3||'' };
    renderPermissionsToggles();
    renderUsersTable(); // non-blocking — runs in parallel with the rest of settings render
  } catch(e) { toast(e.message,'error'); }
}

function switchSettingsTab(tab) {
  const tabs = ['clinic','whatsapp','permissions','users','followup-defaults','print','appearance','backup'];
  tabs.forEach(t2 => {
    document.getElementById(`settings-tab-${t2}`)?.classList.toggle('active', t2===tab);
  });
  document.querySelectorAll('#settings-tabs .tab-btn').forEach((btn,i) => {
    btn.classList.toggle('active', tabs[i]===tab);
  });
  if (tab === 'backup') openBackupTab();
  if (tab === 'print') _initRxSchemePicker();
  if (tab === 'appearance') _initSiteThemePicker();
}

// ── Site theme ──────────────────────────────────────────────
function applySiteTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || '');
  localStorage.setItem('noor_site_theme', theme || '');
  document.querySelectorAll('#site-theme-grid .site-theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });
}
function _initSiteThemePicker() {
  const saved = localStorage.getItem('noor_site_theme') || '';
  document.querySelectorAll('#site-theme-grid .site-theme-option').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === saved);
  });
}
(function(){
  const t = localStorage.getItem('noor_site_theme') || '';
  if (t) document.documentElement.setAttribute('data-theme', t);
})();

// ── RX Color Scheme ─────────────────────────────────────────
function _initRxSchemePicker() {
  const saved = localStorage.getItem('noor_rx_scheme') || 'burgundy';
  const radio = document.querySelector(`input[name="rx-scheme"][value="${saved}"]`);
  if (radio) radio.checked = true;
  document.querySelectorAll('input[name="rx-scheme"]').forEach(r => {
    r.addEventListener('change', () => {
      localStorage.setItem('noor_rx_scheme', r.value);
      document.documentElement.setAttribute('data-rx-scheme', r.value);
    });
  });
}
function _getRxScheme() {
  return localStorage.getItem('noor_rx_scheme') || 'burgundy';
}


function renderPermissionsToggles() {
  const perms = [
    {key:'recept_view_patients',   ar:'عرض المراجعين',          en:'View Patients'},
    {key:'recept_edit_patients',   ar:'إضافة/تعديل المراجعين',  en:'Add/Edit Patients'},
    {key:'recept_view_financials', ar:'عرض المالية',          en:'View Financials'},
    {key:'recept_edit_financials', ar:'تعديل المالية',        en:'Edit Financials'},
    {key:'recept_access_inventory',ar:'الوصول للمخزون',       en:'Access Inventory'},
    {key:'recept_export_reports',  ar:'تصدير التقارير',       en:'Export Reports'},
    {key:'recept_view_audit',      ar:'عرض سجل التدقيق',     en:'View Audit Log'},
  ];
  document.getElementById('permissions-toggles').innerHTML = perms.map(p => `
    <div class="toggle-row">
      <div class="toggle-label">${NOOR.lang==='ar'?p.ar:p.en}</div>
      <label class="toggle-switch"><input type="checkbox" id="perm-${p.key}" ${NOOR.settings[p.key]?'checked':''}><span class="toggle-slider"></span></label>
    </div>
  `).join('');
}

async function savePermissions() {
  const body = {};
  ['recept_view_patients','recept_edit_patients','recept_view_financials','recept_edit_financials','recept_access_inventory','recept_export_reports','recept_view_audit'].forEach(k => {
    const el = document.getElementById(`perm-${k}`); if(el) body[k]=el.checked;
  });
  try { await put('/api/settings', body); toast(t('successSaved')); } catch(e) { toast(e.message,'error'); }
}

async function saveClinicSettings() {
  const body = {
    name:     document.getElementById('set-clinic-name').value,
    phone:    document.getElementById('set-clinic-phone').value,
    address:  document.getElementById('set-clinic-address').value,
    logo_url: document.getElementById('set-clinic-logo').value,
  };
  try {
    await put('/api/settings', body);
    NOOR.clinicName = body.name || NOOR.clinicName;
    document.getElementById('sidebar-clinic-name').textContent = NOOR.clinicName;
    toast(t('successSaved'));
  } catch(e) { toast(e.message,'error'); }
}

async function saveWATemplates() {
  const body = {
    wa_template_1: document.getElementById('wa-tpl-1').value,
    wa_template_2: document.getElementById('wa-tpl-2').value,
    wa_template_3: document.getElementById('wa-tpl-3').value,
  };
  try {
    await put('/api/settings', body);
    NOOR.waTemplates = body;
    toast(t('successSaved'));
  } catch(e) { toast(e.message,'error'); }
}

async function saveWAPdfSettings() {
  const body = {
    wa_pdf_send_message: document.getElementById('wa-pdf-send-message').checked,
    wa_pdf_message:      document.getElementById('wa-pdf-message').value,
  };
  try {
    await put('/api/settings', body);
    Object.assign(NOOR.settings, body);
    toast(t('successSaved'));
  } catch(e) { toast(e.message,'error'); }
}

async function savePrintSettings() {
  const body = {
    print_header_text:        document.getElementById('set-print-header').value,
    print_certification_text: document.getElementById('set-print-cert')?.value || '',
    print_warning_text:       document.getElementById('set-print-warning').value,
    default_checkup_fee:      parseFloat(document.getElementById('set-default-checkup-fee').value)||0,
    print_show_financials:    document.getElementById('set-print-financials').checked,
    // New fields
    print_doctor_name:        document.getElementById('set-print-doctor-name').value,
    print_doctor_credentials: document.getElementById('set-print-doctor-cred').value,
    print_logo_align:         document.getElementById('set-print-logo-align').value,
    print_logo_width:         parseInt(document.getElementById('set-print-logo-w').value)||120,
    print_logo_height:        parseInt(document.getElementById('set-print-logo-h').value)||60,
    print_logo_data:          (NOOR.settings._pendingLogoData !== undefined
                                 ? NOOR.settings._pendingLogoData
                                 : NOOR.settings.print_logo_data) || '',
    print_qr_data:            (NOOR.settings._pendingQrData !== undefined
                                 ? NOOR.settings._pendingQrData
                                 : NOOR.settings.print_qr_data) || '',
    print_associates:         JSON.stringify(_collectAssociateRows()),
  };
  // Clear pending staging
  delete NOOR.settings._pendingLogoData;
  delete NOOR.settings._pendingQrData;
  try {
    await put('/api/settings', body);
    Object.assign(NOOR.settings, body);
    toast(t('successSaved'));
  } catch(e) { toast(e.message,'error'); }
}

function handlePrintLogoUpload(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const data = e.target.result;
    NOOR.settings._pendingLogoData = data;
    const img  = document.getElementById('set-print-logo-img');
    const prev = document.getElementById('set-print-logo-preview');
    if (img)  img.src = data;
    if (prev) prev.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function handlePrintQrUpload(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const data = e.target.result;
    NOOR.settings._pendingQrData = data;
    const img  = document.getElementById('set-print-qr-img');
    const prev = document.getElementById('set-print-qr-preview');
    if (img)  img.src = data;
    if (prev) prev.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function clearPrintLogo() {
  NOOR.settings._pendingLogoData = '';
  const prev = document.getElementById('set-print-logo-preview');
  if (prev) prev.style.display = 'none';
  const inp = document.getElementById('set-print-logo-file');
  if (inp) inp.value = '';
}

function clearPrintQr() {
  NOOR.settings._pendingQrData = '';
  const prev = document.getElementById('set-print-qr-preview');
  if (prev) prev.style.display = 'none';
  const inp = document.getElementById('set-print-qr-file');
  if (inp) inp.value = '';
}

function _collectAssociateRows() {
  const rows = document.querySelectorAll('#associates-list .associate-row');
  return Array.from(rows).map(row => ({
    name:    row.querySelector('.assoc-name')?.value  || '',
    role:    row.querySelector('.assoc-role')?.value  || '',
    phone:   row.querySelector('.assoc-phone')?.value || '',
    address: row.querySelector('.assoc-addr')?.value  || '',
  })).filter(a => a.name || a.phone || a.address);
}

function _renderAssociateRows(associates) {
  const container = document.getElementById('associates-list');
  if (!container) return;
  container.innerHTML = '';
  (associates || []).forEach(a => _addAssociateRowWith(a));
}

function addAssociateRow() { _addAssociateRowWith({}); }

function _addAssociateRowWith(a) {
  const container = document.getElementById('associates-list');
  const div = document.createElement('div');
  div.className = 'associate-row';
  div.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:6px;align-items:center';
  div.innerHTML = `
    <input type="text" class="form-input assoc-name"  placeholder="Name"    value="${escAttr(a.name||'')}">
    <input type="text" class="form-input assoc-role"  placeholder="Role"    value="${escAttr(a.role||'')}">
    <input type="text" class="form-input assoc-phone" placeholder="Phone"   value="${escAttr(a.phone||'')}">
    <input type="text" class="form-input assoc-addr"  placeholder="Address" value="${escAttr(a.address||'')}">
    <button class="btn btn-outline btn-sm" onclick="this.closest('.associate-row').remove()" type="button" style="padding:4px 8px;color:var(--burgundy)">✕</button>
  `;
  container.appendChild(div);
}

async function saveFollowupDefaults() {
  const body = { followup_months_default: parseInt(document.getElementById('set-followup-months').value)||3 };
  try { await put('/api/settings', body); toast(t('successSaved')); } catch(e) { toast(e.message,'error'); }
}

async function renderUsersTable() {
  try {
    const data = await get('/api/users');
    NOOR.users = data.data || [];
    document.getElementById('users-tbody').innerHTML = NOOR.users.map(u => `<tr>
      <td class="td-name">${esc(u.full_name)}</td>
      <td data-label="${t('username')}" style="font-family:'Figtree','DM Sans',sans-serif">${esc(u.username)}</td>
      <td data-label="${t('role')}"><span class="badge badge-${u.role==='doctor'?'burgundy':'neutral'}">${t(u.role)}</span></td>
      <td data-label="${t('status')}"><span class="badge badge-${u.is_active?'success':'danger'}">${u.is_active?(NOOR.lang==='ar'?'نشط':'Active'):(NOOR.lang==='ar'?'معطل':'Disabled')}</span></td>
      <td class="td-actions-cell"><button class="btn btn-outline btn-sm" onclick="toggleUserActive('${escAttr(u.id)}',${!u.is_active})">${u.is_active?(NOOR.lang==='ar'?'تعطيل':'Disable'):(NOOR.lang==='ar'?'تفعيل':'Enable')}</button> <button class="btn btn-outline btn-sm" onclick="openResetUserPassword('${escAttr(u.id)}','${escAttr(u.full_name)}')">${NOOR.lang==='ar'?'إعادة تعيين كلمة المرور':'Reset Password'}</button></td>
    </tr>`).join('');
  } catch(_){}
}

function openAddUser() {
  ['u-name','u-username','u-password'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('u-role').value = 'receptionist';
  openModal('modal-user');
}

async function saveUser() {
  const name  = document.getElementById('u-name').value;
  const uname = document.getElementById('u-username').value;
  const pass  = document.getElementById('u-password').value;
  if (!name||!uname||!pass) { toast(t('errorRequired'),'error'); return; }
  if (pass.length < 8) { toast(NOOR.lang==='ar'?'كلمة المرور يجب أن تكون 8 أحرف على الأقل':'Min 8 characters', 'error'); return; }
  try {
    await post('/api/users', { full_name:name, username:uname, password:pass, role:document.getElementById('u-role').value });
    closeModal('modal-user'); toast(t('successSaved')); await renderUsersTable();
  } catch(e) { toast(e.message,'error'); }
}

async function toggleUserActive(id, active) {
  try { await put(`/api/users/${id}`, { is_active: active }); await renderUsersTable(); } catch(e) { toast(e.message,'error'); }
}

function openResetUserPassword(userId, fullName) {
  document.getElementById('reset-user-pw-title').textContent =
    (NOOR.lang === 'ar' ? 'إعادة تعيين كلمة مرور: ' : 'Reset Password: ') + fullName;
  document.getElementById('reset-user-pw').value = '';
  document.getElementById('reset-user-pw-confirm').value = '';
  document.getElementById('reset-user-pw').dataset.userId = userId;
  openModal('modal-reset-user-password');
}

async function saveResetUserPassword() {
  const userId = document.getElementById('reset-user-pw').dataset.userId;
  const pw     = document.getElementById('reset-user-pw').value;
  const conf   = document.getElementById('reset-user-pw-confirm').value;
  if (!pw || pw.length < 8) { toast(NOOR.lang==='ar'?'كلمة المرور يجب أن تكون 6 أحرف على الأقل':'Min 8 characters', 'error'); return; }
  if (pw !== conf)           { toast(NOOR.lang==='ar'?'كلمتا المرور غير متطابقتين':'Passwords do not match', 'error'); return; }
  try {
    await post(`/api/users/${userId}/reset-password`, { password: pw });
    closeModal('modal-reset-user-password');
    toast(NOOR.lang==='ar'?'تم إعادة تعيين كلمة المرور':'Password reset successfully', 'success');
  } catch(e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════
// AUDIT LOG
// ══════════════════════════════════════════════════════════
async function renderAuditLog() {
  const from   = document.getElementById('audit-from').value;
  const to     = document.getElementById('audit-to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to)   params.set('to', to);
  try {
    const data = await get('/api/audit?' + params.toString());
    const rows = data.data || [];
    document.getElementById('audit-tbody').innerHTML = rows.map(a => `<tr>
      <td class="td-name" style="font-size:.9rem">${esc(a.username||a.full_name)} · <span class="audit-action audit-${escAttr(a.action)}">${esc(a.action)}</span></td>
      <td data-label="${t('timestamp')}" style="font-family:'Figtree','DM Sans',sans-serif;font-size:.82rem">${new Date(a.created_at).toLocaleString(NOOR.lang==='ar'?'ar-IQ':'en-GB')}</td>
      <td data-label="${t('entity')}">${esc(a.entity_type)}</td>
      <td data-label="${t('details')}" style="font-size:.85rem;color:var(--ink-mid)">${esc(a.details)}</td>
    </tr>`).join('');
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// SUPER ADMIN
// ══════════════════════════════════════════════════════════
