/* patients.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function renderPatients() {
  const cached = getCachedApiData('/api/patients?limit=200');
  if (cached?.data) {
    setPatients(cached.data || []);
    document.getElementById('patients-total').textContent = cached.total || NOOR.patients.length;
    filterPatients();
  } else {
    const tbody = document.getElementById('patients-tbody');
    const empty = document.getElementById('patients-empty');
    if (tbody) tbody.innerHTML = skeletonRows(6, 6);
    if (empty) empty.style.display = 'none';
  }
  try {
    const data = await get('/api/patients?limit=200');
    setPatients(data.data || []);
    NOOR._patientsCachedAt = Date.now();
    document.getElementById('patients-total').textContent = data.total || NOOR.patients.length;
    filterPatients();
  } catch(e) { toast(e.message, 'error'); }
}

function filterPatients() {
  const q = (document.getElementById('patients-search')?.value || '').toLowerCase();
  const g = document.getElementById('patients-gender-filter')?.value || '';
  const list = NOOR.patients.filter(p => {
    if (q && !p.full_name.toLowerCase().includes(q) && !(p.phone||'').includes(q)) return false;
    if (g && p.gender !== g) return false;
    return true;
  });
  const tbody = document.getElementById('patients-tbody');
  const empty = document.getElementById('patients-empty');
  if (!list.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = list.map(p => {
    return `<tr>
      <td class="td-name" onclick="openPatientDetail('${escAttr(p.id)}')">${esc(p.full_name)}</td>
      <td class="td-phone" data-label="${t('phone')}">${esc(p.phone)}</td>
      <td data-label="${t('age')}">${esc(p.age)}</td>
      <td data-label="${t('lastVisit')}">${fmtDate(p.updated_at)}</td>
      <td data-label="${t('remaining')}"><span class="debt-pill ${(parseFloat(p.outstanding_remaining)||0)>0?'':'clear'}">${(parseFloat(p.outstanding_remaining)||0)>0?fmtNum(p.outstanding_remaining):'0'}</span></td>
      <td class="td-actions-cell">
        <button class="btn btn-burgundy btn-sm" onclick="openPatientDetail('${escAttr(p.id)}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          ${t('edit')}
        </button>
        <button class="btn btn-sm" style="color:var(--danger);border:1.5px solid #fecaca;background:transparent" onclick="deletePatient('${escAttr(p.id)}')">${t('delete')}</button>
      </td>
    </tr>`;
  }).join('');
}

async function openPatientDetail(pid) {
  NOOR.editingPatientId = pid;
  const p = getPatient(pid) || {};
  // Always ensure we are on the patients section
  if (NOOR.currentSection !== 'patients') {
    navigate('patients');
    // Wait for patients to load before showing detail
    await renderPatients();
  }
  document.getElementById('patients-list-view').style.display = 'none';
  document.getElementById('patients-detail-view').style.display = 'block';
  document.getElementById('patient-detail-name').textContent  = p.full_name || '—';
  document.getElementById('patient-detail-name2').textContent = p.full_name || '—';
  document.getElementById('patient-detail-info').textContent  = `${p.phone||''} • ${p.age?p.age+(NOOR.lang==='ar'?' سنة':' yrs'):''}`;
  try {
    const data = await get(`/api/patients/${pid}`);
    const patient = data.data || {};
    const visits = data.data?.visits || [];
    NOOR._currentPatientDetail = patient;
    document.getElementById('patient-detail-name').textContent  = patient.full_name || '—';
    document.getElementById('patient-detail-name2').textContent = patient.full_name || '—';
    document.getElementById('patient-detail-info').textContent  = `${patient.phone||''} • ${patient.age?patient.age+(NOOR.lang==='ar'?' سنة':' yrs'):''}`;
    renderPatientSummary(patient, visits);
    renderVisitHistory(visits);
  } catch(e) { toast(e.message,'error'); }
}

function rxPart(v, eye) {
  const prefix = eye === 'od' ? 'od' : 'os';
  return `SPH ${v[`${prefix}_sphere`] ?? '—'} CYL ${v[`${prefix}_cylinder`] ?? '—'} AX ${v[`${prefix}_axis`] ?? '—'}`;
}

function renderPatientSummary(p, visits) {
  const latest = visits[0] || {};
  const outstanding = visits.reduce((sum, v) => sum + (parseFloat(v.remaining) || 0), 0);
  const latestRx = latest.id ? `OD ${rxPart(latest,'od')} | OS ${rxPart(latest,'os')}` : '—';
  const latestLens = latest.id ? [latest.lens_type, latest.lens_material, latest.lens_coating].filter(Boolean).map(x=>String(x).replace(/_/g,' ')).join(' · ') || '—' : '—';
  const latestFrame = latest.id ? [latest.frame_brand, latest.frame_type].filter(Boolean).map(x=>String(x).replace(/_/g,' ')).join(' · ') || '—' : '—';
  const nextVisit = visits.find(v => v.next_visit_date)?.next_visit_date;
  document.getElementById('patient-summary').innerHTML = `
    <div class="patient-summary-grid">
      <div class="patient-summary-card"><div class="patient-summary-label">${t('outstandingDebt')}</div><div class="patient-summary-value ${outstanding>0?'danger':''}">${fmtIQD(outstanding)}</div><div class="patient-summary-sub">${visits.length} ${t('visits')}</div></div>
      <div class="patient-summary-card"><div class="patient-summary-label">${t('latestVisit')}</div><div class="patient-summary-value">${latest.visit_date?fmtDate(latest.visit_date):'—'}</div><div class="patient-summary-sub">${nextVisit?`${t('nextVisit')}: ${fmtDate(nextVisit)}`:''}</div></div>
      <div class="patient-summary-card"><div class="patient-summary-label">RX</div><div class="patient-summary-value" style="font-size:.86rem">${esc(latestRx)}</div><div class="patient-summary-sub">IPD: ${esc(latest.ipd||'—')}</div></div>
      <div class="patient-summary-card"><div class="patient-summary-label">${t('lensType')} / ${t('frame')}</div><div class="patient-summary-value" style="font-size:.86rem">${esc(latestLens)}</div><div class="patient-summary-sub">${esc(latestFrame)}</div></div>
    </div>
    <div class="patient-detail-actions">
      ${outstanding>0?`<button class="btn btn-gold" onclick="topUpPatientRemaining()">${t('topUpRemaining')}: ${fmtIQD(outstanding)}</button>`:''}
      ${latest.id?`<button class="btn btn-outline" onclick="showRxSlip('${escAttr(latest.id)}')">${t('printA5')}</button>`:''}
      ${latest.id && p.phone?`<button class="wa-btn" onclick="sendRxWhatsApp('${escAttr(latest.id)}','${escAttr(p.phone||'')}','${escAttr(p.full_name||'')}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg> Send Rx via WhatsApp</button>`:''}
    </div>
  `;
}

function renderVisitHistory(visits) {
  const cont = document.getElementById('patient-visit-history');
  if (!visits.length) {
    cont.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M14 2H6a2 2 0 00-2 2v16"/></svg><h3>${t('noPatients')}</h3></div>`;
    return;
  }
  cont.innerHTML = visits.map((v,i) => `
    <div class="visit-card">
      <div class="visit-card-header" onclick="toggleVisit('vc${v.id}')">
        <div>
          <span style="font-weight:700">${fmtDate(v.visit_date)}</span>
          ${v.lens_type===null && (parseFloat(v.total_amount)||0)===0 ? `<span class="badge badge-neutral" style="margin:0 8px">${NOOR.lang==='ar'?'وصفة قديمة':'Old Rx'}</span>` : `<span style="margin:0 10px;color:var(--ink-light)">${esc((v.lens_type||'').replace(/_/g,' '))}</span>`}
          ${v.remaining>0?`<span class="badge badge-danger">${fmtNum(v.remaining)} IQD ${t('remaining')}</span>`:`<span class="badge badge-success">Paid</span>`}
        </div>
        <span style="font-family:'Figtree','DM Sans',sans-serif;font-size:.9rem;color:var(--ink-mid)">${fmtNum(v.total_amount)} IQD</span>
      </div>
      <div class="visit-card-body${i===0 && !(v.lens_type===null && (parseFloat(v.total_amount)||0)===0) ? ' open':''}" id="vc${v.id}">
        <div class="visit-body-grid">
          <div>
            <div style="font-size:.72rem;font-weight:700;color:var(--ink-light);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Rx</div>
            <table style="border-collapse:collapse;font-size:.82rem;font-family:'Figtree','DM Sans',sans-serif">
              <thead><tr>${['Eye','SPH','CYL','AXIS','ADD','VA'].map(h=>`<th style="padding:4px 8px;border:1px solid var(--cream-border);background:var(--cream);font-size:.65rem">${h}</th>`).join('')}</tr></thead>
              <tbody>
                <tr><td style="padding:4px 8px;border:1px solid var(--cream-border);color:var(--burgundy);font-weight:700">OD</td>${[v.od_sphere,v.od_cylinder,v.od_axis,v.od_addition,v.od_va].map(x=>`<td style="padding:4px 8px;border:1px solid var(--cream-border)">${esc(x ?? '—')}</td>`).join('')}</tr>
                <tr><td style="padding:4px 8px;border:1px solid var(--cream-border);color:var(--burgundy);font-weight:700">OS</td>${[v.os_sphere,v.os_cylinder,v.os_axis,v.os_addition,v.os_va].map(x=>`<td style="padding:4px 8px;border:1px solid var(--cream-border)">${esc(x ?? '—')}</td>`).join('')}</tr>
              </tbody>
            </table>
            <div style="font-size:.8rem;color:var(--ink-light);margin-top:8px">Lens: ${esc([v.lens_type,v.lens_material,v.lens_coating].filter(x => x != null && x !== '').map(x=>String(x).replace(/_/g,' ')).join(' · ')) || '—'}<br>Frame: ${esc([v.frame_brand,v.frame_type,v.frame_material].filter(x => x != null && x !== '').map(x=>String(x).replace(/_/g,' ')).join(' · ')) || '—'}</div>
          </div>
          <div>
            <div style="font-size:.72rem;font-weight:700;color:var(--ink-light);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">${t('financials')}</div>
            <div style="font-size:.85rem">
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--cream-border)"><span style="color:var(--ink-light)">${t('total')}</span><span style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(v.total_amount)}</span></div>
              <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--cream-border)"><span style="color:var(--ink-light)">${t('paid')}</span><span style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(v.amount_paid)}</span></div>
              <div style="display:flex;justify-content:space-between;padding:4px 0"><span style="color:var(${v.remaining>0?'--danger':'--success'})">${t('remaining')}</span><span style="font-family:'Figtree','DM Sans',sans-serif;color:var(${v.remaining>0?'--danger':'--success'})">${fmtNum(v.remaining)}</span></div>
            </div>
            ${v.notes ? `<div style="font-size:.8rem;color:var(--ink-mid);margin-top:12px;padding:10px;border:1px solid var(--cream-border);border-radius:var(--radius-sm);background:var(--cream)"><strong>${t('visitNotes')}:</strong> ${esc(v.notes)}</div>` : ''}
          </div>
        </div>
        <div class="visit-action-row">
          ${v.remaining>0 ? `<button class="btn btn-gold btn-sm" onclick="topUpSingleVisit('${escAttr(v.id)}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
            ${NOOR.lang==='ar'?'تسديد':'Pay'}
          </button>` : ''}
          <button class="btn btn-outline btn-sm" onclick="openEditVisit('${escAttr(v.id)}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            ${NOOR.lang==='ar'?'تعديل':'Edit'}
          </button>
          ${NOOR.role==='doctor' || NOOR.role==='super_admin' ? `<button class="btn btn-sm" style="color:var(--danger);border:1.5px solid #fecaca;background:transparent" onclick="deleteVisit('${escAttr(v.id)}')">${t('delete')}</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function toggleVisit(id){ document.getElementById(id)?.classList.toggle('open'); }

function showPatientsListView() {
  document.getElementById('patients-list-view').style.display = 'block';
  document.getElementById('patients-detail-view').style.display = 'none';
  NOOR.editingPatientId = null;
}

function openAddPatient() {
  NOOR.editingPatientId = null;
  NOOR.patientModalMode = 'create';
  document.getElementById('modal-patient').classList.remove('old-rx-mode');
  ensureLensCatalog().catch(()=>{});
  document.getElementById('modal-patient-title').textContent = t('addPatient');
  clearPatientForm(); switchPatientTab('info');
  populateFrameInventory(); openModal('modal-patient');
}


async function openEditPatient() {
  if (!NOOR.editingPatientId) return;
  NOOR.patientModalMode = 'edit';
  document.getElementById('modal-patient').classList.remove('old-rx-mode');
  clearPatientForm();
  switchPatientTab('rx');
  document.getElementById('visit-date-group').style.display = 'block';
  document.getElementById('modal-patient-title').textContent = t('edit');
  try {
    const data = await get(`/api/patients/${NOOR.editingPatientId}`);
    const patient = data.data || {};
    fillPatientForm(patient);
    const latest = (patient.visits || [])[0];
    NOOR.editingVisitId = latest?.id || null;
    if (latest) fillVisitForm(latest);
    openModal('modal-patient');
  } catch(e) { toast(e.message,'error'); }
}

function fillPatientForm(p) {
  document.getElementById('p-name').value = p.full_name || '';
  document.getElementById('p-phone').value = p.phone || '';
  document.getElementById('p-age').value = p.age || '';
  document.getElementById('p-gender').value = p.gender || '';
  document.getElementById('p-address').value = p.address || '';
  document.getElementById('p-notes').value = p.notes || '';
}


function patientProfilePayload(extra = {}) {
  return {
    full_name: document.getElementById('p-name').value.trim(),
    phone:     document.getElementById('p-phone').value,
    age:       document.getElementById('p-age').value || null,
    gender:    document.getElementById('p-gender').value,
    address:   document.getElementById('p-address').value,
    notes:     document.getElementById('p-notes').value,
    ...extra,
  };
}

function confirmDuplicatePatient(duplicates) {
  const isAr = NOOR.lang === 'ar';
  const title = document.getElementById('dup-patient-title');
  const message = document.getElementById('dup-patient-message');
  const list = document.getElementById('dup-patient-list');
  const cancel = document.getElementById('dup-cancel-btn');
  const proceed = document.getElementById('dup-proceed-btn');

  if (title) title.textContent = isAr ? 'مراجع مشابه موجود' : 'Similar Patient Found';
  if (message) message.textContent = isAr
    ? 'يوجد مراجع بنفس الاسم أو رقم الهاتف. راجع المعلومات ثم اختر المتابعة أو الإلغاء.'
    : 'A patient with the same name or phone already exists. Review the match, then proceed or cancel.';
  if (cancel) cancel.textContent = isAr ? 'إلغاء' : 'Cancel';
  if (proceed) proceed.textContent = isAr ? 'المتابعة والحفظ' : 'Proceed and Save';
  if (list) {
    // Gather the current payload to determine match type
    const currentName  = (document.getElementById('p-name')?.value || '').trim().toLowerCase();
    const currentPhone = (document.getElementById('p-phone')?.value || '').replace(/\D/g, '');

    const rows = (duplicates || []).slice(0, 5);
    list.innerHTML = rows.length ? rows.map(p => {
      const pName  = (p.full_name || '').trim().toLowerCase();
      const pPhone = (p.phone || '').replace(/\D/g, '');
      const nameMatch  = currentName  && pName  && pName  === currentName;
      const phoneMatch = currentPhone && pPhone && pPhone === currentPhone;
      let matchLabel = '';
      if (nameMatch && phoneMatch) {
        matchLabel = isAr ? 'تطابق: الاسم والهاتف' : 'Match: Name & Phone';
      } else if (nameMatch) {
        matchLabel = isAr ? 'تطابق: الاسم' : 'Match: Name';
      } else if (phoneMatch) {
        matchLabel = isAr ? 'تطابق: رقم الهاتف' : 'Match: Phone';
      }
      return `
        <div style="border:1px solid var(--cream-border);background:var(--cream);border-radius:8px;padding:10px 12px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div style="font-weight:700;color:var(--ink)">${esc(p.full_name || (isAr ? 'بدون اسم' : 'Unnamed'))}</div>
            ${matchLabel ? `<span style="font-size:.73rem;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--burgundy-pale);color:var(--burgundy)">${esc(matchLabel)}</span>` : ''}
          </div>
          <div style="font-family:'Figtree','DM Sans',sans-serif;font-size:.86rem;color:var(--ink-mid);margin-top:2px">${esc(p.phone || '—')}</div>
        </div>
      `;
    }).join('') : `<div style="color:var(--ink-mid)">${isAr ? 'تم العثور على مراجع مشابه.' : 'A similar patient was found.'}</div>`;
  }

  openModal('modal-duplicate-patient');
  return new Promise(resolve => { NOOR.duplicatePatientResolver = resolve; });
}

function resolveDuplicatePatient(shouldProceed) {
  const resolve = NOOR.duplicatePatientResolver;
  NOOR.duplicatePatientResolver = null;
  closeModal('modal-duplicate-patient');
  if (resolve) resolve(!!shouldProceed);
}

function _findLocalDuplicates(payload, excludeId) {
  const name  = (payload.full_name || '').trim().toLowerCase();
  const phone = (payload.phone || '').replace(/\D/g, '');
  return (NOOR.patients || []).filter(p => {
    if (excludeId && p.id === excludeId) return false;
    const pName  = (p.full_name || '').trim().toLowerCase();
    const pPhone = (p.phone || '').replace(/\D/g, '');
    const nameMatch  = name  && pName  && pName  === name;
    const phoneMatch = phone && pPhone && pPhone === phone;
    return nameMatch || phoneMatch;
  });
}

async function savePatientProfile(pid, payload, isNewPatient) {
  // ── Client-side duplicate pre-check (instant, no round-trip) ──────────────
  const localDups = _findLocalDuplicates(payload, isNewPatient ? null : pid);
  if (localDups.length) {
    const proceed = await confirmDuplicatePatient(localDups);
    if (!proceed) { const e = new Error('cancelled'); e.silent = true; throw e; }
    payload = { ...payload, allow_duplicate: true };
  }

  try {
    if (isNewPatient) {
      const res = await post('/api/patients', payload);
      return res.data.id;
    }
    if (NOOR.patientModalMode === 'edit') {
      await put(`/api/patients/${pid}`, payload);
    }
    return pid;
  } catch (e) {
    if (e.status === 409 && e.data?.code === 'duplicate_patient') {
      if (!(await confirmDuplicatePatient(e.data.duplicates || []))) {
        e.silent = true;
        throw e;
      }
      const retryPayload = { ...payload, allow_duplicate: true };
      if (isNewPatient) {
        const res = await post('/api/patients', retryPayload);
        return res.data.id;
      }
      if (NOOR.patientModalMode === 'edit') {
        await put(`/api/patients/${pid}`, retryPayload);
      }
      return pid;
    }
    throw e;
  }
}

async function savePatient() {
  if (NOOR.savingPatient) return;
  const name = document.getElementById('p-name').value.trim();
  if (!name) { toast(t('errorRequired'),'error'); switchPatientTab('info'); return; }

  // Validate VA/BCVA: must be empty or a valid fraction like 6/6
  const vaIds = ['rx-od-va','rx-od-bcva','rx-os-va','rx-os-bcva'];
  for (const id of vaIds) {
    const v = (document.getElementById(id)?.value || '').trim();
    if (v && !/^\d+\/\d+$/.test(v)) {
      toast('VA / BCVA must be a fraction like 6/6 or 20/200', 'error');
      switchPatientTab('rx');
      document.getElementById(id).focus();
      return;
    }
  }

  // Validate Sphere / Cylinder: -20 to +20, no 3-digit numbers
  const sphCylIds = ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'];
  const isAr = NOOR.lang === 'ar';
  for (const id of sphCylIds) {
    const raw = document.getElementById(id)?.value;
    if (raw === '' || raw === null || raw === undefined) continue;
    const val = parseFloat(raw);
    if (isNaN(val)) continue;
    if (Math.abs(val) > 20) {
      toast(isAr ? 'قيمة SPH / CYL يجب أن تكون بين -20 و +20' : 'SPH / CYL must be between -20 and +20', 'error');
      switchPatientTab('rx');
      document.getElementById(id).focus();
      return;
    }
    // No 3-digit integer part
    if (Math.abs(Math.trunc(val)) >= 100) {
      toast(isAr ? 'قيمة SPH / CYL لا يمكن أن تكون رقماً من 3 خانات' : 'SPH / CYL cannot be a 3-digit number', 'error');
      switchPatientTab('rx');
      document.getElementById(id).focus();
      return;
    }
  }

  // Validate Axis: 0–360
  const axisIds = ['rx-od-axis','rx-os-axis'];
  for (const id of axisIds) {
    const raw = document.getElementById(id)?.value;
    if (raw === '' || raw === null || raw === undefined) continue;
    const val = parseInt(raw);
    if (!isNaN(val) && (val < 0 || val > 360)) {
      toast(isAr ? 'قيمة المحور (Axis) يجب أن تكون بين 0 و 360' : 'Axis must be between 0 and 360', 'error');
      switchPatientTab('rx');
      document.getElementById(id).focus();
      return;
    }
  }

  const isNewPatient = !NOOR.editingPatientId;
  let pid = NOOR.editingPatientId;
  NOOR.savingPatient = true;
  const saveBtn = document.getElementById('patient-save-btn');
  if (saveBtn) saveBtn.disabled = true;

  try {
    // 1. Create or update patient profile
    pid = await savePatientProfile(pid, patientProfilePayload(), isNewPatient);

    // 2. Create visit if any data entered
    const lp = parseFloat(document.getElementById('f-lens-price').value)||0;
    const fp = parseFloat(document.getElementById('f-frame-price').value)||0;
    const cf = parseFloat(document.getElementById('f-checkup-fee').value)||0;
    const pd = parseFloat(document.getElementById('f-paid').value)||0;
    const total = lp+fp+cf;
    const rxIds = ['rx-od-sph','rx-od-cyl','rx-od-axis','rx-od-add','rx-od-va','rx-od-bcva','rx-os-sph','rx-os-cyl','rx-os-axis','rx-os-add','rx-os-va','rx-os-bcva','rx-ipd'];
    const hasRx = rxIds.some(id => document.getElementById(id).value !== '');
    const hasFrame = NOOR.patientModalMode !== 'old_rx' && ['p-frame-brand','p-frame-type','p-frame-material','p-frame-inv'].some(id => document.getElementById(id).value !== '');
    const hasCheckup = NOOR.patientModalMode !== 'old_rx' && (document.getElementById('f-checkup').checked || document.getElementById('f-next-visit').value !== '');
    const hasVisitNotes = (document.getElementById('f-visit-notes').value || '').trim() !== '';

    if (total > 0 || hasRx || hasFrame || hasCheckup || hasVisitNotes) {
      const coatings = [...document.querySelectorAll('.coating-chip.selected')].map(c=>c.dataset.val).join(',');
      const visitPayload = {
        patient_id:      pid,
        visit_date:      (NOOR.patientModalMode === 'old_rx' ? (document.getElementById('f-visit-date-oldcopy')?.value || document.getElementById('f-visit-date').value) : document.getElementById('f-visit-date').value) || todayStr(),
        od_sphere:       numOrNull('rx-od-sph'),
        od_cylinder:     numOrNull('rx-od-cyl'),
        od_axis:         intOrNull('rx-od-axis'),
        od_addition:     numOrNull('rx-od-add'),
        od_va:           fractionOrNull('rx-od-va'),
        od_bcva:         fractionOrNull('rx-od-bcva'),
        os_sphere:       numOrNull('rx-os-sph'),
        os_cylinder:     numOrNull('rx-os-cyl'),
        os_axis:         intOrNull('rx-os-axis'),
        os_addition:     numOrNull('rx-os-add'),
        os_va:           fractionOrNull('rx-os-va'),
        os_bcva:         fractionOrNull('rx-os-bcva'),
        ipd:             numOrNull('rx-ipd'),
        lens_type:       NOOR.patientModalMode === 'old_rx' ? null : document.getElementById('rx-lens-type').value,
        lens_material:   NOOR.patientModalMode === 'old_rx' ? null : document.getElementById('rx-material').value,
        lens_coating:    NOOR.patientModalMode === 'old_rx' ? null : (coatings||'clear'),
        lens_count:      NOOR.patientModalMode === 'old_rx' ? null : (Object.values(NOOR._selectedLensIds || {}).filter(Boolean).length || parseInt(document.getElementById('rx-lens-count').value)||2),
        lens_id:         NOOR._selectedLensId||null,
        od_lens_id:      NOOR.patientModalMode === 'old_rx' ? null : ((NOOR._selectedLensIds || {}).od || null),
        os_lens_id:      NOOR.patientModalMode === 'old_rx' ? null : ((NOOR._selectedLensIds || {}).os || null),
        frame_id:        NOOR.patientModalMode === 'old_rx' ? null : (NOOR._selectedFrameInvId||null),
        frame_brand:     NOOR.patientModalMode === 'old_rx' ? null : (document.getElementById('p-frame-brand').value||null),
        frame_type:      NOOR.patientModalMode === 'old_rx' ? null : (document.getElementById('p-frame-type').value||null),
        frame_material:  NOOR.patientModalMode === 'old_rx' ? null : (document.getElementById('p-frame-material').value||null),
        did_checkup:     NOOR.patientModalMode === 'old_rx' ? false : document.getElementById('f-checkup').checked,
        next_visit_date: NOOR.patientModalMode === 'old_rx' ? null : (document.getElementById('f-next-visit').value||null),
        followup_months: parseInt(document.getElementById('f-followup-months').value)||3,
        frame_cost:      NOOR.patientModalMode === 'old_rx' ? 0 : (parseFloat(document.getElementById('f-frame-cost').value)||0),
        frame_price:     NOOR.patientModalMode === 'old_rx' ? 0 : fp,
        lens_cost:       NOOR.patientModalMode === 'old_rx' ? 0 : (parseFloat(document.getElementById('f-lens-cost').value)||0),
        lens_price:      NOOR.patientModalMode === 'old_rx' ? 0 : lp,
        checkup_fee:     NOOR.patientModalMode === 'old_rx' ? 0 : cf,
        amount_paid:     NOOR.patientModalMode === 'old_rx' ? 0 : pd,
        // Bug fix #21: compute and send total_amount / remaining so debt displays are correct
        // (schema stores these as plain columns, not computed)
        total_amount:    NOOR.patientModalMode === 'old_rx' ? 0 : (fp + lp + cf),
        remaining:       NOOR.patientModalMode === 'old_rx' ? 0 : Math.max(0, (fp + lp + cf) - pd),
        notes:           document.getElementById('f-visit-notes').value,
      };
      if (NOOR.patientModalMode === 'edit' && NOOR.editingVisitId) await put(`/api/visits/${NOOR.editingVisitId}`, visitPayload);
      else await post('/api/visits', visitPayload);
    }

    markPatientFormClean();
    closeModal('modal-patient');
    toast(t('successSaved'));
    await renderPatients();
    NOOR.editingPatientId = pid;
    await openPatientDetail(pid);

  } catch(e) {
    if (!e.silent) toast(e.message, 'error');
  } finally {
    NOOR.savingPatient = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}


async function deletePatient(id) {
  if (!confirm(NOOR.lang==='ar'?'هل أنت متأكد من حذف هذا المراجع؟':'Delete this patient?')) return;
  try {
    await del(`/api/patients/${id}`);
    toast(t('successDeleted'));
    await renderPatients();
  } catch(e) { toast(e.message,'error'); }
}
