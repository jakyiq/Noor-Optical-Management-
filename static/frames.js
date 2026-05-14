/* frames.js - extracted from index.html. Plain script, globals intentionally preserved. */

// ── Collapsible low-stock banner (shared by frames & lenses) ──
function toggleLowStockBanner(bannerId) {
  const banner = document.getElementById(bannerId);
  if (!banner) return;
  const body = banner.querySelector('.low-stock-body');
  const btn  = banner.querySelector('.low-stock-toggle');
  if (!body) return;
  const isExpanded = !body.hidden;
  body.hidden = isExpanded;
  banner.classList.toggle('expanded', !isExpanded);
  if (btn) btn.setAttribute('aria-expanded', String(!isExpanded));
}

async function renderFrames() {
    const tbody = document.getElementById('frames-tbody');
    const empty = document.getElementById('frames-empty');
    if (tbody) tbody.innerHTML = skeletonRows(8, 6);
    if (empty) empty.style.display = 'none';
  try {
    const data = await get('/api/frames');
    NOOR.frames = data.data || [];
    const low = NOOR.frames.filter(f=>f.quantity<=f.min_stock);
    const banner = document.getElementById('frames-low-banner');
    if (low.length) {
      banner.classList.add('show');
      document.getElementById('frames-low-items').innerHTML = low.map(f=>`<div class="low-stock-item">${esc(f.brand||'Frame')} — ${esc(f.quantity)} ${t('qty')}</div>`).join('');
      // Collapse by default; preserve open state if user already expanded
      const body = document.getElementById('frames-low-body');
      const btn  = banner.querySelector('.low-stock-toggle');
      if (body && !banner.classList.contains('expanded')) {
        body.hidden = true;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    } else {
      banner.classList.remove('show');
      banner.classList.remove('expanded');
    }
    filterFrames();
  } catch(e) { toast(e.message,'error'); }
}

function filterFrames() {
  const q = (document.getElementById('frames-search')?.value || '').toLowerCase();
  const typ = document.getElementById('frames-type-filter')?.value || '';
  const mat = document.getElementById('frames-material-filter')?.value || '';
  const list = NOOR.frames.filter(f => {
    const hay = `${f.brand||''} ${f.color||''} ${f.frame_material||''}`.toLowerCase();
    if (q && !hay.includes(q)) return false;
    if (typ && f.frame_type !== typ) return false;
    if (mat && f.frame_material !== mat) return false;
    return true;
  });
  const tbody = document.getElementById('frames-tbody');
  const empty = document.getElementById('frames-empty');
  if (!list.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display = 'none';
  tbody.innerHTML = list.map(f => {
    const st = f.quantity===0?['danger',t('out')]:f.quantity<=f.min_stock?['warning',t('low')]:['success',t('ok')];
    return `<tr>
      <td data-label="${t('brand')}">${esc(f.brand)}</td>
      <td data-label="${t('type')}">${esc((f.frame_type||'').replace(/_/g,' '))}</td>
      <td data-label="${t('material')}">${esc(f.frame_material)}</td>
      <td data-label="${t('color')}">${esc(f.color)}</td>
      <td data-label="${t('qty')}" style="font-family:'Figtree','DM Sans',sans-serif">${f.quantity}</td>
      <td data-label="${t('status')}"><span class="badge badge-${st[0]}">${st[1]}</span></td>
      <td data-label="${t('costPrice')}" style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(f.cost_price)}</td>
      <td data-label="${t('sellPrice')}" style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(f.sell_price)}</td>
      <td class="td-actions-cell">
        <button class="btn btn-outline btn-sm" onclick="openRestockModal('frame','${escAttr(f.id)}')">${t('restock')}</button>
        <button class="btn btn-outline btn-sm" onclick="openEditFrame('${escAttr(f.id)}')">${t('edit')}</button>
        <button class="btn btn-outline btn-sm" onclick="duplicateFrame('${escAttr(f.id)}')" title="${NOOR.lang==='ar'?'نسخ':'Duplicate'}" style="color:var(--ink-mid)">⧉</button>
        <button class="btn btn-sm" style="color:var(--danger);border:1.5px solid #fecaca;background:transparent" onclick="deleteFrame('${escAttr(f.id)}')">${t('delete')}</button>
      </td>
    </tr>`;
  }).join('');
}

function openAddFrame() {
  NOOR.editingFrameId = null;
  document.getElementById('modal-frame-title').textContent = t('addFrame');
  ['fr-brand','fr-color','fr-cost','fr-sell'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('fr-qty').value='0';
  document.getElementById('fr-min').value='2';
  openModal('modal-frame');
}

function openEditFrame(id) {
  const f = NOOR.frames.find(x=>x.id===id); if(!f)return;
  NOOR.editingFrameId = id;
  document.getElementById('modal-frame-title').textContent = t('edit');
  document.getElementById('fr-brand').value    = f.brand||'';
  document.getElementById('fr-type').value     = f.frame_type||'full_rim';
  document.getElementById('fr-material').value = f.frame_material||'acetate';
  document.getElementById('fr-color').value    = f.color||'';
  document.getElementById('fr-qty').value      = f.quantity;
  document.getElementById('fr-min').value      = f.min_stock;
  document.getElementById('fr-cost').value     = f.cost_price;
  document.getElementById('fr-sell').value     = f.sell_price;
  openModal('modal-frame');
}

function duplicateFrame(id) {
  const f = NOOR.frames.find(x=>x.id===id); if(!f)return;
  NOOR.editingFrameId = null;
  document.getElementById('modal-frame-title').textContent = (NOOR.lang==='ar' ? 'نسخ إطار' : 'Duplicate Frame');
  document.getElementById('fr-brand').value    = f.brand||'';
  document.getElementById('fr-type').value     = f.frame_type||'full_rim';
  document.getElementById('fr-material').value = f.frame_material||'acetate';
  document.getElementById('fr-color').value    = f.color||'';
  document.getElementById('fr-qty').value      = f.quantity;
  document.getElementById('fr-min').value      = f.min_stock;
  document.getElementById('fr-cost').value     = f.cost_price;
  document.getElementById('fr-sell').value     = f.sell_price;
  openModal('modal-frame');
}

async function saveFrame() {
  const body = {
    brand:          document.getElementById('fr-brand').value,
    frame_type:     document.getElementById('fr-type').value,
    frame_material: document.getElementById('fr-material').value,
    color:          document.getElementById('fr-color').value,
    quantity:       parseInt(document.getElementById('fr-qty').value)||0,
    min_stock:      parseInt(document.getElementById('fr-min').value)||2,
    cost_price:     parseFloat(document.getElementById('fr-cost').value)||0,
    sell_price:     parseFloat(document.getElementById('fr-sell').value)||0,
  };
  try {
    if (NOOR.editingFrameId) await put(`/api/frames/${NOOR.editingFrameId}`, body);
    else await post('/api/frames', body);
    closeModal('modal-frame'); toast(t('successSaved')); await renderFrames();
  } catch(e) { toast(e.message,'error'); }
}

async function deleteFrame(id) {
  if (!confirm(NOOR.lang==='ar'?'حذف هذا الإطار؟':'Delete frame?')) return;
  try { await del(`/api/frames/${id}`); toast(t('successDeleted')); await renderFrames(); }
  catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// RESTOCK
// ══════════════════════════════════════════════════════════
function openRestockModal(type, id) {
  NOOR.restockTarget = {type, id};
  document.getElementById('restock-qty').value = '10';
  openModal('modal-restock');
}

async function confirmRestock() {
  if (!NOOR.restockTarget) return;
  const qty = parseInt(document.getElementById('restock-qty').value)||0;
  const {type, id} = NOOR.restockTarget;
  try {
    const path = type==='lens' ? `/api/lenses/${id}/restock` : `/api/frames/${id}/restock`;
    await post(path, { quantity: qty });
    closeModal('modal-restock'); toast(t('successSaved'));
    if (type==='lens') await renderLenses(); else await renderFrames();
  } catch(e) { toast(e.message,'error'); }
}

// ══════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════
