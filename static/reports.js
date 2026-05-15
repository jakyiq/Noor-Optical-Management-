/* reports.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function renderReports() {
  const from = document.getElementById('report-from');
  const to   = document.getElementById('report-to');
  document.getElementById('sale-date').value ||= todayStr();
  document.getElementById('expense-start').value ||= todayStr();
  if (!from.value) {
    const n = new Date();
    from.value = new Date(n.getFullYear(),n.getMonth(),1).toISOString().split('T')[0];
    to.value   = todayStr();
  }
  await loadReports();
}

async function loadReports() {
  const from = document.getElementById('report-from').value;
  const to   = document.getElementById('report-to').value;
  const reportPath = `/api/reports/summary?from=${from}&to=${to}`;
    ['rep-revenue','rep-outstanding','rep-expenses','rep-profit','rep-patients','rep-new-patients'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<span class="skeleton-line short" style="display:inline-block;width:70px"></span>';
    });
    const tbody = document.getElementById('reports-tbody');
    if (tbody) tbody.innerHTML = skeletonRows(7, 6);
  try {
    const data = await get(reportPath);
    const s = data.data;
    document.getElementById('rep-revenue').textContent     = fmtNum(s.total_revenue);
    document.getElementById('rep-outstanding').textContent = fmtNum(s.total_outstanding);
    document.getElementById('rep-expenses').textContent    = fmtNum(s.operating_costs || 0);
    document.getElementById('rep-profit').textContent      = fmtNum(s.gross_profit || 0);
    document.getElementById('rep-patients').textContent    = s.patients_seen;
    document.getElementById('rep-new-patients').textContent= s.new_patients;
    NOOR.reportChartItems = s.chart_items || [];
    renderReportDonut();
    renderRetailSalesList(s.retail_sales || []);
    renderExpensesList(s.expenses || []);
    const tbody = document.getElementById('reports-tbody');
    tbody.innerHTML = (s.visits||[]).map(v => {
      const p = getPatient(v.patient_id) || { full_name: v.patient_name, phone: v.patient_phone };
      const cachedId = cacheRxSlip(v);
      return `<tr>
        <td class="td-name">${esc(p?.full_name)}</td>
        <td data-label="${t('date')}">${fmtDate(v.visit_date)}</td>
        <td data-label="${NOOR.lang==='ar'?'نوع العدسة':'Lens'}">${esc((v.lens_type||'').replace(/_/g,' '))}</td>
        <td data-label="${t('total')}" style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(v.total_amount)}</td>
        <td data-label="${t('paid')}" style="font-family:'Figtree','DM Sans',sans-serif">${fmtNum(v.amount_paid)}</td>
        <td data-label="${t('remaining')}" style="font-family:'Figtree','DM Sans',sans-serif;color:var(${v.remaining>0?'--danger':'--success'})">${fmtNum(v.remaining)}</td>
        <td class="td-actions-cell">
          <button class="btn btn-outline btn-sm" onclick="showRxSlipFromData('${escAttr(cachedId)}')">${t('slip')}</button>
        </td>
      </tr>`;
    }).join('');
  } catch(e) { toast(e.message,'error'); }
}

function reportColor(i, kind) {
  const palettes = {
    lens:['#6b1a2a','#8b2a3e','#b64b5f','#d97b8a'],
    frame:['#c49a3c','#d9b85f','#a87618','#e7c978'],
    retail:['#1e7e5a','#2aa876','#68c79a','#0f5d44'],
    expense:['#c0392b','#d4820a','#8a4f2b','#6d3b24'],
    service:['#4267b2','#5b7fd0','#7da0ee']
  };
  const p = palettes[kind] || ['#4a3f35','#8a7d70'];
  return p[i % p.length];
}

function donutArc(cx, cy, r, start, end) {
  const polar = a => {
    const rad = (a - 90) * Math.PI / 180;
    return {x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad)};
  };
  const s = polar(end), e = polar(start);
  const large = end - start <= 180 ? 0 : 1;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 0 ${e.x} ${e.y}`;
}

function renderReportDonut() {
  const svg = document.getElementById('report-donut');
  const legend = document.getElementById('donut-legend');
  const items = (NOOR.reportChartItems || []).filter(x => !NOOR.reportHiddenItems.has(x.key) && (x.amount || 0) > 0);
  const all = NOOR.reportChartItems || [];
  const total = items.reduce((sum, x) => sum + (parseFloat(x.amount)||0), 0);
  document.getElementById('donut-total').textContent = fmtNum(total);
  document.getElementById('donut-active-count').textContent = `${items.length}/${all.length}`;
  if (!total) {
    svg.innerHTML = `<circle cx="110" cy="110" r="82" fill="none" stroke="var(--cream-border)" stroke-width="28" stroke-linecap="round"></circle>`;
    legend.innerHTML = `<div class="mini-report-sub">No report items yet</div>`;
    return;
  }
  const GAP_DEG = items.length > 1 ? 2 : 0;
  let angle = 0;
  // Track ring behind
  let markup = `<circle cx="110" cy="110" r="82" fill="none" stroke="var(--cream-border)" stroke-width="28" opacity=".35"></circle>`;
  markup += items.map((item, i) => {
    const size = (parseFloat(item.amount)||0) / total * (360 - GAP_DEG * items.length);
    const start = angle;
    const end = angle + size;
    angle += size + GAP_DEG;
    const path = donutArc(110, 110, 82, start, end);
    const col = reportColor(i, item.kind);
    return `<path class="donut-seg" data-key="${escAttr(item.key)}" d="${path}" fill="none" stroke="${col}" stroke-width="28" stroke-linecap="round" onclick="toggleReportItem(this.dataset.key)"><title>${esc(item.label)}: ${fmtIQD(item.amount)}</title></path>`;
  }).join('');
  svg.innerHTML = markup;
  legend.innerHTML = all.map((item, i) => {
    const hidden = NOOR.reportHiddenItems.has(item.key);
    const col = reportColor(i, item.kind);
    const pct = total ? Math.round((parseFloat(item.amount)||0) / total * 100) : 0;
    return `<div class="donut-legend-item ${hidden?'hidden':''}" data-key="${escAttr(item.key)}" onclick="toggleReportItem(this.dataset.key)">
      <span class="donut-dot" style="background:${col}"></span>
      <span>
        <span class="donut-legend-name">${esc(item.label)}</span>
        <br><span class="donut-legend-meta">${esc(item.kind)} · ${item.count||0} · <b>${pct}%</b></span>
      </span>
      <span class="donut-legend-val">${fmtNum(item.amount)}</span>
    </div>`;
  }).join('');
}

function toggleReportItem(key) {
  if (NOOR.reportHiddenItems.has(key)) NOOR.reportHiddenItems.delete(key);
  else NOOR.reportHiddenItems.add(key);
  renderReportDonut();
}

function renderRetailSalesList(rows) {
  const el = document.getElementById('retail-sales-list');
  if (!rows.length) { el.innerHTML = `<div class="mini-report-sub">No retail sales in this range.</div>`; return; }
  el.innerHTML = rows.slice(0, 8).map(r => {
    const qty = parseInt(r.quantity)||1;
    return `<div class="mini-report-row"><div><div class="mini-report-title">${esc(r.item_name)}</div><div class="mini-report-sub">${esc((r.item_type||'misc').replace(/_/g,' '))} · ${fmtDate(r.sale_date)} · Qty ${qty}</div></div><div class="mini-report-val">${fmtIQD((parseFloat(r.selling_price)||0)*qty)}</div></div>`;
  }).join('');
}

function renderExpensesList(rows) {
  const el = document.getElementById('expenses-list');
  if (!rows.length) { el.innerHTML = `<div class="mini-report-sub">No operating costs in this range.</div>`; return; }
  el.innerHTML = rows.slice(0, 8).map(r =>
    `<div class="mini-report-row"><div><div class="mini-report-title">${esc(r.name)}</div><div class="mini-report-sub">${esc(r.expense_type)} · ${esc(r.frequency)} · ${r.occurrences||0}x</div></div><div class="mini-report-val">${fmtIQD(r.effective_amount)}</div></div>`
  ).join('');
}

async function saveRetailSale() {
  const itemType = document.getElementById('sale-item-type').value;
  const name = document.getElementById('sale-item-name').value.trim() || itemType.replace(/_/g,' ');
  try {
    await post('/api/retail-sales', {
      item_name: name,
      item_type: itemType,
      quantity: parseInt(document.getElementById('sale-qty').value)||1,
      sale_date: document.getElementById('sale-date').value || todayStr(),
      cost_price: parseFloat(document.getElementById('sale-cost').value)||0,
      selling_price: parseFloat(document.getElementById('sale-price').value)||0,
    });
    ['sale-item-name','sale-cost','sale-price'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('sale-qty').value = '1';
    toast(t('successSaved'));
    await loadReports();
  } catch(e) { toast(e.message,'error'); }
}

async function saveOperatingExpense() {
  const type = document.getElementById('expense-type').value;
  const name = document.getElementById('expense-name').value.trim() || type;
  try {
    await post('/api/operating-expenses', {
      name,
      expense_type: type,
      frequency: document.getElementById('expense-frequency').value,
      starts_on: document.getElementById('expense-start').value || todayStr(),
      amount: parseFloat(document.getElementById('expense-amount').value)||0,
    });
    ['expense-name','expense-amount'].forEach(id => document.getElementById(id).value = '');
    toast(t('successSaved'));
    await loadReports();
  } catch(e) { toast(e.message,'error'); }
}

// ── Trial paywall guard for export features ──────────────────
function _checkExportAllowed() {
  const lic = NOOR.license;
  if (NOOR.role === 'super_admin') return true; // super admin always allowed
  if (!lic || lic.exports_allowed === false) {
    const isAr = NOOR.lang === 'ar';
    toast(
      isAr
        ? '⭐ التصدير متاح للاشتراكات المدفوعة فقط. يرجى الترقية للوصول إلى هذه الميزة.'
        : '⭐ Export is available on paid plans only. Please upgrade to unlock this feature.',
      'warning',
      6000
    );
    return false;
  }
  return true;
}

async function exportExcel() {
  if (!_checkExportAllowed()) return;
  if (typeof XLSX==='undefined') { toast('Loading...','warning'); return; }
  try {
    const from = document.getElementById('report-from')?.value || '';
    const to   = document.getElementById('report-to')?.value   || '';
    const data = await get('/api/reports/export/excel?from='+from+'&to='+to);
    const rows = data.data || [];
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, 'noor_report.xlsx');
  } catch(e) { toast(e.message,'error'); }
}

async function exportPDF() {
  if (!_checkExportAllowed()) return;
  try {
    const from = document.getElementById('report-from')?.value||'';
    const to   = document.getElementById('report-to')?.value||'';
    // Bug fix #17: use the PDF endpoint, not the Excel endpoint
    const data = await get(`/api/reports/export/pdf?from=${from}&to=${to}`);
    const rows = data.data || [];
    const dir = NOOR.lang === 'ar' ? 'rtl' : 'ltr';
    const bodyRows = rows.map(r => `<tr><td>${esc(r.Date)}</td><td>${esc(r.Patient)}</td><td>${esc(r.Phone)}</td><td>${esc(r['Lens Type'])}</td><td>${esc(r.Total)}</td><td>${esc(r.Paid)}</td><td>${esc(r.Remaining)}</td></tr>`).join('');
    const html = `<!doctype html><html lang="${NOOR.lang}" dir="${dir}"><head><meta charset="utf-8"><title>Noor Report</title><style>body{font-family:Arial,Tahoma,sans-serif;padding:24px;color:#1a1410}h1{font-size:22px;margin:0 0 6px;color:#6b1a2a}.meta{color:#666;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ddd;padding:7px;text-align:start}th{background:#faf6f0;color:#6b1a2a}@media print{@page{size:A4;margin:12mm}}</style></head><body><h1>Noor Optical Clinic - Report</h1><div class="meta">${esc(from)} - ${esc(to)}</div><table><thead><tr><th>Date</th><th>Patient</th><th>Phone</th><th>Lens</th><th>Total</th><th>Paid</th><th>Remaining</th></tr></thead><tbody>${bodyRows}</tbody></table></body></html>`;
    // Bug fix #18: guard against popup blockers returning null from window.open
    const win = window.open('', '_blank');
    if (!win) {
      toast(NOOR.lang === 'ar' ? 'تعذّر فتح نافذة الطباعة — يرجى السماح بالنوافذ المنبثقة.' : 'Popup blocked — please allow popups for this site to print.', 'warning', 5000);
      return;
    }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  } catch(e) { toast(e.message,'error'); }
}

// Rx Slip — from visit ID
async function showRxSlip(vid) {
  try {
    const data = await get(`/api/visits/${vid}/print`);
    _renderRxSlip(data.data);
    openModal('modal-rx-slip');
  } catch(e) { toast(e.message,'error'); }
}

// Rx Slip — from already-loaded visit object (reports table)
// Store visit data in a map keyed by visit id to avoid inline JSON in onclick attrs
NOOR._rxSlipCache = {};
function cacheRxSlip(v) {
  NOOR._rxSlipCache[v.id] = v;
  return v.id;
}
function showRxSlipFromData(vid) {
  const v = NOOR._rxSlipCache[vid];
  if (!v) { toast('Visit data not found','error'); return; }
  _renderRxSlip({ visit: v, patient: getPatient(v.patient_id), clinic: {name:NOOR.clinicName}, settings: NOOR.settings });
  openModal('modal-rx-slip');
}

function _renderRxSlip(payload) {
  const v  = payload.visit || payload;
  const p  = payload.patient || getPatient(v.patient_id) || {};
  const cl = payload.clinic  || {name: NOOR.clinicName};
  const st = payload.settings || NOOR.settings || {};
  const showFinancials = st.print_show_financials !== false;

  // Store patient name and visit date globally for filename use
  window._rxPrintPatientName = p.full_name || '';
  window._rxPrintVisitDate   = v.visit_date ? v.visit_date.slice(0,10) : new Date().toISOString().slice(0,10);

  // Logo
  const logoSrc   = st.print_logo_data || cl.logo_url || '';
  const logoW     = parseInt(st.print_logo_width)  || 120;
  const logoH     = parseInt(st.print_logo_height) || 60;
  const logoAlign = st.print_logo_align || 'center';
  const logoStyle = logoAlign==='center'?'margin:0 auto':logoAlign==='right'?'margin-left:auto':'margin-right:auto';
  const logoBlock = logoSrc
    ? `<img src="${escAttr(logoSrc)}" alt="" style="width:${logoW}px;height:${logoH}px;object-fit:contain;display:block;${logoStyle}">`
    : '';
  const headerTA  = logoAlign;

  // Header identity
  const doctorName  = st.print_doctor_name || '';
  const doctorCred  = st.print_doctor_credentials || st.print_certification_text || '';
  const extraHeader = st.print_header_text || '';
  const clinicPhone = cl.phone || '';

  // Associates
  let associates = [];
  try { associates = JSON.parse(st.print_associates || '[]'); } catch(e) {}

  // QR
  const qrSrc = st.print_qr_data || st.print_qr_url || '';

  // Dates
  const visitDateStr = fmtDate(v.visit_date);
  const nextVisitStr = v.next_visit_date ? fmtDate(v.next_visit_date) : '—';

  // Lens / frame
  const lensDesc  = [
    (v.lens_type||'').replace(/_/g,' '),
    v.lens_material,
    v.lens_coating
  ].filter(Boolean).join(' · ');
  const frameDesc = [
    v.frame_brand,
    (v.frame_type||'').replace(/_/g,' ')
  ].filter(Boolean).join(' · ');

  // Associates block
  const assocHTML = associates.length ? `
    <div style="border-top:1px dashed var(--cream-border);padding-top:6px;margin-top:6px;display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:5px;font-size:.7rem;color:var(--ink-mid)">
      ${associates.map(a => `<div>
        ${a.name   ? `<div style="font-weight:700;color:var(--ink-dark)">${esc(a.name)}</div>` : ''}
        ${a.role   ? `<div style="color:var(--ink-light)">${esc(a.role)}</div>` : ''}
        ${a.phone  ? `<div>${esc(a.phone)}</div>` : ''}
        ${a.address? `<div style="color:var(--ink-light)">${esc(a.address)}</div>` : ''}
      </div>`).join('')}
    </div>` : '';

  document.getElementById('rx-slip-content').innerHTML = `
<div class="rx-slip" style="box-sizing:border-box;width:100%;padding:10px 12px;font-size:.842rem;line-height:1.45">

  <!-- HEADER -->
  <div style="text-align:${headerTA};margin-bottom:9px">
    ${logoBlock}
    <div style="font-family:'Amiri',serif;font-size:1.1rem;font-weight:700;color:var(--burgundy);margin-top:${logoBlock?'5px':'0'};white-space:normal;word-break:break-word;overflow:visible">${esc(cl.name || NOOR.clinicName)}</div>
    ${doctorName  ? `<div style="font-size:.82rem;font-weight:600;color:var(--ink-dark);margin-top:1px">${esc(doctorName)}</div>` : ''}
    ${doctorCred  ? `<div style="font-size:.73rem;color:var(--ink-light)">${esc(doctorCred)}</div>` : ''}
    ${clinicPhone ? `<div style="font-size:.73rem;color:var(--ink-mid);margin-top:1px;display:inline-flex;align-items:center;gap:4px"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.36 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.27 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.09 8.91a16 16 0 0 0 6.29 6.29l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>${esc(clinicPhone)}</div>` : ''}
    ${extraHeader ? `<div style="font-size:.73rem;color:var(--ink-light);margin-top:1px">${esc(extraHeader)}</div>` : ''}
  </div>

  <!-- DIVIDER BAR -->
  <div style="border-top:2px solid var(--burgundy);border-bottom:1px solid var(--cream-border);display:flex;justify-content:space-between;align-items:center;padding:3px 0;margin-bottom:9px">
    <span style="font-size:.68rem;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--burgundy)">${t('prescriptionSlip')}</span>
    <span style="font-family:'Figtree','DM Sans',sans-serif;font-size:.7rem;color:var(--ink-light)">${visitDateStr}</span>
  </div>

  <!-- PATIENT INFO -->
  <div style="display:grid;grid-template-columns:1.6fr .7fr .7fr;gap:5px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--cream-border)">
    <div><div class="rx-slip-label">${t('name')}</div><div class="rx-slip-val" data-rx-patient style="font-size:.87rem">${esc(p.full_name)}</div></div>
    <div><div class="rx-slip-label">${t('age')}</div><div class="rx-slip-val">${esc(p.age)}</div></div>
    <div><div class="rx-slip-label">${t('gender')}</div><div class="rx-slip-val">${p.gender ? t(p.gender) : '—'}</div></div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--cream-border)">
    <div><div class="rx-slip-label">Visit Date</div><div class="rx-slip-val">${visitDateStr}</div></div>
    <div><div class="rx-slip-label">Next Visit</div><div class="rx-slip-val">${nextVisitStr}</div></div>
  </div>

  <!-- RX TABLE -->
  <table style="width:100%;margin-bottom:8px;border-collapse:collapse;font-size:.72rem;table-layout:fixed">
    <thead><tr style="background:var(--burgundy);color:white">
      <th style="padding:3px 4px;text-align:left;width:14%">Eye</th>
      <th style="padding:3px 2px;text-align:center">SPH</th>
      <th style="padding:3px 2px;text-align:center">CYL</th>
      <th style="padding:3px 2px;text-align:center">AXIS</th>
      <th style="padding:3px 2px;text-align:center">ADD</th>
      <th style="padding:3px 2px;text-align:center">VA</th>
      <th style="padding:3px 2px;text-align:center">BCVA</th>
    </tr></thead>
    <tbody>
      <tr style="background:var(--cream-bg)">
        <td style="padding:3px 4px;font-weight:700;font-size:.68rem;border:1px solid var(--cream-border)">OD (R)</td>
        ${[v.od_sphere,v.od_cylinder,v.od_axis,v.od_addition,v.od_va,v.od_bcva].map(x=>`<td style="text-align:center;padding:3px 2px;border:1px solid var(--cream-border);overflow:hidden;white-space:nowrap">${esc(x??'—')}</td>`).join('')}
      </tr>
      <tr>
        <td style="padding:3px 4px;font-weight:700;font-size:.68rem;border:1px solid var(--cream-border)">OS (L)</td>
        ${[v.os_sphere,v.os_cylinder,v.os_axis,v.os_addition,v.os_va,v.os_bcva].map(x=>`<td style="text-align:center;padding:3px 2px;border:1px solid var(--cream-border);overflow:hidden;white-space:nowrap">${esc(x??'—')}</td>`).join('')}
      </tr>
    </tbody>
  </table>

  <!-- IPD -->
  ${v.ipd != null ? `<div style="font-size:.76rem;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--cream-border)"><span class="rx-slip-label">IPD</span> <strong style="font-family:'Figtree','DM Sans',sans-serif">${esc(v.ipd)} mm</strong></div>` : ''}

  <!-- LENS / FRAME -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;font-size:.76rem;margin-bottom:6px;padding-bottom:6px;border-bottom:1px solid var(--cream-border)">
    <div><span class="rx-slip-label">Lens Type</span><br>${esc(lensDesc||'—')}</div>
    <div><span class="rx-slip-label">Frame</span><br>${esc(frameDesc||'—')}</div>
  </div>

  <!-- FINANCIALS -->
  ${showFinancials ? `
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;font-size:.74rem;margin-bottom:6px;padding-bottom:6px;border-bottom:1px dashed var(--cream-border)">
    <div><span class="rx-slip-label">${t('total')}</span><br>${fmtIQD(v.total_amount)}</div>
    <div><span class="rx-slip-label">${t('paid')}</span><br>${fmtIQD(v.amount_paid)}</div>
    <div><span class="rx-slip-label">${t('remaining')}</span><br>${fmtIQD(v.remaining)}</div>
  </div>` : ''}

  <!-- WARNINGS / INSTRUCTIONS -->
  ${st.print_warning_text ? `
  <div style="border:1px solid var(--cream-border);border-left:3px solid var(--burgundy);padding:6px 8px;margin-bottom:8px;font-size:.73rem;border-radius:2px;color:var(--ink-dark)">
    <div style="font-size:.66rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--burgundy);margin-bottom:2px">Instructions</div>
    ${esc(st.print_warning_text)}
  </div>` : ''}

  <!-- FOOTER: address + associates + QR -->
  <div style="display:flex;align-items:flex-end;justify-content:space-between;padding-top:7px;border-top:1px dashed var(--cream-border)">
    <div style="font-size:.69rem;color:var(--ink-light);flex:1;padding-right:8px">
      ${cl.address ? `<div style="margin-bottom:3px">${esc(cl.address)}</div>` : ''}
      ${assocHTML}
    </div>
    ${qrSrc ? `<img src="${escAttr(qrSrc)}" alt="QR" style="width:66px;height:66px;object-fit:contain;flex-shrink:0">` : ''}
  </div>

</div>`;
}
// ── Shared helper: build the print-ready HTML blob and filename ──
// Returns { blob, blobURL, docTitle } using the currently rendered rx-slip-content.
function _buildRxPrintBlob() {
  const patientName = (window._rxPrintPatientName || '').trim();
  const visitDate   = (window._rxPrintVisitDate || new Date().toISOString().slice(0, 10));
  // Filename: PatientName_YYYY-MM-DD  (spaces → underscores, keep Arabic chars)
  const safeName    = patientName.replace(/\s+/g, '_') || 'Patient';
  const docTitle    = safeName + '_' + visitDate;

  const slipHTML = document.getElementById('rx-slip-content').innerHTML;

  const rxScheme = _getRxScheme ? _getRxScheme() : 'burgundy';
  const schemeColors = {
    burgundy: {primary:'#6b1a2a',accent:'#c49a3c',bg:'#ffffff',paper:'#faf6f0',border:'#e8dcc8',text:'#1a1410'},
    charcoal: {primary:'#1c2230',accent:'#4a90d9',bg:'#ffffff',paper:'#f5f6f8',border:'#d0d6e0',text:'#111827'},
    forest:   {primary:'#1a4a2e',accent:'#7cb87a',bg:'#ffffff',paper:'#f5faf6',border:'#c8e0cc',text:'#0d2214'},
    slate:    {primary:'#2d3748',accent:'#718096',bg:'#ffffff',paper:'#f7fafc',border:'#e2e8f0',text:'#1a202c'},
    rose:     {primary:'#9d174d',accent:'#f9a8d4',bg:'#ffffff',paper:'#fdf2f8',border:'#f3d6e8',text:'#500724'},
    midnight: {primary:'#0f172a',accent:'#6366f1',bg:'#ffffff',paper:'#f8fafc',border:'#cbd5e1',text:'#0f172a'},
    offwhite: {primary:'#3d3530',accent:'#a07850',bg:'#fffff8',paper:'#f9f5ec',border:'#e0d8c8',text:'#1c1714'},
    onyx:     {primary:'#111111',accent:'#888888',bg:'#ffffff',paper:'#f2f2f2',border:'#d0d0d0',text:'#111111'},
  };
  const sc = schemeColors[rxScheme] || schemeColors.burgundy;
  const printCSS = `
    :root{--burgundy:${sc.primary};--burgundy-pale:${sc.paper};--cream:${sc.paper};--cream-dark:${sc.paper};--cream-border:${sc.border};--cream-bg:${sc.paper};--ink:${sc.text};--ink-mid:${sc.text};--ink-light:#8a8a7a;--ink-dark:${sc.text};--surface:${sc.bg};--danger:#c0392b;--success:#1e7e5a;--radius-md:14px;--radius-sm:8px;}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html,body{background:white;font-family:'Cairo','Noto Sans Arabic','DM Sans',sans-serif;width:148mm;}
    .rx-slip{background:white;border:none;padding:0;width:100%;font-size:8.6pt;line-height:1.4;}
    .rx-slip-label{font-size:6pt;text-transform:uppercase;letter-spacing:.07em;color:${sc.text}99}
    .rx-slip-val{font-weight:600;font-size:8.6pt}
    table{border-collapse:collapse;width:100%;font-size:7.6pt;table-layout:fixed}
    th,td{border:1px solid ${sc.border};padding:2.5px 3px;text-align:center;overflow:hidden;white-space:nowrap}
    th:first-child,td:first-child{text-align:left;padding-left:4px;width:14%}
    thead tr{background:${sc.primary};color:#fff}
    @page{size:A5 portrait;margin:7mm 8mm}
    @media print{
      *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}
      html,body{background:white!important;width:148mm!important;}
    }
  `;

  const printHTML = '<!DOCTYPE html>' +
    '<html lang="' + document.documentElement.lang + '" dir="' + document.documentElement.dir + '">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + docTitle + '</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Amiri:wght@400;700&family=DM+Sans:wght@300;400;500;600&family=Cairo:wght@300;400;600;700&family=DM+Mono:wght@400;500&family=Noto+Sans+Arabic:wght@300;400;600;700&display=swap" rel="stylesheet">' +
    '<style>' + printCSS + '</style>' +
    '</head>' +
    '<body onload="document.fonts.ready.then(function(){setTimeout(function(){window.print();},200)})">' + slipHTML + '</body>' +
    '</html>';

  const blob    = new Blob([printHTML], { type: 'text/html;charset=utf-8' });
  const blobURL = URL.createObjectURL(blob);
  return { blob, blobURL, docTitle };
}

function printRxSlip() {
  const { blobURL, docTitle } = _buildRxPrintBlob();

  // A5 at 96 dpi ≈ 559 × 794 px; add ~80px for browser chrome
  var isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  var pw = isMobileDevice
    ? window.open(blobURL, '_blank')
    : window.open(blobURL, '_blank', 'width=620,height=870,toolbar=0,scrollbars=0,status=0');

  if (!pw) {
    // Fallback if popup blocked: download the HTML file directly
    var a = document.createElement('a');
    a.href = blobURL;
    a.download = docTitle + '.html';
    a.click();
  }

  setTimeout(function() { URL.revokeObjectURL(blobURL); }, 30000);
}

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// WHATSAPP RX PDF SEND
// ══════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════
// WHATSAPP RX PDF SEND  — pure jsPDF text, no html2canvas
// ══════════════════════════════════════════════════════════
async function sendRxWhatsAppLegacy(vid, phone, patientName) {
  if (!phone) { toast('No phone number for this patient', 'error'); return; }
  toast(NOOR.lang === 'ar' ? 'جارٍ تحضير الوصفة…' : 'Preparing Rx…', 'success');

  try {
    const res = await get(`/api/visits/${vid}/print`);
    const payload = res.data || {};
    const v  = payload.visit   || {};
    const p  = payload.patient || {};
    const cl = payload.clinic  || { name: NOOR.clinicName };
    const st = payload.settings || NOOR.settings || {};

    // ── Iraq country code +964 ────────────────────────────────────────────
    let digits = phone.replace(/\D/g, '');
    if (digits.startsWith('00964'))     digits = digits.slice(5);
    else if (digits.startsWith('964'))  digits = digits.slice(3);
    else if (digits.startsWith('0'))    digits = digits.slice(1);
    const waPhone = '964' + digits;
    // ─────────────────────────────────────────────────────────────────────

    const visitDate  = v.visit_date ? fmtDate(v.visit_date) : fmtDate(new Date());
    const nextVisit  = v.next_visit_date ? fmtDate(v.next_visit_date) : '—';
    const clinicName = cl.name || NOOR.clinicName || 'Noor Optical';

    // ── Render the polished slip into the hidden modal content div ────────
    // _renderRxSlip populates #rx-slip-content and sets window._rxPrint* vars
    _renderRxSlip(payload);

    // ── Build the same high-quality print blob used by printRxSlip() ──────
    const { blobURL, docTitle } = _buildRxPrintBlob();

    // ── WhatsApp companion message ────────────────────────────────────────
    const lensDesc  = [v.lens_type, v.lens_material, v.lens_coating]
      .filter(Boolean).map(x => String(x).replace(/_/g,' ')).join(' · ') || '—';
    const frameDesc = [v.frame_brand, v.frame_type ? String(v.frame_type).replace(/_/g,' ') : '']
      .filter(Boolean).join(' · ') || '—';
    const fmtVal = x => (x === null || x === undefined || x === '') ? '—' : String(x);

    const waMsg = [
      `*${clinicName}*`,
      `📋 وصفة طبية — ${visitDate}`,
      '',
      `*المريض:* ${p.full_name || patientName || '—'}`,
      `*العمر:* ${fmtVal(p.age)}   *الجنس:* ${p.gender ? (NOOR.lang==='ar' ? (p.gender==='male'?'ذكر':'أنثى') : p.gender) : '—'}`,
      '',
      `*OD (R):* SPH ${fmtVal(v.od_sphere)} | CYL ${fmtVal(v.od_cylinder)} | AXIS ${fmtVal(v.od_axis)} | VA ${fmtVal(v.od_va)} | BCVA ${fmtVal(v.od_bcva)}`,
      `*OS (L):* SPH ${fmtVal(v.os_sphere)} | CYL ${fmtVal(v.os_cylinder)} | AXIS ${fmtVal(v.os_axis)} | VA ${fmtVal(v.os_va)} | BCVA ${fmtVal(v.os_bcva)}`,
      ...(v.ipd ? [`*IPD:* ${fmtVal(v.ipd)} mm`] : []),
      '',
      `*العدسة:* ${lensDesc}`,
      `*الإطار:* ${frameDesc}`,
      ...(v.next_visit_date ? [`\n📅 *الموعد القادم:* ${nextVisit}`] : []),
      ...(st.print_warning_text ? [`\n⚠️ ${st.print_warning_text}`] : []),
      '',
      `— ${clinicName}${cl.phone ? ' · ' + cl.phone : ''}`,
    ].join('\n');

    const waURL = `https://wa.me/${waPhone}?text=${encodeURIComponent(waMsg)}`;

    // ── Download the polished print file so the user can attach it ────────
    const isMobileDevice = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (isMobileDevice) {
      // On mobile: open the print page in a new tab (user can share/print from there)
      const pw = window.open(blobURL, '_blank');
      if (!pw) {
        // Fallback: download the file
        const a = document.createElement('a');
        a.href = blobURL; a.download = docTitle + '.html'; a.click();
      }
    } else {
      // On desktop: open the print popup (same as printRxSlip)
      const pw = window.open(blobURL, '_blank', 'width=620,height=870,toolbar=0,scrollbars=0,status=0');
      if (!pw) {
        const a = document.createElement('a');
        a.href = blobURL; a.download = docTitle + '.html'; a.click();
      }
    }

    // ── Open WhatsApp after a short delay so the print window loads first ─
    setTimeout(() => {
      window.open(waURL, '_blank');
      setTimeout(() => URL.revokeObjectURL(blobURL), 30000);
    }, 800);

    toast(
      NOOR.lang === 'ar'
        ? 'تم فتح الوصفة — سيفتح واتساب تلقائياً'
        : 'Rx opened — WhatsApp will open shortly',
      'success'
    );

  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}

async function sendRxWhatsApp(vid, phone, patientName) {
  if (!phone) { toast('No phone number for this patient', 'error'); return; }
  toast(NOOR.lang === 'ar' ? 'جارٍ تحضير الوصفة...' : 'Preparing Rx...', 'success');

  try {
    const res = await get(`/api/visits/${vid}/print`);
    const payload = res.data || {};
    const v = payload.visit || {};
    const p = payload.patient || {};
    const cl = payload.clinic || { name: NOOR.clinicName };
    const st = payload.settings || NOOR.settings || {};
    const waPhone = normalizeIraqPhone(phone);
    if (!waPhone) { toast('Invalid phone number', 'error'); return; }

    const visitDate = v.visit_date ? fmtDate(v.visit_date) : fmtDate(new Date());
    const nextVisit = v.next_visit_date ? fmtDate(v.next_visit_date) : '';
    const clinicName = cl.name || NOOR.clinicName || 'Noor Optical';
    const patient = p.full_name || patientName || '';
    const filename = ((patient || 'Patient').trim().replace(/\s+/g, '_') || 'Patient') + '_' + (v.visit_date || todayStr());
    const values = {
      patient_name: patient,
      clinic_name: clinicName,
      date: visitDate,
      next_visit: nextVisit,
      doctor_name: st.print_doctor_name || '',
    };
    const waMsg = st.wa_pdf_send_message === false
      ? ''
      : (st.wa_pdf_message ? fillTemplate(st.wa_pdf_message, values) : defaultRxWhatsAppMessage(values));

    _renderRxSlip(payload);
    const printFile = _buildRxPrintBlob();
    const pdfFile = await buildRxPdfFile(payload, filename);

    // Always open a direct WhatsApp chat with the patient first.
    // wa.me requires the full international number (964XXXXXXXXXX) — already handled by normalizeIraqPhone.
    window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(waMsg)}`, '_blank');

    // Then handle the PDF: share sheet on capable browsers, download otherwise.
    if (canShareRxPdf(pdfFile)) {
      setTimeout(() => URL.revokeObjectURL(printFile.blobURL), 30000);
      openRxSharePrompt(pdfFile, waMsg, filename, waPhone);
      toast(NOOR.lang === 'ar' ? 'تم فتح واتساب — ملف PDF جاهز للمشاركة' : 'WhatsApp opened — PDF ready to share', 'success');
      return;
    }

    if (pdfFile) {
      const pdfURL = URL.createObjectURL(pdfFile);
      const a = document.createElement('a');
      a.href = pdfURL;
      a.download = pdfFile.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(pdfURL), 30000);
    } else {
      const pw = window.open(printFile.blobURL, '_blank', 'width=650,height=850');
      if (!pw) {
        const a = document.createElement('a');
        a.href = printFile.blobURL;
        a.download = printFile.docTitle + '.html';
        a.click();
      }
    }

    setTimeout(() => URL.revokeObjectURL(printFile.blobURL), 30000);
    toast(
      NOOR.lang === 'ar'
        ? 'تم فتح واتساب وتنزيل ملف PDF. أرفق الملف يدوياً في المحادثة.'
        : 'WhatsApp opened and PDF downloaded. Attach the file manually in the chat.',
      'success',
      6000
    );
  } catch(e) {
    toast('Error: ' + e.message, 'error');
  }
}
