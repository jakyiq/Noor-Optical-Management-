/* nav.js - extracted from index.html. Plain script, globals intentionally preserved. */
function navigate(section) {
  closeMoreMenu();
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.bnav-item').forEach(b => b.classList.toggle('active', b.dataset.section === section));
  document.getElementById(`section-${section}`)?.classList.add('active');
  document.querySelector(`.nav-item[data-section="${section}"]`)?.classList.add('active');
  NOOR.currentSection = section;
  document.getElementById('topbar-title').textContent = section === 'superadmin' ? 'Super Admin' : t(section);
  if (section === 'patients') showPatientsListView();
  renderSection(section);
  if (isMobile()) closeSidebar();
}

function toggleMoreMenu() {
  const sheet = document.getElementById('more-menu-sheet');
  const overlay = document.getElementById('more-menu-overlay');
  const open = !sheet.classList.contains('show');
  sheet.classList.toggle('show', open);
  overlay.classList.toggle('show', open);
  sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
  // Guard touch events once on first open
  if (open && !sheet._touchGuarded) {
    sheet.addEventListener('touchstart', e => e.stopPropagation(), {passive:false});
    sheet.addEventListener('touchend',   e => e.stopPropagation(), {passive:false});
    sheet.addEventListener('touchmove',  e => e.stopPropagation(), {passive:false});
    sheet._touchGuarded = true;
  }
}

function closeMoreMenu() {
  const sheet = document.getElementById('more-menu-sheet');
  const overlay = document.getElementById('more-menu-overlay');
  if (!sheet || !overlay) return;
  sheet.classList.remove('show');
  overlay.classList.remove('show');
  sheet.setAttribute('aria-hidden', 'true');
}

function navigateFromMore(section) {
  navigate(section);
}

