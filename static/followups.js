/* followups.js - extracted from index.html. Plain script, globals intentionally preserved. */
async function renderFollowups() {
  try {
    const data = await get('/api/followups?days=3650');
    const rows = data.data || [];

    // Update badge
    const badge  = document.getElementById('followup-badge');
    const bbadge = document.getElementById('bnav-followup-badge');
    const cnt    = rows.filter(r=>(r.days_until||0)<=7).length;
    [badge, bbadge].forEach(b => { if(b){ b.textContent=cnt; b.style.display=cnt?'':'none'; } });
    if (cnt > 0) document.getElementById('notif-dot').style.display='block';

    const tbody = document.getElementById('followups-tbody');
    const empty = document.getElementById('followups-empty');
    if (!rows.length) { tbody.innerHTML=''; empty.style.display='block'; return; }
    empty.style.display = 'none';

    // Load WA templates
    if (!NOOR.waTemplates.wa_template_1) {
      try {
        const s = await get('/api/settings');
        const st = s.data?.settings || {};
        NOOR.waTemplates = { wa_template_1: st.wa_template_1||'', wa_template_2: st.wa_template_2||'', wa_template_3: st.wa_template_3||'' };
        NOOR.clinicName = s.data?.clinic?.name || '';
        document.getElementById('sidebar-clinic-name').textContent = NOOR.clinicName;
      } catch(_){}
    }

    tbody.innerHTML = rows.map(item => {
      const d = item.days_until ?? 0;
      const cls = d<0?'overdue':d<=3?'soon':'ok';
      const label = d<0?`${Math.abs(d)} ${NOOR.lang==='ar'?'أيام متأخرة':'days overdue'}`:d===0?(NOOR.lang==='ar'?'اليوم':'Today'):`${d} ${NOOR.lang==='ar'?'يوم':'days'}`;
      return `<tr>
        <td class="td-name">
          ${esc(item.patient_name)}
          <div style="font-size:.72rem;color:var(--ink-light);font-weight:500;margin-top:4px">
            ${esc((item.lens_type||'').replace(/_/g,' '))} ${item.frame_brand?`· ${esc(item.frame_brand)}`:''}
            ${item.remaining>0?` · ${fmtIQD(item.remaining)} ${t('remaining')}`:''}
            <br>OD ${esc(item.od_sphere)} / ${esc(item.od_cylinder)} × ${esc(item.od_axis)} · OS ${esc(item.os_sphere)} / ${esc(item.os_cylinder)} × ${esc(item.os_axis)}
          </div>
        </td>
        <td class="td-phone" data-label="${t('phone')}">${esc(item.patient_phone)}</td>
        <td data-label="${t('lastVisit')}">${fmtDate(item.visit_date)}</td>
        <td data-label="${t('nextVisit')}">${fmtDate(item.next_visit_date)}</td>
        <td data-label="${t('daysLeft')}"><span class="followup-row-days ${cls}">${label}</span></td>
        <td class="td-actions-cell">
          <button class="wa-btn" onclick="sendWA('${escAttr(item.patient_id)}','${escAttr(item.next_visit_date)}','${escAttr(item.patient_name||'')}','${escAttr(item.patient_phone||'')}')">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/></svg>
            WhatsApp
          </button>
        </td>
      </tr>`;
    }).join('');
  } catch(e) { toast(e.message,'error'); }
}

function sendWA(pid, nd, patientName, phone) {
  if (!phone) { toast('No phone number','error'); return; }
  const n   = document.getElementById('wa-template-sel').value;
  const tpl = NOOR.waTemplates[`wa_template_${n}`] || '';
  const msg = tpl
    .replace('{patient_name}', patientName)
    .replace('{date}', fmtDate(new Date()))
    .replace('{next_visit}', fmtDate(nd))
    .replace('{clinic_name}', NOOR.clinicName);
  const waPhone = normalizeIraqPhone(phone);
  if (!waPhone) { toast('Invalid phone number','error'); return; }
  window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`, '_blank');
}

// ══════════════════════════════════════════════════════════
// LENSES
// ══════════════════════════════════════════════════════════
