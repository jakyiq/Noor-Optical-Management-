/* lenses.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function ensureLensCatalog(force=false) {
  if (!force && NOOR.lensCatalog?.type?.length) return NOOR.lensCatalog;
  const data = await get('/api/lens-catalog');
  NOOR.lensCatalog = data.data || { type: [], material: [], coating: [] };
  populateLensCatalogControls();
  return NOOR.lensCatalog;
}

function activeCatalog(category) {
  return (NOOR.lensCatalog?.[category] || []).filter(x => x.is_active !== false);
}

function catalogLabel(category, value) {
  const item = (NOOR.lensCatalog?.[category] || []).find(x => x.value === value);
  return item?.label || String(value || '').replace(/_/g, ' ');
}

function optionHTML(items, includeAllLabel) {
  const opts = includeAllLabel ? [`<option value="">${includeAllLabel}</option>`] : [];
  items.forEach(item => opts.push(`<option value="${escAttr(item.value)}">${esc(item.label)}</option>`));
  return opts.join('');
}

function populateSelectPreserve(id, html) {
  const el = document.getElementById(id);
  if (!el) return;
  const prev = [...el.selectedOptions].map(o => o.value);
  el.innerHTML = html;
  [...el.options].forEach(o => { if (prev.includes(o.value)) o.selected = true; });
}

function setSelectValue(id, value, label) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = value || '';
  if (val && ![...el.options].some(o => o.value === val)) {
    el.insertAdjacentHTML('beforeend', `<option value="${escAttr(val)}">${esc(label || val)}</option>`);
  }
  el.value = val;
}

function populateLensCatalogControls() {
  populateSelectPreserve('lens-type-filter', optionHTML(activeCatalog('type'), t('allTypes')));
  populateSelectPreserve('lens-material-filter', optionHTML(activeCatalog('material'), t('allMaterials')));
  populateSelectPreserve('rx-lens-type', optionHTML(activeCatalog('type')));
  populateSelectPreserve('rx-material', optionHTML(activeCatalog('material')));
  populateSelectPreserve('l-type', optionHTML(activeCatalog('type')));
  populateSelectPreserve('l-material', optionHTML(activeCatalog('material')));
  populateSelectPreserve('l-coating', optionHTML(activeCatalog('coating')));
  renderCoatingChips();
}

function renderCoatingChips(selectedValues) {
  const cont = document.getElementById('coating-chips');
  if (!cont) return;
  const selected = new Set(selectedValues || [...cont.querySelectorAll('.coating-chip.selected')].map(c => c.dataset.val));
  cont.innerHTML = activeCatalog('coating').map(item =>
    `<div class="coating-chip ${selected.has(item.value) ? 'selected' : ''}" data-val="${escAttr(item.value)}" onclick="toggleCoating(this)">${esc(item.label)}</div>`
  ).join('');
}

function catalogTextarea(category) {
  return (NOOR.lensCatalog?.[category] || []).map(item => item.label === item.value ? item.label : `${item.label} | ${item.value}`).join('\n');
}

function parseCatalogTextarea(id) {
  return (document.getElementById(id)?.value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map((line, idx) => {
    const parts = line.split('|').map(x => x.trim()).filter(Boolean);
    return { label: parts[0], value: parts[1] || parts[0], is_active: true, sort_order: idx };
  });
}

function fillWizardCatalogTextareas() {
  document.getElementById('wiz-cat-type').value = catalogTextarea('type');
  document.getElementById('wiz-cat-material').value = catalogTextarea('material');
  document.getElementById('wiz-cat-coating').value = catalogTextarea('coating');
}

function fillWizardMultiselects() {
  populateSelectPreserve('wiz-types', optionHTML(activeCatalog('type')));
  populateSelectPreserve('wiz-materials', optionHTML(activeCatalog('material')));
  populateSelectPreserve('wiz-coatings', optionHTML(activeCatalog('coating')));
  ['wiz-types','wiz-materials','wiz-coatings'].forEach(id => {
    const el = document.getElementById(id);
    if (el && ![...el.selectedOptions].length && el.options[0]) el.options[0].selected = true;
    if (el && !el._wizPreviewBound) {
      el.addEventListener('change', updateLensWizardPreview);
      el._wizPreviewBound = true;
    }
  });
  updateLensWizardPreview();
}

async function openLensWizard() {
  closeMoreMenu();
  await ensureLensCatalog();
  fillWizardCatalogTextareas();
  fillWizardMultiselects();
  openModal('modal-lens-wizard');
}

async function saveLensWizardCatalog() {
  const body = {
    type: parseCatalogTextarea('wiz-cat-type'),
    material: parseCatalogTextarea('wiz-cat-material'),
    coating: parseCatalogTextarea('wiz-cat-coating'),
  };
  const data = await put('/api/lens-catalog', body);
  NOOR.lensCatalog = data.data || body;
  populateLensCatalogControls();
  fillWizardMultiselects();
  toast(t('successSaved'));
}

function rangeCount(start, end, step) {
  start = parseFloat(start); end = parseFloat(end); step = Math.abs(parseFloat(step) || .25);
  if ([start,end,step].some(Number.isNaN) || step <= 0) return 0;
  return Math.floor(Math.abs(end - start) / step + 0.0001) + 1;
}

function selectedValues(id) {
  return [...(document.getElementById(id)?.selectedOptions || [])].map(o => o.value).filter(Boolean);
}

function lensWizardCount() {
  const sphCount = rangeCount(document.getElementById('wiz-sph-start').value, document.getElementById('wiz-sph-end').value, document.getElementById('wiz-sph-step').value);
  const cylCount = rangeCount(document.getElementById('wiz-cyl-start').value, document.getElementById('wiz-cyl-end').value, document.getElementById('wiz-cyl-step').value);
  return selectedValues('wiz-types').length * selectedValues('wiz-materials').length * selectedValues('wiz-coatings').length * sphCount * cylCount;
}

function updateLensWizardPreview() {
  const count = lensWizardCount();
  const el = document.getElementById('wiz-preview');
  if (el) el.textContent = `${fmtNum(count)} lens rows will be generated.${count > 500 ? ' Large generation will require confirmation.' : ''}`;
}

async function runLensWizard() {
  const count = lensWizardCount();
  if (!count) { toast('Choose catalog items and valid ranges first', 'error'); return; }
  let confirmLarge = false;
  if (count > 500) {
    confirmLarge = confirm(`${fmtNum(count)} lens rows will be generated. Continue?`);
    if (!confirmLarge) return;
  }
  const btn = document.getElementById('wiz-save-btn');
  if (btn) btn.disabled = true;
  try {
    const payload = {
      lens_types: selectedValues('wiz-types'),
      materials: selectedValues('wiz-materials'),
      coatings: selectedValues('wiz-coatings'),
      existing_mode: document.getElementById('wiz-existing-mode').value,
      confirm_large: confirmLarge,
      ranges: {
        sphere_start: document.getElementById('wiz-sph-start').value,
        sphere_end: document.getElementById('wiz-sph-end').value,
        sphere_step: document.getElementById('wiz-sph-step').value,
        cylinder_start: document.getElementById('wiz-cyl-start').value,
        cylinder_end: document.getElementById('wiz-cyl-end').value,
        cylinder_step: document.getElementById('wiz-cyl-step').value,
      },
      defaults: {
        quantity: document.getElementById('wiz-qty').value || 0,
        min_stock: document.getElementById('wiz-min').value || 2,
        cost_price: document.getElementById('wiz-cost').value || 0,
        sell_price: document.getElementById('wiz-sell').value || 0,
      },
    };
    const res = await post('/api/lenses/bulk-generate', payload);
    const d = res.data || {};
    toast(`Generated ${fmtNum(d.generated)}: ${fmtNum(d.inserted)} new, ${fmtNum(d.updated)} updated, ${fmtNum(d.skipped)} skipped`);
    closeModal('modal-lens-wizard');
    await renderLenses();
  } catch(e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function renderLenses() {
  const cached = getCachedApiData('/api/lenses');
  if (cached?.data) {
    NOOR.lenses = cached.data || [];
    filterLenses();
  } else {
    const tbody = document.getElementById('lenses-tbody');
    const empty = document.getElementById('lenses-empty');
    if (tbody) tbody.innerHTML = skeletonRows(9, 7);
    if (empty) empty.style.display = 'none';
  }
  try {
    await ensureLensCatalog();
    const data = await get('/api/lenses');
    NOOR.lenses = data.data || [];
    const low = NOOR.lenses.filter(l=>l.quantity<=l.min_stock).slice(0, 40);
    const banner = document.getElementById('lenses-low-banner');
    if (low.length) {
      banner.classList.add('show');
      document.getElementById('lenses-low-items').innerHTML = low.map(l=>`<div class="low-stock-item">SPH ${esc(l.sphere)} CYL ${esc(l.cylinder||0)} — ${esc(l.quantity)} ${t('qty')}</div>`).join('');
      // Collapse by default; preserve open state if user already expanded
      const body = document.getElementById('lenses-low-body');
      const btn  = banner.querySelector('.low-stock-toggle');
      if (body && !banner.classList.contains('expanded')) {
        body.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    } else {
      banner.classList.remove('show');
      banner.classList.remove('expanded');
    }
    filterLenses();
  } catch(e) { toast(e.message,'error'); }
}

function baseLensRenderLimit() {
  return isMobile() ? 80 : 250;
}

function loadMoreLenses() {
  NOOR.lensRenderLimit = (NOOR.lensRenderLimit || baseLensRenderLimit()) + baseLensRenderLimit();
  filterLenses(false);
}

function filterLenses(resetLimit = true) {
  if (resetLimit) NOOR.lensRenderLimit = baseLensRenderLimit();
  const typ = document.getElementById('lens-type-filter')?.value||'';
  const mat = document.getElementById('lens-material-filter')?.value||'';
  const sphRaw = document.getElementById('lens-sph-filter')?.value;
  const cylRaw = document.getElementById('lens-cyl-filter')?.value;
  const stock = document.getElementById('lens-stock-filter')?.value||'';
  const sph = sphRaw === '' ? null : parseFloat(sphRaw);
  const cyl = cylRaw === '' ? null : parseFloat(cylRaw);
  const list = NOOR.lenses.filter(l => {
    if (typ && l.lens_type !== typ) return false;
    if (mat && l.material !== mat) return false;
    if (sph !== null && Math.abs((Number(l.sphere)||0) - sph) > .001) return false;
    if (cyl !== null && Math.abs((Number(l.cylinder)||0) - cyl) > .001) return false;
    if (stock === 'low' && !((l.quantity||0) <= (l.min_stock||0))) return false;
    if (stock === 'out' && (l.quantity||0) !== 0) return false;
    return true;
  });
  const tbody = document.getElementById('lenses-tbody');
  const empty = document.getElementById('lenses-empty');
  const loadWrap = document.getElementById('lenses-load-wrap');
  const countEl = document.getElementById('lenses-render-count');
  if (!list.length) {
    tbody.innerHTML='';
    empty.style.display='block';
    if (loadWrap) loadWrap.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  const visible = list.slice(0, NOOR.lensRenderLimit || baseLensRenderLimit());
  if (loadWrap) loadWrap.style.display = list.length > visible.length ? 'flex' : 'none';
  if (countEl) countEl.textContent = `Showing ${fmtNum(visible.length)} of ${fmtNum(list.length)}`;
  tbody.innerHTML = visible.map(l => {
    const st = l.quantity===0?['danger',t('out')]:l.quantity<=l.min_stock?['warning',t('low')]:['success',t('ok')];
    return `<tr>
      <td class="td-name">${esc(catalogLabel('type', l.lens_type))}</td>
      <td data-label="${t('material')}">${esc(catalogLabel('material', l.material))}</td>
      <td data-label="${t('coating')}">${esc(catalogLabel('coating', l.coating))}</td>
      <td data-label="SPH" style="font-family:'Figtree','DM Sans',sans-serif">${l.sphere>0?'+':''}${l.sphere}</td>
      <td data-label="CYL" style="font-family:'Figtree','DM Sans',sans-serif">${esc(l.cylinder||0)}</td>
      <td data-label="${t('qty')}" style="font-family:'Figtree','DM Sans',sans-serif">${l.quantity}</td>
      <td data-label="${t('status')}"><span class="badge badge-${st[0]}">${st[1]}</span></td>
      <td data-label="${t('sellPrice')}" style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(l.sell_price)}</td>
      <td class="td-actions-cell">
        <button class="btn btn-outline btn-sm" onclick="openRestockModal('lens','${escAttr(l.id)}')">${t('restock')}</button>
        <button class="btn btn-outline btn-sm" onclick="openEditLens('${escAttr(l.id)}')">${t('edit')}</button>
        <button class="btn btn-outline btn-sm" onclick="duplicateLens('${escAttr(l.id)}')" title="${NOOR.lang==='ar'?'نسخ':'Duplicate'}">${NOOR.lang==='ar'?'نسخ':'Copy'}</button>
        <button class="btn btn-sm" style="color:var(--danger);border:1.5px solid #fecaca;background:transparent" onclick="deleteLens('${escAttr(l.id)}')">${t('delete')}</button>
      </td>
    </tr>`;
  }).join('');
}

function stepSph(id, delta) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = parseFloat(el.value) || 0;
  el.value = Math.round((val + delta) * 100) / 100;
}

function duplicateLens(id) {
  const l = NOOR.lenses.find(x=>x.id===id); if(!l)return;
  NOOR.editingLensId = null;
  document.getElementById('modal-lens-title').textContent = NOOR.lang==='ar' ? 'نسخ عدسة' : 'Duplicate Lens';
  setSelectValue('l-type', l.lens_type, catalogLabel('type', l.lens_type));
  setSelectValue('l-material', l.material, catalogLabel('material', l.material));
  setSelectValue('l-coating', l.coating, catalogLabel('coating', l.coating));
  document.getElementById('l-sph').value      = l.sphere;
  document.getElementById('l-cyl').value      = l.cylinder||0;
  document.getElementById('l-qty').value      = l.quantity;
  document.getElementById('l-min').value      = l.min_stock;
  document.getElementById('l-cost').value     = l.cost_price;
  document.getElementById('l-sell').value     = l.sell_price;
  openModal('modal-lens');
}

function openAddLens() {
  NOOR.editingLensId = null;
  populateLensCatalogControls();
  document.getElementById('modal-lens-title').textContent = t('addLens');
  ['l-sph','l-cyl','l-cost','l-sell'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('l-qty').value='0';
  document.getElementById('l-min').value='2';
  openModal('modal-lens');
}

function openEditLens(id) {
  const l = NOOR.lenses.find(x=>x.id===id); if(!l)return;
  NOOR.editingLensId = id;
  document.getElementById('modal-lens-title').textContent = t('edit');
  setSelectValue('l-type', l.lens_type, catalogLabel('type', l.lens_type));
  setSelectValue('l-material', l.material, catalogLabel('material', l.material));
  setSelectValue('l-coating', l.coating, catalogLabel('coating', l.coating));
  document.getElementById('l-sph').value     = l.sphere;
  document.getElementById('l-cyl').value     = l.cylinder||0;
  document.getElementById('l-qty').value     = l.quantity;
  document.getElementById('l-min').value     = l.min_stock;
  document.getElementById('l-cost').value    = l.cost_price;
  document.getElementById('l-sell').value    = l.sell_price;
  openModal('modal-lens');
}

async function saveLens() {
  const sph = parseFloat(document.getElementById('l-sph').value);
  if (isNaN(sph)) { toast(t('errorRequired'),'error'); return; }
  const body = {
    lens_type:  document.getElementById('l-type').value,
    material:   document.getElementById('l-material').value,
    coating:    document.getElementById('l-coating').value,
    sphere:     sph,
    cylinder:   parseFloat(document.getElementById('l-cyl').value)||0,
    quantity:   parseInt(document.getElementById('l-qty').value)||0,
    min_stock:  parseInt(document.getElementById('l-min').value)||2,
    cost_price: parseFloat(document.getElementById('l-cost').value)||0,
    sell_price: parseFloat(document.getElementById('l-sell').value)||0,
  };
  try {
    if (NOOR.editingLensId) await put(`/api/lenses/${NOOR.editingLensId}`, body);
    else await post('/api/lenses', body);
    closeModal('modal-lens'); toast(t('successSaved')); await renderLenses();
  } catch(e) { toast(e.message,'error'); }
}

async function deleteLens(id) {
  if (!confirm(NOOR.lang==='ar'?'حذف هذه العدسة؟':'Delete lens?')) return;
  try { await del(`/api/lenses/${id}`); toast(t('successDeleted')); await renderLenses(); }
  catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// FRAMES
// ══════════════════════════════════════════════════════════