function renderSection(s) {
  const map = {
    dashboard: renderDashboard, patients: renderPatients, followups: renderFollowups,
    lenses: renderLenses, frames: renderFrames, reports: renderReports,
    settings: renderSettings, audit: renderAuditLog, superadmin: renderSuperAdmin,
  };
  map[s]?.();
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

async function renderDashboard() {
  const now = new Date();
  const h = now.getHours();
  document.getElementById('dash-greeting').textContent = h<12?t('greetingMorning'):h<17?t('greetingAfternoon'):t('greetingEvening');
  document.getElementById('dash-date').textContent = now.toLocaleDateString(NOOR.lang==='ar'?'ar-IQ':'en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  document.getElementById('dash-date-sub').textContent = now.toLocaleTimeString(NOOR.lang==='ar'?'ar-IQ':'en-GB',{hour:'2-digit',minute:'2-digit'});
    ['stat-today-patients','stat-today-earnings','stat-debt','stat-low-stock','stat-monthly'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<span class="skeleton-line short" style="display:inline-block;width:70px"></span>';
    });
    const cont = document.getElementById('dash-recent-patients');
    if (cont) cont.innerHTML = skeletonCards(3);

  try {
    const data = await get('/api/dashboard/stats');
    const s = data.data;
    document.getElementById('dash-clinic-line').textContent = NOOR.clinicName;
    document.getElementById('stat-today-patients').textContent = fmtNum(s.today_patients);
    document.getElementById('stat-today-earnings').textContent = fmtNum(s.today_earnings);
    document.getElementById('stat-debt').textContent           = fmtNum(s.outstanding_debt);
    document.getElementById('stat-low-stock').textContent      = fmtNum(s.low_stock_count);
    document.getElementById('stat-monthly').textContent        = fmtNum(s.monthly_revenue);

    if (s.low_stock_count > 0) document.getElementById('stat-low-stock-pulse').classList.add('show');

    const upcoming = Object.values(s.chart_7days||{}).length;
    // followup badge updated by followups call — skip here

    renderChart(s.chart_7days || {});

    // Recent patients panel
    const cont = document.getElementById('dash-recent-patients');
    const recents = s.recent_visits || [];
    if (!recents.length) { cont.innerHTML = `<div class="empty-state"><p>${t('noPatients')}</p></div>`; return; }

    // Fetch only the specific patients we need for the dashboard panel
    const recentPids = [...new Set(recents.map(v => v.patient_id))];
    const patientsForDash = {};
    try {
      // Use the already-cached list first, fall back to targeted fetches
      recentPids.forEach(pid => {
        const cached = NOOR.patients.find(p => p.id === pid);
        if (cached) patientsForDash[pid] = cached;
      });
      const missing = recentPids.filter(pid => !patientsForDash[pid]);
      if (missing.length && !NOOR._patientsCachedAt) {
        const pr = await get('/api/patients?limit=200');
        setPatients(pr.data || []);
        NOOR._patientsCachedAt = Date.now();
        NOOR.patients.forEach(p => { patientsForDash[p.id] = p; });
      } else if (missing.length) {
        // Cache exists but these patients are still missing — fill from cache best-effort
        NOOR.patients.forEach(p => { patientsForDash[p.id] = p; });
      }
    } catch(_) {}

    cont.innerHTML = recents.map(v => {
      const p = patientsForDash[v.patient_id] || {};
      return `<div class="mini-list-item">
        <div class="mini-avatar">${esc((p?.full_name||'?')[0])}</div>
        <div><div class="mini-name">${esc(p?.full_name)}</div><div class="mini-sub">${fmtDate(v.visit_date)}</div></div>
        <div class="mini-amount">${fmtNum(v.total_amount)} <span style="font-size:.7rem;color:var(--ink-light)">IQD</span></div>
      </div>`;
    }).join('');
  } catch(e) {
    toast('Dashboard error: '+e.message, 'error');
  }
}

function renderChart(chart7) {
  const bars = document.getElementById('chart-bars');
  const days = Object.keys(chart7).sort();
  const revs = days.map(d => chart7[d] || 0);
  const mx = Math.max(...revs, 1);
  const dl = NOOR.lang==='ar'
    ? ['أحد','اثنين','ثلاثاء','أربعاء','خميس','جمعة','سبت']
    : ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  bars.innerHTML = days.map((day, i) => {
    const h = Math.max(4, (revs[i]/mx)*96);
    const di = new Date(day).getDay();
    return `<div class="chart-bar-wrap"><div class="chart-bar" style="height:${h}px"><div class="chart-bar-tooltip">${fmtNum(revs[i])} IQD</div></div><div class="chart-bar-day">${dl[di]}</div></div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
// PATIENTS
// ══════════════════════════════════════════════════════════

let _searchTimer;
function onGlobalSearch(q) {
  clearTimeout(_searchTimer);
  const res = document.getElementById('search-results');
  if (!q || q.length < 2) { res.classList.remove('show'); return; }
  _searchTimer = setTimeout(async () => {
    try {
      const data = await get(`/api/patients?q=${encodeURIComponent(q)}&limit=6`);
      const matches = data.data || [];
      if (!matches.length) { res.classList.remove('show'); return; }
      res.innerHTML = matches.map(p => `
        <div class="search-result-item" onclick="goToPatient('${escAttr(p.id)}')">
          <div class="search-result-avatar">${esc((p.full_name||'?')[0])}</div>
          <div><div class="search-result-name">${esc(p.full_name)}</div><div class="search-result-phone">${esc(p.phone)}</div></div>
        </div>
      `).join('');
      res.classList.add('show');
    } catch(_){}
  }, 250);
}

function goToPatient(pid) {
  document.getElementById('search-results')?.classList.remove('show');
  const gs = document.getElementById('global-search');
  if (gs) gs.value = '';

  // Always switch UI to patients section regardless of where we came from
  closeMoreMenu();
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // FIX 3: unconditional bnav highlight — covers followups→patient and any other source
  document.querySelectorAll('.bnav-item').forEach(b => b.classList.toggle('active', b.dataset.section === 'patients'));
  document.getElementById('section-patients')?.classList.add('active');
  document.querySelector('.nav-item[data-section="patients"]')?.classList.add('active');
  NOOR.currentSection = 'patients';
  document.getElementById('topbar-title').textContent = t('patients');
  if (isMobile()) closeSidebar();

  openPatientDetail(pid);
}

// ══════════════════════════════════════════════════════════
// SIDEBAR / RESPONSIVE
// ══════════════════════════════════════════════════════════
const COLLAPSE_KEY = 'noor_sidebar_collapsed';

function isMobile() { return window.innerWidth <= 1024; }

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  if (isMobile()) {
    const open = sb.classList.toggle('open');
    ov.classList.toggle('show', open);
  } else {
    toggleCollapse();
  }
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
}

function toggleCollapse() {
  const sb   = document.getElementById('sidebar');
  const main = document.getElementById('main-content');
  const collapsed = sb.classList.toggle('collapsed');
  main.classList.toggle('collapsed', collapsed);
  localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
}

function handleResize() {
  const sb   = document.getElementById('sidebar');
  const main = document.getElementById('main-content');
  const bnav = document.getElementById('bottom-nav');
  if (isMobile()) {
    // Mobile/tablet: bottom nav handles navigation, no topbar hamburger needed
    bnav.style.display = 'flex';
    sb.classList.remove('collapsed');
    main.classList.remove('collapsed');
    main.style.marginInlineStart = '0';
  } else {
    // Desktop: sidebar visible, bottom nav hidden
    bnav.style.display = 'none';
    sb.classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
    const wasCollapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
    sb.classList.toggle('collapsed', wasCollapsed);
    main.classList.toggle('collapsed', wasCollapsed);
    main.style.marginInlineStart = '';
  }
}

let _resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(handleResize, 120);
});

document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap'))
    document.getElementById('search-results').classList.remove('show');
  if (isMobile() &&
      document.getElementById('sidebar').classList.contains('open') &&
      !e.target.closest('.sidebar') &&
      !e.target.closest('#sidebar-toggle') &&
      !e.target.closest('.bottom-nav'))
    closeSidebar();
});

// ══════════════════════════════════════════════════════════
// KEYBOARD
// ══════════════════════════════════════════════════════════
document.getElementById('login-password').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
document.getElementById('login-username').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('login-password').focus(); });
document.getElementById('signup-password')?.addEventListener('keydown', e => { if(e.key==='Enter') doSignup(); });
document.getElementById('reset-email')?.addEventListener('keydown', e => { if(e.key==='Enter') doResetPassword(); });
document.addEventListener('keydown', e => {
  const target = e.target;
  const typing = target && ['INPUT','TEXTAREA','SELECT'].includes(target.tagName);
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !NOOR.user) return;
  if (e.key && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    if (NOOR.currentSection !== 'patients') navigate('patients');
    openAddPatient();
  }
});
document.addEventListener('input', e => {
  if (e.target.closest?.('#modal-patient')) updatePatientFormDirty();
});
document.addEventListener('change', e => {
  if (e.target.closest?.('#modal-patient')) updatePatientFormDirty();
});
document.getElementById('modal-patient')?.addEventListener('mousedown', e => {
  if (e.target === e.currentTarget) closeModal('modal-patient');
});
