/* visits.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function openNewVisit() {
  NOOR.patientModalMode = 'visit';
  document.getElementById('modal-patient').classList.remove('old-rx-mode');
  await ensureLensCatalog().catch(()=>{});
  clearPatientForm(); switchPatientTab('rx');
  document.getElementById('visit-date-group').style.display = 'block';
  document.getElementById('f-visit-date').value = todayStr();
  document.getElementById('modal-patient-title').textContent = t('newVisit');
  if (NOOR.editingPatientId) {
    try {
      const data = await get(`/api/patients/${NOOR.editingPatientId}`);
      fillPatientForm(data.data || {});
      const visits = data.data?.visits || [];
      if (visits.length) {
        const lv = visits[0];
        document.getElementById('prev-rx-box').style.display = 'none';
        NOOR._lastVisit = lv;
      }
    } catch(_){}
  }
  openModal('modal-patient');
}

async function openOldPrescription() {
  if (!NOOR.editingPatientId) return;
  await openNewVisit();
  NOOR.patientModalMode = 'old_rx';
  document.getElementById('modal-patient').classList.add('old-rx-mode');
  document.getElementById('modal-patient-title').textContent = t('oldPrescription');
  // Clear the date so the user must consciously pick the original visit date
  document.getElementById('f-visit-date').value = '';
  // Go straight to the Rx tab — the date field is shown inline above the Rx table
  // via the old-rx-mode date injection; user fills date + Rx in one step.
  switchPatientTab('rx');
  // Show the date field inside the Rx tab for old-rx mode
  _showOldRxDateHint();
}

function _showOldRxDateHint() {
  // Inject a date row at the top of the Rx tab if not already there
  const rxTab = document.getElementById('ptab-rx');
  if (!rxTab) return;
  let dateHint = document.getElementById('old-rx-date-hint');
  if (!dateHint) {
    dateHint = document.createElement('div');
    dateHint.id = 'old-rx-date-hint';
    dateHint.style.cssText = 'display:none;padding:12px 0 4px;';
    dateHint.innerHTML = `<div class="form-group" style="max-width:220px">
      <label class="form-label" style="font-weight:700;color:var(--burgundy)" id="old-rx-date-lbl">تاريخ الوصفة القديمة</label>
      <input type="date" class="form-input" id="f-visit-date-oldcopy"
        oninput="document.getElementById('f-visit-date').value=this.value">
    </div>`;
    rxTab.insertBefore(dateHint, rxTab.firstChild);
  }
  dateHint.style.display = 'block';
  // Sync value
  const copyInput = document.getElementById('f-visit-date-oldcopy');
  const isAr = NOOR.lang === 'ar';
  if (copyInput) {
    copyInput.value = document.getElementById('f-visit-date').value || '';
    const lbl = document.getElementById('old-rx-date-lbl');
    if (lbl) lbl.textContent = isAr ? 'تاريخ الوصفة القديمة' : 'Date of Original Prescription';
  }
}


function setRxVal(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.value = value === null || value === undefined ? '' : value;
  syncRxSign(id);
}

function fillVisitForm(v) {
  document.getElementById('f-visit-date').value = v.visit_date || todayStr();
  setRxVal('rx-od-sph', v.od_sphere);
  setRxVal('rx-od-cyl', v.od_cylinder);
  setRxVal('rx-od-axis', v.od_axis);
  setRxVal('rx-od-add', v.od_addition);
  document.getElementById('rx-od-va').value = v.od_va || '';
  document.getElementById('rx-od-bcva').value = v.od_bcva || '';
  setRxVal('rx-os-sph', v.os_sphere);
  setRxVal('rx-os-cyl', v.os_cylinder);
  setRxVal('rx-os-axis', v.os_axis);
  setRxVal('rx-os-add', v.os_addition);
  document.getElementById('rx-os-va').value = v.os_va || '';
  document.getElementById('rx-os-bcva').value = v.os_bcva || '';
  setRxVal('rx-ipd', v.ipd);
  setSelectValue('rx-lens-type', v.lens_type || 'single_vision', catalogLabel('type', v.lens_type));
  setSelectValue('rx-material', v.lens_material || 'plastic', catalogLabel('material', v.lens_material));
  document.getElementById('rx-lens-count').value = v.lens_count || 2;
  renderCoatingChips((v.lens_coating||'').split(',').filter(Boolean));
  document.getElementById('p-frame-brand').value = v.frame_brand || '';
  document.getElementById('p-frame-type').value = v.frame_type || 'full_rim';
  document.getElementById('p-frame-material').value = v.frame_material || 'acetate';
  document.getElementById('f-frame-cost').value = v.frame_cost || '';
  document.getElementById('f-frame-price').value = v.frame_price || '';
  document.getElementById('f-lens-cost').value = v.lens_cost || '';
  document.getElementById('f-lens-price').value = v.lens_price || '';
  document.getElementById('f-checkup-fee').value = v.checkup_fee || '';
  document.getElementById('f-paid').value = v.amount_paid || '';
  document.getElementById('f-checkup').checked = !!v.did_checkup;
  document.getElementById('followup-date-row').style.display = v.did_checkup ? 'grid' : 'none';
  document.getElementById('f-next-visit').value = v.next_visit_date || '';
  document.getElementById('f-followup-months').value = v.followup_months || NOOR.settings.followup_months_default || 3;
  document.getElementById('f-visit-notes').value = v.notes || '';
  onLensTypeChange(true);
  calcTotal();
}

function clearPatientForm() {
  const dateHint = document.getElementById('old-rx-date-hint');
  if (dateHint) dateHint.style.display = 'none';
  ['p-name','p-phone','p-age','p-address','p-notes','p-frame-brand'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
  ['rx-od-sph','rx-od-cyl','rx-od-axis','rx-od-add','rx-od-va','rx-od-bcva','rx-os-sph','rx-os-cyl','rx-os-axis','rx-os-add','rx-os-va','rx-os-bcva','rx-ipd'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
  ['f-frame-cost','f-frame-price','f-lens-cost','f-lens-price','f-checkup-fee','f-paid','f-visit-notes'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
  renderCoatingChips([]);
  document.getElementById('f-checkup').checked = false;
  document.getElementById('f-followup-months').value = NOOR.settings.followup_months_default || 3;
  document.getElementById('followup-date-row').style.display = 'none';
  document.getElementById('prev-rx-box').style.display = 'none';
  document.getElementById('visit-date-group').style.display = 'none';
  document.getElementById('f-visit-date').value = todayStr();
  document.getElementById('inv-match-items').innerHTML = `<span class="inv-match-empty">${t('enterRxFirst')}</span>`;
  NOOR._selectedLensId = null;
  NOOR._selectedLensIds = { od: null, os: null };
  NOOR._matchLensById = new Map();
  NOOR._lastLensMatchSignature = '';
  // Reset sign-toggle buttons
  ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'].forEach(id => {
    document.getElementById(id + '-sign')?.classList.remove('is-negative');
  });
  NOOR._selectedFrameInvId = null;
  NOOR._lastVisit = null;
  NOOR.editingVisitId = null;
  setNoFrame(false);
  calcTotal();
}

function setNoFrame(noFrame) {
  NOOR._noFrame = !!noFrame;
  const toggle = document.getElementById('no-frame-toggle');
  if (toggle) toggle.checked = noFrame;
  const framePanel = document.getElementById('ptab-frame');
  if (framePanel) framePanel.classList.toggle('no-frame-mode', noFrame);
  const frameTab = document.getElementById('ptab-frame-btn');
  if (frameTab) frameTab.style.opacity = noFrame ? '0.45' : '';
  // Clear frame fields when toggling to no-frame
  if (noFrame) {
    ['p-frame-brand'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.getElementById('f-frame-cost').value = '';
    document.getElementById('f-frame-price').value = '';
    NOOR._selectedFrameInvId = null;
    calcTotal();
  }
}

function switchPatientTab(tab) {
  ['info','rx','frame','financials'].forEach(t2 => {
    document.getElementById(`ptab-${t2}`)?.classList.toggle('active', t2===tab);
  });
  const map = {info:'ptab-info-btn',rx:'ptab-rx-btn',frame:'ptab-frame-btn',financials:'ptab-fin-btn'};
  document.querySelectorAll('#modal-patient .tab-btn').forEach(b=>b.classList.remove('active'));
  document.getElementById(map[tab])?.classList.add('active');
}

function onLensTypeChange(skipMatch=false) {
  const val = document.getElementById('rx-lens-type').value;
  if (val === 'plano') {
    ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'].forEach(id => {
      const el = document.getElementById(id); if(el){ el.value='0'; el.disabled=true; }
    });
  } else {
    ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'].forEach(id => {
      const el = document.getElementById(id); if(el) el.disabled=false;
    });
  }
  if (!skipMatch) onRxChange();
}

function toggleCoating(el){ el.classList.toggle('selected'); updatePatientFormDirty(); onRxChange(); }

function _clampRxInput(id) {
  const el = document.getElementById(id);
  if (!el || el.value === '') return;
  let v = parseFloat(el.value);
  if (isNaN(v)) return;
  if (v > 20) { el.value = 20; }
  else if (v < -20) { el.value = -20; }
}

let _rxChangeTimer;
async function onRxChange() {
  clearTimeout(_rxChangeTimer);
  _rxChangeTimer = setTimeout(async () => {
    const odSphRaw = document.getElementById('rx-od-sph').value;
    const osSphRaw = document.getElementById('rx-os-sph').value;
    const odSph = odSphRaw !== '' ? parseFloat(odSphRaw) : null;
    const osSph = osSphRaw !== '' ? parseFloat(osSphRaw) : null;
    const odCyl = parseFloat(document.getElementById('rx-od-cyl').value) || 0;
    const osCyl = parseFloat(document.getElementById('rx-os-cyl').value) || 0;
    const cont  = document.getElementById('inv-match-items');

    if (odSph === null && osSph === null) {
      cont.innerHTML = `<span class="inv-match-empty">${t('enterRxFirst')}</span>`;
      return;
    }

    // Build query only for eyes that have values entered
    const params = new URLSearchParams();
    if (odSph !== null) { params.set('od_sph', odSph); params.set('od_cyl', odCyl); }
    if (osSph !== null) { params.set('os_sph', osSph); params.set('os_cyl', osCyl); }
    const lensType = document.getElementById('rx-lens-type')?.value || '';
    const material = document.getElementById('rx-material')?.value || '';
    const coatings = [...document.querySelectorAll('.coating-chip.selected')].map(c=>c.dataset.val).filter(Boolean);
    if (lensType) params.set('lens_type', lensType);
    if (material) params.set('material', material);
    if (coatings.length) params.set('coating', coatings.join(','));
    const matchSignature = params.toString();
    if (NOOR._lastLensMatchSignature && NOOR._lastLensMatchSignature !== matchSignature) {
      NOOR._selectedLensId = null;
      NOOR._selectedLensIds = { od: null, os: null };
      document.getElementById('f-lens-cost').value = '';
      document.getElementById('f-lens-price').value = '';
      calcTotal();
    }
    NOOR._lastLensMatchSignature = matchSignature;

    try {
      const data   = await get(`/api/lenses/match?${params}`);
      const result = data.data || {};
      NOOR._matchLensById = new Map();
      [...(Array.isArray(result) ? result : []), ...(result.od || []), ...(result.os || [])].forEach(l => NOOR._matchLensById.set(l.id, l));

      // Legacy flat array (old backend) — fall back gracefully
      if (Array.isArray(result)) {
        if (!result.length) { cont.innerHTML = '<span class="inv-match-empty">No matching lenses</span>'; return; }
        cont.innerHTML = result.map(l => _lensChipHtml(l, 'both')).join('');
        _syncLensSelectionAvailability();
        return;
      }

      const odList = result.od || [];
      const osList = result.os || [];
      const single = result.single;

      // Always render each eye independently.
      // single=true means only one eye was provided — show that eye's results
      // without a label. When both eyes are provided, show labelled groups.
      let html = '';
      if (single) {
        // Only one eye has data — show that eye's matches without a header
        const list = odSph !== null ? odList : osList;
        const eye  = odSph !== null ? 'od' : 'os';
        if (!list.length) { cont.innerHTML = '<span class="inv-match-empty">No matching lenses</span>'; return; }
        cont.innerHTML = list.map(l => _lensChipHtml(l, eye)).join('');
        _syncLensSelectionAvailability();
        return;
      }

      // Both eyes provided — render OD group + OS group independently
      if (odList.length) {
        html += `<div style="font-size:.72rem;font-weight:700;color:var(--ink-mid);text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">OD (R)</div>`;
        html += odList.map(l => _lensChipHtml(l, 'od')).join('');
      }
      if (osList.length) {
        html += `<div style="font-size:.72rem;font-weight:700;color:var(--ink-mid);text-transform:uppercase;letter-spacing:.07em;margin:${odList.length ? '12px' : '0'} 0 6px">OS (L)</div>`;
        html += osList.map(l => _lensChipHtml(l, 'os')).join('');
      }
      if (!html) { cont.innerHTML = '<span class="inv-match-empty">No matching lenses</span>'; return; }
      cont.innerHTML = html;
      _syncLensSelectionAvailability();
    } catch(_) {}
  }, 300);
}

function _legacyLensChipHtml(l, eye) {
  const sphStr = (l.sphere > 0 ? '+' : '') + esc(l.sphere);
  const label  = `SPH ${sphStr} CYL ${esc(l.cylinder || 0)} · ${esc((l.lens_type || '').replace(/_/g, ' '))} · Qty: ${esc(l.quantity)}`;
  return `<div class="inv-match-chip" data-id="${escAttr(l.id)}" data-eye="${escAttr(eye)}" onclick="selectMatchLens(this,'${escAttr(l.id)}')">${label}</div>`;
}

function _legacySelectMatchLens(el, id) {
  document.querySelectorAll('.inv-match-chip').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  NOOR._selectedLensId = id;
  // Try to fill price from cached lenses
  const lens = NOOR.lenses.find(l=>l.id===id);
  if (lens) { document.getElementById('f-lens-cost').value=lens.cost_price||''; document.getElementById('f-lens-price').value=lens.sell_price||''; calcTotal(); }
}

function _lensChipHtml(l, eye) {
  const sphStr = (l.sphere > 0 ? '+' : '') + esc(l.sphere);
  const label  = `SPH ${sphStr} CYL ${esc(l.cylinder || 0)} - ${esc((l.lens_type || '').replace(/_/g, ' '))} - ${esc((l.material || '').replace(/_/g, ' '))} - Qty: ${esc(l.quantity)}`;
  return `<div class="inv-match-chip" data-id="${escAttr(l.id)}" data-eye="${escAttr(eye)}" data-qty="${escAttr(l.quantity || 0)}" data-cost="${escAttr(l.cost_price || 0)}" data-price="${escAttr(l.sell_price || 0)}" onclick="selectMatchLens(this,'${escAttr(l.id)}')">${label}</div>`;
}

function selectMatchLens(el, id) {
  const eye = el.dataset.eye || 'both';
  if (!NOOR._selectedLensIds) NOOR._selectedLensIds = { od: null, os: null };
  const otherEye = eye === 'od' ? 'os' : eye === 'os' ? 'od' : null;
  const qty = parseInt(el.dataset.qty || '0') || 0;
  if (otherEye && NOOR._selectedLensIds[otherEye] === id && qty <= 1) {
    toast(NOOR.lang === 'ar' ? 'هذه العدسة متبقية منها قطعة واحدة فقط.' : 'Only one of this lens is left in inventory.', 'warning');
    return;
  }
  document.querySelectorAll(`.inv-match-chip[data-eye="${eye}"]`).forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  if (eye === 'both') {
    NOOR._selectedLensIds.od = id;
    NOOR._selectedLensIds.os = id;
  } else {
    NOOR._selectedLensIds[eye] = id;
  }
  _syncLensSelectionAvailability();
  _applySelectedLensPricing();
}

function _lensById(id) {
  return (NOOR._matchLensById && NOOR._matchLensById.get(id)) || (NOOR.lenses || []).find(l => l.id === id) || null;
}

function _selectedLensList() {
  const ids = NOOR._selectedLensIds || {};
  return ['od','os'].map(eye => ids[eye]).filter(Boolean).map(id => _lensById(id)).filter(Boolean);
}

function _applySelectedLensPricing() {
  const lenses = _selectedLensList();
  if (!lenses.length) return;
  const cost = lenses.reduce((sum, l) => sum + (parseFloat(l.cost_price) || 0), 0);
  const price = lenses.reduce((sum, l) => sum + (parseFloat(l.sell_price) || 0), 0);
  document.getElementById('f-lens-cost').value = cost || '';
  document.getElementById('f-lens-price').value = price || '';
  document.getElementById('rx-lens-count').value = String(lenses.length);
  NOOR._selectedLensId = (NOOR._selectedLensIds.od && NOOR._selectedLensIds.od === NOOR._selectedLensIds.os)
    ? NOOR._selectedLensIds.od
    : (NOOR._selectedLensIds.od || NOOR._selectedLensIds.os || null);
  calcTotal();
}

function _syncLensSelectionAvailability() {
  if (!NOOR._selectedLensIds) NOOR._selectedLensIds = { od: null, os: null };
  document.querySelectorAll('.inv-match-chip').forEach(chip => {
    const eye = chip.dataset.eye;
    const id = chip.dataset.id;
    const qty = parseInt(chip.dataset.qty || '0') || 0;
    const otherEye = eye === 'od' ? 'os' : eye === 'os' ? 'od' : null;
    const blocked = otherEye && NOOR._selectedLensIds[otherEye] === id && qty <= 1 && NOOR._selectedLensIds[eye] !== id;
    chip.classList.toggle('disabled', !!blocked);
    chip.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    chip.classList.toggle('selected', NOOR._selectedLensIds[eye] === id || (eye === 'both' && (NOOR._selectedLensIds.od === id || NOOR._selectedLensIds.os === id)));
  });
}

function importPrevRx() {
  const lv = NOOR._lastVisit; if (!lv) return;
  document.getElementById('rx-od-sph').value  = lv.od_sphere||'';
  document.getElementById('rx-od-cyl').value  = lv.od_cylinder||'';
  document.getElementById('rx-od-axis').value = lv.od_axis||'';
  document.getElementById('rx-os-sph').value  = lv.os_sphere||'';
  document.getElementById('rx-os-cyl').value  = lv.os_cylinder||'';
  document.getElementById('rx-os-axis').value = lv.os_axis||'';
  // Sync sign buttons to imported values
  ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'].forEach(id => {
    const val = parseFloat(document.getElementById(id)?.value);
    const btn = document.getElementById(id + '-sign');
    if (btn) btn.classList.toggle('is-negative', !isNaN(val) && val < 0);
  });
  onRxChange();
  toast(t('successSaved'));
}

async function populateFrameInventory() {
  const sel = document.getElementById('p-frame-inv');
  sel.innerHTML = `<option value="">${t('selectFrame')}</option>`;
  try {
    const data = await get('/api/frames');
    NOOR.frames = data.data || [];
    NOOR.frames.forEach(f => {
      const o = document.createElement('option');
      o.value = f.id;
      o.textContent = `${f.brand||'Frame'} ${(f.frame_type||'').replace(/_/g,' ')} · ${t('qty')}: ${f.quantity}`;
      sel.appendChild(o);
    });
  } catch(_){}
}

function onFrameInvSelect() {
  const id = document.getElementById('p-frame-inv').value; if (!id) return;
  NOOR._selectedFrameInvId = id;
  const f = NOOR.frames.find(fr=>fr.id===id);
  if (f) {
    document.getElementById('f-frame-cost').value  = f.cost_price||'';
    document.getElementById('f-frame-price').value = f.sell_price||'';
    document.getElementById('p-frame-brand').value = f.brand||'';
    calcTotal();
  }
}

async function onCheckupToggle() {
  const checked = document.getElementById('f-checkup').checked;
  document.getElementById('followup-date-row').style.display = checked ? 'grid' : 'none';

  // Eagerly load settings if not yet cached (e.g. user hasn't visited Settings tab)
  if (!NOOR.settings?.default_checkup_fee && !NOOR._settingsLoaded) {
    try {
      const s = await get('/api/settings');
      const st = s.data?.settings || {};
      NOOR.settings = Object.assign(NOOR.settings || {}, st);
      NOOR._settingsLoaded = true;
    } catch(_) {}
  }

  if (checked) {
    // Apply the default checkup fee when toggled on (only if field is empty/zero)
    const defaultFee = parseFloat(NOOR.settings?.default_checkup_fee) || 0;
    const currentFee = parseFloat(document.getElementById('f-checkup-fee').value) || 0;
    if (defaultFee > 0 && currentFee === 0) {
      document.getElementById('f-checkup-fee').value = defaultFee;
      calcTotal();
      // Switch to financials so the user sees the amount was set
      switchPatientTab('financials');
    }
    updateNextVisitDate();
  } else {
    // Clear the fee when toggled off (if it matches the default, it was auto-set)
    const defaultFee = parseFloat(NOOR.settings?.default_checkup_fee) || 0;
    const currentFee = parseFloat(document.getElementById('f-checkup-fee').value) || 0;
    if (defaultFee > 0 && currentFee === defaultFee) {
      document.getElementById('f-checkup-fee').value = '';
      calcTotal();
    }
  }
}

function updateNextVisitDate() {
  const m = parseInt(document.getElementById('f-followup-months').value)||3;
  const base = document.getElementById('f-visit-date')?.value
    ? new Date(document.getElementById('f-visit-date').value + 'T00:00:00')
    : new Date();
  const d = new Date(base); d.setMonth(d.getMonth()+m);
  document.getElementById('f-next-visit').value = d.toISOString().split('T')[0];
}

function calcTotal() {
  const fp = parseFloat(document.getElementById('f-frame-price')?.value)||0;
  const lp = parseFloat(document.getElementById('f-lens-price')?.value)||0;
  const cf = parseFloat(document.getElementById('f-checkup-fee')?.value)||0;
  const pd = parseFloat(document.getElementById('f-paid')?.value)||0;
  const total = fp+lp+cf;
  document.getElementById('fs-frame').textContent     = fmtIQD(fp);
  document.getElementById('fs-lens').textContent      = fmtIQD(lp);
  document.getElementById('fs-checkup').textContent   = fmtIQD(cf);
  document.getElementById('fs-total').textContent     = fmtIQD(total);
  document.getElementById('fs-paid').textContent      = fmtIQD(pd);
  document.getElementById('fs-remaining').textContent = fmtIQD(Math.max(0,total-pd));
}

function numOrNull(id) {
  const val = document.getElementById(id).value;
  return val === '' ? null : parseFloat(val);
}

function intOrNull(id) {
  const val = document.getElementById(id).value;
  return val === '' ? null : parseInt(val);
}

// ── Fraction (VA/BCVA) input enforcement ──────────────────────────
// Only digits and a single "/" are allowed. Clears non-conforming chars live.
function enforceFraction(el) {
  // Allow only digits and one slash
  let v = el.value.replace(/[^\d/]/g, '');
  // Only one slash allowed
  const parts = v.split('/');
  if (parts.length > 2) v = parts[0] + '/' + parts.slice(1).join('');
  el.value = v;
  el.style.borderColor = '';
}

function validateFraction(el) {
  const v = el.value.trim();
  if (!v) { el.style.borderColor = ''; return; }
  // Must match digits/digits, e.g. 6/6, 20/200
  if (!/^\d+\/\d+$/.test(v)) {
    el.style.borderColor = 'var(--danger)';
    el.title = 'Must be a fraction like 6/6 or 20/200';
  } else {
    el.style.borderColor = 'var(--success)';
    el.title = '';
  }
}

// ── Sign toggle: flips value between positive and negative ──
function syncRxSign(inputId) {
  const el = document.getElementById(inputId);
  const btn = document.getElementById(inputId + '-sign');
  if (!el || !btn) return;
  const val = parseFloat(el.value);
  btn.classList.toggle('is-negative', !isNaN(val) && val < 0);
}

function toggleRxSign(inputId) {
  const el  = document.getElementById(inputId);
  const btn = document.getElementById(inputId + '-sign');
  if (!el) return;
  const cur = parseFloat(el.value);
  if (!isNaN(cur) && cur !== 0) {
    // Flip existing non-zero value
    el.value = (-cur).toFixed(2);
  } else if (el.value === '' || isNaN(cur) || cur === 0) {
    // No value yet — prime the field with '-0.00' visual cue: just mark the btn
    // The actual negative will apply once user types a number
    // Toggle the btn state so next typed value becomes negative
    if (btn) btn.classList.toggle('is-negative');
    return;
  }
  syncRxSign(inputId);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// When user types into a sign-controlled field, apply pending negative state
function applyPendingSign(inputId) {
  const el  = document.getElementById(inputId);
  const btn = document.getElementById(inputId + '-sign');
  if (!el || !btn) return;
  const val = parseFloat(el.value);
  if (!isNaN(val) && val > 0 && btn.classList.contains('is-negative')) {
    el.value = (-val).toFixed(2);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  syncRxSign(inputId);
}

function fractionOrNull(id) {
  const v = (document.getElementById(id)?.value || '').trim();
  if (!v) return null;
  if (!/^\d+\/\d+$/.test(v)) return null; // silently drop invalid
  return v;
}


function topUpSingleVisit(visitId) {
  const detail = NOOR._currentPatientDetail || {};
  const visit = (detail.visits || []).find(v => v.id === visitId);
  if (!visit) return topUpPatientRemaining();
  const remaining = parseFloat(visit.remaining) || 0;
  if (remaining <= 0) return;

  NOOR._topupVisits = [visit];
  NOOR._topupOutstanding = remaining;

  const isAr = NOOR.lang === 'ar';
  const setT = (id, ar, en) => { const el = document.getElementById(id); if (el) el.textContent = isAr ? ar : en; };
  setT('topup-modal-title', 'تسديد المتبقي', 'Pay Outstanding');
  setT('topup-outstanding-label', 'المبلغ المتبقي', 'Outstanding Amount');
  setT('topup-amount-label', 'المبلغ المدفوع (IQD)', 'Amount Paid (IQD)');
  setT('topup-cancel-btn', 'إلغاء', 'Cancel');
  setT('topup-submit-btn', 'تأكيد التسديد', 'Confirm Payment');

  document.getElementById('topup-outstanding-val').textContent = fmtIQD(remaining);
  const summaryEl = document.getElementById('topup-visits-summary');
  summaryEl.textContent = isAr ? `زيارة ${visit.visit_date || ''}` : `Visit: ${visit.visit_date || ''}`;

  const qbtns = document.getElementById('topup-quick-btns');
  qbtns.innerHTML = ['25%','50%','75%','100%'].map(pct => {
    const val = Math.round(remaining * parseInt(pct) / 100 / 1000) * 1000;
    return `<button type="button" class="btn btn-sm btn-outline" onclick="setTopupQuick(${val})">${pct}<br><span style="font-size:.7rem;opacity:.7">${fmtNum(val)}</span></button>`;
  }).join('');

  const inp = document.getElementById('topup-amount-input');
  inp.value = remaining;
  inp.max = remaining;
  document.getElementById('topup-error').textContent = '';
  onTopupInput();
  openModal('modal-topup');
  setTimeout(() => inp.select(), 50);
}

async function openEditVisit(visitId) {
  const detail = NOOR._currentPatientDetail || {};
  const visit = (detail.visits || []).find(v => v.id === visitId);
  if (!visit) return;
  await ensureLensCatalog().catch(()=>{});

  NOOR.patientModalMode = 'edit';
  NOOR.editingVisitId = visitId;
  document.getElementById('modal-patient').classList.remove('old-rx-mode');
  clearPatientForm();
  switchPatientTab('rx');

  // Fill patient info so name validation passes without forcing re-entry
  document.getElementById('p-name').value    = detail.full_name || '';
  document.getElementById('p-phone').value   = detail.phone || '';
  document.getElementById('p-age').value     = detail.age || '';
  document.getElementById('p-address').value = detail.address || '';
  document.getElementById('p-notes').value   = detail.notes || '';
  if (detail.gender) document.getElementById('p-gender').value = detail.gender;

  // Fill visit date
  document.getElementById('visit-date-group').style.display = 'block';
  document.getElementById('f-visit-date').value = visit.visit_date || '';
  document.getElementById('modal-patient-title').textContent = NOOR.lang === 'ar' ? 'تعديل الزيارة' : 'Edit Visit';

  // Fill Rx
  document.getElementById('rx-od-sph').value  = visit.od_sphere ?? '';
  document.getElementById('rx-od-cyl').value  = visit.od_cylinder ?? '';
  document.getElementById('rx-od-axis').value = visit.od_axis ?? '';
  document.getElementById('rx-od-add').value  = visit.od_addition ?? '';
  document.getElementById('rx-od-va').value   = visit.od_va ?? '';
  document.getElementById('rx-od-bcva').value = visit.od_bcva ?? '';
  document.getElementById('rx-os-sph').value  = visit.os_sphere ?? '';
  document.getElementById('rx-os-cyl').value  = visit.os_cylinder ?? '';
  document.getElementById('rx-os-axis').value = visit.os_axis ?? '';
  document.getElementById('rx-os-add').value  = visit.os_addition ?? '';
  document.getElementById('rx-os-va').value   = visit.os_va ?? '';
  document.getElementById('rx-os-bcva').value = visit.os_bcva ?? '';
  document.getElementById('rx-ipd').value     = visit.ipd ?? '';

  // Sync sign buttons
  ['rx-od-sph','rx-od-cyl','rx-os-sph','rx-os-cyl'].forEach(id => syncRxSign(id));
  onRxChange();

  // Fill lens/frame
  if (visit.lens_type) setSelectValue('rx-lens-type', visit.lens_type, catalogLabel('type', visit.lens_type));
  if (visit.lens_material) setSelectValue('rx-material', visit.lens_material, catalogLabel('material', visit.lens_material));
  renderCoatingChips((visit.lens_coating || '').split(',').filter(Boolean));
  document.getElementById('p-frame-brand').value = visit.frame_brand || '';
  if (visit.frame_type) document.getElementById('p-frame-type').value = visit.frame_type;
  if (visit.frame_material) document.getElementById('p-frame-material').value = visit.frame_material;
  // Restore no-frame toggle based on saved visit data
  setNoFrame(!(visit.frame_brand || visit.frame_price));

  // Fill financials
  document.getElementById('f-frame-price').value  = visit.frame_price || '';
  document.getElementById('f-frame-cost').value   = visit.frame_cost || '';
  document.getElementById('f-lens-price').value   = visit.lens_price || '';
  document.getElementById('f-lens-cost').value    = visit.lens_cost || '';
  document.getElementById('f-checkup-fee').value  = visit.checkup_fee || '';
  document.getElementById('f-paid').value         = visit.amount_paid || '';
  document.getElementById('f-next-visit').value   = visit.next_visit_date || '';
  document.getElementById('f-visit-notes').value  = visit.notes || '';

  if (visit.did_checkup) {
    document.getElementById('f-checkup').checked = true;
    document.getElementById('followup-date-row').style.display = 'grid';
  }

  calcTotal();
  await populateFrameInventory();
  openModal('modal-patient');
}

function topUpPatientRemaining() {
  const detail = NOOR._currentPatientDetail || {};
  const visits = (detail.visits || []).filter(v => (parseFloat(v.remaining)||0) > 0);
  const outstanding = visits.reduce((sum, v) => sum + (parseFloat(v.remaining)||0), 0);
  if (outstanding <= 0) return;
  const isAr = NOOR.lang === 'ar';

  NOOR._topupVisits = visits;
  NOOR._topupOutstanding = outstanding;

  // Set modal text
  const setT = (id, ar, en) => { const el = document.getElementById(id); if (el) el.textContent = isAr ? ar : en; };
  setT('topup-modal-title',    'تسديد المتبقي',       'Top Up Payment');
  setT('topup-outstanding-label', 'المبلغ المتبقي',   'Outstanding Amount');
  setT('topup-amount-label',   'المبلغ المدفوع (IQD)','Amount Paid (IQD)');
  setT('topup-cancel-btn',     'إلغاء',               'Cancel');
  setT('topup-submit-btn',     'تأكيد التسديد',       'Confirm Payment');

  document.getElementById('topup-outstanding-val').textContent = fmtIQD(outstanding);

  // Visits breakdown summary
  const summaryEl = document.getElementById('topup-visits-summary');
  if (visits.length === 1) {
    summaryEl.textContent = isAr ? `زيارة واحدة • ${visits[0].visit_date || ''}` : `1 visit • ${visits[0].visit_date || ''}`;
  } else {
    summaryEl.textContent = isAr ? `${visits.length} زيارات بمبالغ متبقية` : `${visits.length} visits with outstanding amounts`;
  }

  // Quick-fill buttons: 25%, 50%, 100%
  const qbtns = document.getElementById('topup-quick-btns');
  qbtns.innerHTML = ['25%','50%','75%','100%'].map(pct => {
    const val = Math.round(outstanding * parseInt(pct) / 100 / 1000) * 1000;
    return `<button type="button" class="btn btn-sm btn-outline" onclick="setTopupQuick(${val})">${pct}<br><span style="font-size:.7rem;opacity:.7">${fmtNum(val)}</span></button>`;
  }).join('');

  // Pre-fill with full amount
  const inp = document.getElementById('topup-amount-input');
  inp.value = outstanding;
  inp.max = outstanding;
  document.getElementById('topup-error').textContent = '';
  onTopupInput();
  openModal('modal-topup');
  setTimeout(() => inp.select(), 50);
}

function setTopupQuick(val) {
  document.getElementById('topup-amount-input').value = val;
  onTopupInput();
}

function onTopupInput() {
  const inp = document.getElementById('topup-amount-input');
  const errEl = document.getElementById('topup-error');
  const submitBtn = document.getElementById('topup-submit-btn');
  const outstanding = NOOR._topupOutstanding || 0;
  const val = parseFloat(inp.value) || 0;
  const isAr = NOOR.lang === 'ar';

  if (val <= 0) {
    errEl.textContent = isAr ? 'يجب أن يكون المبلغ أكبر من صفر' : 'Amount must be greater than zero';
    submitBtn.disabled = true;
  } else if (val > outstanding) {
    // Clamp silently to the max and clear error
    inp.value = outstanding;
    errEl.textContent = '';
    submitBtn.disabled = false;
  } else {
    errEl.textContent = '';
    submitBtn.disabled = false;
  }
}

async function submitTopUp() {
  const inp = document.getElementById('topup-amount-input');
  let amount = parseFloat(inp.value) || 0;
  const outstanding = NOOR._topupOutstanding || 0;
  if (amount <= 0 || amount > outstanding) return;

  const submitBtn = document.getElementById('topup-submit-btn');
  submitBtn.disabled = true;

  try {
    const visits = NOOR._topupVisits || [];
    for (const v of visits) {
      if (amount <= 0) break;
      const remaining = parseFloat(v.remaining) || 0;
      const applied = Math.min(amount, remaining);
      await put(`/api/visits/${v.id}`, { amount_paid: (parseFloat(v.amount_paid)||0) + applied });
      amount -= applied;
    }
    closeModal('modal-topup');
    toast(t('successSaved'));
    const detail = NOOR._currentPatientDetail || {};
    await renderPatients();
    await openPatientDetail(detail.id || NOOR.editingPatientId);
  } catch(e) {
    toast(e.message, 'error');
  } finally {
    submitBtn.disabled = false;
  }
}


async function deleteVisit(id) {
  if (!confirm(NOOR.lang === 'ar' ? 'حذف هذه الزيارة؟' : 'Delete this visit?')) return;
  try {
    await del(`/api/visits/${id}`);
    toast(t('successDeleted'));
    const detail = NOOR._currentPatientDetail || {};
    await renderPatients();
    if (detail.id || NOOR.editingPatientId) await openPatientDetail(detail.id || NOOR.editingPatientId);
  } catch(e) { toast(e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════
// FOLLOW-UPS
// ══════════════════════════════════════════════════════════
