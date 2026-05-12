/* core.js - extracted from index.html. Plain script, globals intentionally preserved. */
// ══════════════════════════════════════════════════════════
// API BASE — auto-detects local vs Vercel
// ══════════════════════════════════════════════════════════
let API_BASE = localStorage.getItem('noor_api_base') || '';  // Web uses same-origin; desktop stores the backend URL.

function isTauriDesktop() {
  return !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
}

function ensureApiBase() {
  if (API_BASE || !isTauriDesktop()) return API_BASE;
  const entered = prompt(
    NOOR.lang === 'ar'
      ? 'أدخل رابط الخادم الخاص بالعيادة (مثال: https://your-app.vercel.app)'
      : 'Enter your clinic backend URL (example: https://your-app.vercel.app)'
  );
  if (entered) {
    API_BASE = entered.replace(/\/+$/, '');
    localStorage.setItem('noor_api_base', API_BASE);
  }
  return API_BASE;
}

async function api(method, path, body) {
  if (typeof NOOR !== 'undefined' && NOOR.offlineMode) {
    return offlineApi(method, path, body);
  }
  const base = ensureApiBase();
  const opts = {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  };
  if (method !== 'GET' && NOOR.csrfToken) {
    opts.headers['X-CSRF-Token'] = NOOR.csrfToken;
  }
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(base + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `HTTP ${res.status}`);
      error.status = res.status;
      error.data = data;
      if (shouldUseOfflineApi(path, error)) return offlineApi(method, path, body);
      throw error;
    }
    if (data.data?.csrf_token) NOOR.csrfToken = data.data.csrf_token;
    if (method === 'GET') setCachedApiData(path, data);
    else invalidateApiCache('/api/');
    return data;
  } catch (error) {
    const cached = method === 'GET' ? getCachedApiData(path) : null;
    if (cached && shouldUseOfflineApi(path, error)) return cached;
    if (shouldUseOfflineApi(path, error)) return offlineApi(method, path, body);
    throw error;
  }
}

const get  = (path)        => api('GET',    path);
const post = (path, body)  => api('POST',   path, body);
const put  = (path, body)  => api('PUT',    path, body);
const del  = (path)        => api('DELETE', path);

const OFFLINE_DB_KEY = 'noor_offline_db_v1';
const API_CACHE_KEY = 'noor_api_cache_v1';
const API_CACHE_TTL = 10 * 60 * 1000;

function apiCacheStore() {
  try { return JSON.parse(localStorage.getItem(API_CACHE_KEY) || '{}'); }
  catch (_) { return {}; }
}

function apiCacheSave(store) {
  try { localStorage.setItem(API_CACHE_KEY, JSON.stringify(store)); } catch (_) {}
}

function isCacheableApiGet(path) {
  const p = String(path || '');
  return p.startsWith('/api/')
    && !p.startsWith('/api/me')
    && !p.startsWith('/api/login')
    && !p.startsWith('/api/logout')
    && !p.startsWith('/api/auth/')
    && !p.startsWith('/api/reset-password')
    && !p.startsWith('/api/change-password')
    && !p.startsWith('/api/backup')
    && !p.startsWith('/api/restore');
}

function getCachedApiData(path, maxAge = API_CACHE_TTL) {
  const entry = apiCacheStore()[String(path || '')];
  if (!entry || !entry.value) return null;
  if (maxAge && Date.now() - (entry.at || 0) > maxAge) return null;
  return entry.value;
}

function setCachedApiData(path, value) {
  if (!isCacheableApiGet(path)) return;
  const store = apiCacheStore();
  store[String(path)] = { at: Date.now(), value };
  apiCacheSave(store);
}

function invalidateApiCache(prefix = '/api/') {
  const store = apiCacheStore();
  Object.keys(store).forEach(key => { if (key.startsWith(prefix)) delete store[key]; });
  apiCacheSave(store);
}

function shouldUseOfflineApi(path, error) {
  const status = error?.status;
  if (typeof NOOR !== 'undefined' && NOOR.offlineMode) return true;
  if (!String(path || '').startsWith('/api/')) return false;
  if (status === 401 || status === 403) return false;
  return !status || status === 404 || status >= 500;
}

function makeOfflineId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function offlineDefaultCatalog() {
  return {
    type: [
      { value: 'single_vision', label_ar: 'Single Vision', label_en: 'Single Vision' },
      { value: 'bifocal', label_ar: 'Bifocal', label_en: 'Bifocal' },
      { value: 'progressive', label_ar: 'Progressive', label_en: 'Progressive' },
    ],
    material: [
      { value: 'cr39', label_ar: 'CR-39', label_en: 'CR-39' },
      { value: 'polycarbonate', label_ar: 'Polycarbonate', label_en: 'Polycarbonate' },
      { value: 'high_index', label_ar: 'High Index', label_en: 'High Index' },
    ],
    coating: [
      { value: 'clear', label_ar: 'Clear', label_en: 'Clear' },
      { value: 'anti_reflective', label_ar: 'Anti-reflective', label_en: 'Anti-reflective' },
      { value: 'blue_cut', label_ar: 'Blue cut', label_en: 'Blue cut' },
    ],
  };
}

function offlineLoadDb() {
  try {
    const parsed = JSON.parse(localStorage.getItem(OFFLINE_DB_KEY) || '{}');
    return {
      patients: Array.isArray(parsed.patients) ? parsed.patients : [],
      visits: Array.isArray(parsed.visits) ? parsed.visits : [],
      lenses: Array.isArray(parsed.lenses) ? parsed.lenses : [],
      frames: Array.isArray(parsed.frames) ? parsed.frames : [],
      retail_sales: Array.isArray(parsed.retail_sales) ? parsed.retail_sales : [],
      operating_expenses: Array.isArray(parsed.operating_expenses) ? parsed.operating_expenses : [],
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      lensCatalog: parsed.lensCatalog && typeof parsed.lensCatalog === 'object' ? parsed.lensCatalog : offlineDefaultCatalog(),
    };
  } catch (_) {
    return { patients: [], visits: [], lenses: [], frames: [], retail_sales: [], operating_expenses: [], settings: {}, lensCatalog: offlineDefaultCatalog() };
  }
}

function offlineSaveDb(db) {
  localStorage.setItem(OFFLINE_DB_KEY, JSON.stringify(db));
  invalidateApiCache('/api/');
}

function offlineUserPayload() {
  return {
    id: 'offline-user',
    username: 'offline',
    full_name: 'Offline User',
    role: 'doctor',
    clinic_id: 'offline-clinic',
    csrf_token: 'offline',
    expires_at: null,
    license: { is_active: true, plan: 'offline' },
  };
}

function enableOfflineMode() {
  NOOR.offlineMode = true;
  NOOR.user = offlineUserPayload();
  NOOR.role = NOOR.user.role;
  NOOR.clinicId = NOOR.user.clinic_id;
  NOOR.csrfToken = NOOR.user.csrf_token;
  NOOR.license = NOOR.user.license;
  NOOR.clinicName = 'Noor OMS Offline';
  document.body?.classList.add('offline-mode');
  const banner = document.getElementById('license-banner');
  const bannerText = document.getElementById('license-banner-text');
  if (banner && bannerText) {
    bannerText.textContent = NOOR.lang === 'ar'
      ? 'وضع بدون اتصال: يتم حفظ البيانات على هذا الجهاز فقط.'
      : 'Offline mode: data is saved on this device only.';
    banner.classList.add('show');
  }
}

function offlinePatientRows(db) {
  return db.patients.map(p => {
    const visits = db.visits.filter(v => v.patient_id === p.id);
    const outstanding = visits.reduce((sum, v) => sum + (parseFloat(v.remaining) || 0), 0);
    const latest = visits[0]?.visit_date || p.updated_at || p.created_at;
    return { ...p, outstanding_remaining: outstanding, updated_at: latest || p.updated_at || p.created_at };
  });
}

function offlineSummary(db) {
  const today = todayStr();
  const month = today.slice(0, 7);
  const todayVisits = db.visits.filter(v => String(v.visit_date || '').slice(0, 10) === today);
  const monthVisits = db.visits.filter(v => String(v.visit_date || '').slice(0, 7) === month);
  const chart = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    chart[d.toISOString().slice(0, 10)] = 0;
  }
  db.visits.forEach(v => {
    const d = String(v.visit_date || '').slice(0, 10);
    if (chart[d] !== undefined) chart[d] += parseFloat(v.total_amount) || 0;
  });
  return {
    today_patients: new Set(todayVisits.map(v => v.patient_id)).size,
    today_earnings: todayVisits.reduce((s, v) => s + (parseFloat(v.amount_paid) || 0), 0),
    outstanding_debt: db.visits.reduce((s, v) => s + (parseFloat(v.remaining) || 0), 0),
    low_stock_count: [...db.lenses, ...db.frames].filter(x => (parseInt(x.quantity) || 0) <= (parseInt(x.min_stock) || 0)).length,
    monthly_revenue: monthVisits.reduce((s, v) => s + (parseFloat(v.amount_paid) || 0), 0),
    chart_7days: chart,
    recent_visits: [...db.visits].sort((a, b) => String(b.visit_date || '').localeCompare(String(a.visit_date || ''))).slice(0, 6),
  };
}

function offlineReportSummary(db) {
  const visits = [...db.visits].sort((a, b) => String(b.visit_date || '').localeCompare(String(a.visit_date || '')));
  const totalRevenue = visits.reduce((s, v) => s + (parseFloat(v.amount_paid) || 0), 0);
  const totalOutstanding = visits.reduce((s, v) => s + (parseFloat(v.remaining) || 0), 0);
  const expenses = db.operating_expenses || [];
  const operatingCosts = expenses.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  return {
    total_revenue: totalRevenue,
    total_outstanding: totalOutstanding,
    operating_costs: operatingCosts,
    gross_profit: totalRevenue - operatingCosts,
    patients_seen: new Set(visits.map(v => v.patient_id)).size,
    new_patients: db.patients.length,
    chart_items: [
      { key: 'visits', label: 'Visits', kind: 'service', amount: totalRevenue, count: visits.length },
      { key: 'expenses', label: 'Expenses', kind: 'expense', amount: operatingCosts, count: expenses.length },
    ],
    visits,
    retail_sales: db.retail_sales || [],
    expenses,
  };
}

function offlineOk(data, extra = {}) {
  return { ok: true, data, offline: true, ...extra };
}

function skeletonRows(cols = 5, rows = 5) {
  return Array.from({ length: rows }, () => `<tr>${Array.from({ length: cols }, () => '<td><div class="skeleton-line"></div></td>').join('')}</tr>`).join('');
}

function skeletonCards(count = 4) {
  return Array.from({ length: count }, () => '<div class="skeleton-card"><div class="skeleton-line wide"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join('');
}

async function offlineApi(method, path, body) {
  enableOfflineMode();
  const db = offlineLoadDb();
  const url = new URL(path, window.location.origin);
  const pathname = url.pathname;
  const now = new Date().toISOString();

  if (pathname === '/api/me' || pathname === '/api/login') return offlineOk(offlineUserPayload());
  if (pathname === '/api/logout') return offlineOk({});
  if (pathname === '/api/dashboard/stats') return offlineOk(offlineSummary(db));
  if (pathname === '/api/settings') {
    if (method === 'PUT') {
      db.settings = { ...db.settings, ...(body || {}) };
      offlineSaveDb(db);
    }
    return offlineOk({ clinic: { id: 'offline-clinic', name: NOOR.clinicName || 'Noor OMS Offline' }, settings: db.settings });
  }
  if (pathname === '/api/lens-catalog') {
    if (method === 'PUT') {
      db.lensCatalog = { ...db.lensCatalog, ...(body || {}) };
      offlineSaveDb(db);
    }
    return offlineOk(db.lensCatalog);
  }
  if (pathname === '/api/lenses/match') {
    const type = url.searchParams.get('lens_type') || '';
    const material = url.searchParams.get('material') || '';
    const coatings = (url.searchParams.get('coating') || '').split(',').map(x => x.trim()).filter(Boolean);
    const rows = db.lenses.filter(l => {
      if ((parseInt(l.quantity) || 0) <= 0) return false;
      if (type && l.lens_type !== type) return false;
      if (material && l.material !== material) return false;
      if (coatings.length && !coatings.includes(l.coating || 'clear')) return false;
      return true;
    });
    const matchEye = (sphRaw, cylRaw) => {
      if (sphRaw === null) return [];
      const sph = parseFloat(sphRaw);
      const cyl = cylRaw !== null ? parseFloat(cylRaw) : 0;
      if (isNaN(sph)) return [];
      return rows.filter(l => Math.abs((Number(l.sphere) || 0) - sph) <= 0.25 && Math.abs((Number(l.cylinder) || 0) - (isNaN(cyl) ? 0 : cyl)) <= 0.25);
    };
    const odProvided = url.searchParams.get('od_sph') !== null;
    const osProvided = url.searchParams.get('os_sph') !== null;
    return offlineOk({
      od: matchEye(url.searchParams.get('od_sph'), url.searchParams.get('od_cyl')),
      os: matchEye(url.searchParams.get('os_sph'), url.searchParams.get('os_cyl')),
      single: !!(odProvided ^ osProvided),
    });
  }
  if (pathname === '/api/lenses') {
    if (method === 'POST') {
      const row = { ...(body || {}), id: makeOfflineId('lens'), created_at: now, updated_at: now };
      db.lenses.unshift(row); offlineSaveDb(db); return offlineOk(row);
    }
    return offlineOk(db.lenses);
  }
  if (pathname.startsWith('/api/lenses/')) {
    const id = pathname.split('/').pop();
    if (method === 'PUT') db.lenses = db.lenses.map(x => x.id === id ? { ...x, ...(body || {}), updated_at: now } : x);
    if (method === 'DELETE') db.lenses = db.lenses.filter(x => x.id !== id);
    offlineSaveDb(db);
    return offlineOk(db.lenses.find(x => x.id === id) || {});
  }
  if (pathname === '/api/frames') {
    if (method === 'POST') {
      const row = { ...(body || {}), id: makeOfflineId('frame'), created_at: now, updated_at: now };
      db.frames.unshift(row); offlineSaveDb(db); return offlineOk(row);
    }
    return offlineOk(db.frames);
  }
  if (pathname.startsWith('/api/frames/')) {
    const id = pathname.split('/').pop();
    if (method === 'PUT') db.frames = db.frames.map(x => x.id === id ? { ...x, ...(body || {}), updated_at: now } : x);
    if (method === 'DELETE') db.frames = db.frames.filter(x => x.id !== id);
    offlineSaveDb(db);
    return offlineOk(db.frames.find(x => x.id === id) || {});
  }
  if (pathname === '/api/patients') {
    if (method === 'POST') {
      const row = { ...(body || {}), id: makeOfflineId('patient'), created_at: now, updated_at: now };
      db.patients.unshift(row); offlineSaveDb(db); return offlineOk(row);
    }
    let rows = offlinePatientRows(db);
    const q = (url.searchParams.get('q') || '').toLowerCase();
    if (q) rows = rows.filter(p => String(p.full_name || '').toLowerCase().includes(q) || String(p.phone || '').includes(q));
    return offlineOk(rows, { total: rows.length });
  }
  if (pathname.startsWith('/api/patients/')) {
    const id = pathname.split('/').pop();
    if (method === 'PUT') db.patients = db.patients.map(p => p.id === id ? { ...p, ...(body || {}), updated_at: now } : p);
    if (method === 'DELETE') {
      db.patients = db.patients.filter(p => p.id !== id);
      db.visits = db.visits.filter(v => v.patient_id !== id);
    }
    offlineSaveDb(db);
    const patient = offlinePatientRows(db).find(p => p.id === id) || {};
    patient.visits = db.visits.filter(v => v.patient_id === id).sort((a, b) => String(b.visit_date || '').localeCompare(String(a.visit_date || '')));
    return offlineOk(patient);
  }
  if (pathname === '/api/visits') {
    if (method === 'POST') {
      const row = { ...(body || {}), id: makeOfflineId('visit'), created_at: now, updated_at: now };
      let selected = [body?.od_lens_id, body?.os_lens_id].filter(Boolean);
      if (!selected.length && body?.lens_id) {
        selected = Array(Math.max(1, parseInt(body?.lens_count) || 1)).fill(body.lens_id);
      }
      const counts = selected.reduce((acc, id) => {
        acc[id] = (acc[id] || 0) + 1;
        return acc;
      }, {});
      for (const [id, needed] of Object.entries(counts)) {
        const lens = db.lenses.find(l => l.id === id);
        if (!lens) continue;
        const qty = parseInt(lens.quantity) || 0;
        if (qty < needed) {
          const error = new Error(`Insufficient lens stock (have ${qty}, need ${needed})`);
          error.status = 409;
          throw error;
        }
        lens.quantity = qty - needed;
        lens.updated_at = now;
      }
      db.visits.unshift(row); offlineSaveDb(db); return offlineOk(row);
    }
    return offlineOk(db.visits);
  }
  if (pathname.startsWith('/api/visits/')) {
    const id = pathname.split('/')[3];
    if (pathname.endsWith('/print')) {
      const visit = db.visits.find(v => v.id === id) || {};
      const patient = db.patients.find(p => p.id === visit.patient_id) || {};
      return offlineOk({ visit, patient, clinic: { name: NOOR.clinicName || 'Noor OMS Offline' }, settings: db.settings });
    }
    if (method === 'PUT') db.visits = db.visits.map(v => v.id === id ? { ...v, ...(body || {}), updated_at: now } : v);
    if (method === 'DELETE') db.visits = db.visits.filter(v => v.id !== id);
    offlineSaveDb(db);
    return offlineOk(db.visits.find(v => v.id === id) || {});
  }
  if (pathname === '/api/followups') {
    const rows = db.visits.filter(v => v.next_visit_date).map(v => {
      const p = db.patients.find(x => x.id === v.patient_id) || {};
      return { ...v, patient_name: p.full_name, phone: p.phone, days_until: daysDiff(v.next_visit_date) };
    });
    return offlineOk(rows);
  }
  if (pathname === '/api/reports/summary') return offlineOk(offlineReportSummary(db));
  if (pathname === '/api/reports/export/excel' || pathname === '/api/reports/export/patients') return offlineOk([]);
  if (pathname === '/api/retail-sales') {
    if (method === 'POST') {
      db.retail_sales.unshift({ ...(body || {}), id: makeOfflineId('sale'), created_at: now });
      offlineSaveDb(db);
    }
    return offlineOk(db.retail_sales);
  }
  if (pathname === '/api/operating-expenses') {
    if (method === 'POST') {
      db.operating_expenses.unshift({ ...(body || {}), id: makeOfflineId('expense'), created_at: now });
      offlineSaveDb(db);
    }
    return offlineOk(db.operating_expenses);
  }
  return offlineOk([]);
}

// ══════════════════════════════════════════════════════════
// TRANSLATIONS
// ══════════════════════════════════════════════════════════
const LANG_DATA = {
  ar: {
    brand:'نور',brandTagline:'نظام إدارة العيادات',clinic:'العيادة',
    navMain:'الرئيسية',navInventory:'المخزون',navReports:'التقارير والإعدادات',
    dashboard:'لوحة التحكم',patients:'المراجعين',followups:'المتابعات',
    lenses:'العدسات',frames:'الإطارات',reports:'التقارير',settings:'الإعدادات',
    auditLog:'سجل التدقيق',language:'اللغة',management:'إدارة',inventory:'المخزون',
    analytics:'تحليلات',security:'الأمان',addPatient:'إضافة مراجع',
    addOldPrescription:'إضافة وصفة قديمة',oldPrescription:'وصفة قديمة',topUpRemaining:'تسديد المتبقي',printA5:'طباعة A5',latestVisit:'آخر زيارة',visitDate:'تاريخ الزيارة',
    operatingCosts:'التكاليف التشغيلية',grossProfit:'إجمالي الربح',salesMix:'مزيج المبيعات والتكاليف',retailSales:'مبيعات إضافية',addSale:'إضافة بيع',addExpense:'إضافة تكلفة',
    addLens:'إضافة عدسة',addFrame:'إضافة إطار',addUser:'إضافة مستخدم',
    save:'حفظ',cancel:'إلغاء',edit:'تعديل',delete:'حذف',restock:'إعادة تخزين',
    actions:'إجراءات',name:'الاسم',phone:'الهاتف',age:'العمر',gender:'الجنس',
    address:'العنوان',notes:'ملاحظات',visitNotes:'ملاحظات الزيارة',fullName:'الاسم الكامل',male:'ذكر',female:'أنثى',
    lastVisit:'آخر زيارة',nextVisit:'الزيارة القادمة',remaining:'المتبقي',
    total:'الإجمالي',paid:'المدفوع',todayPatients:'مراجعين اليوم',
    todayEarnings:'إيرادات اليوم',outstandingDebt:'الديون المعلقة',
    lowStock:'مخزون منخفض',monthlyRevenue:'إيرادات الشهر',visits:'زيارة',items:'صنف',
    last7days:'الإيرادات — آخر 7 أيام',recentPatients:'آخر المراجعين',
    allGenders:'الجنس (الكل)',noPatients:'لا يوجد مراجعين',
    addFirstPatient:'أضف مراجعك الأول للبدء',patientRecord:'ملف المراجع',
    newVisit:'زيارة جديدة',patientInfo:'المعلومات',prescription:'الوصفة',
    frame:'الإطار',financials:'المالية',previousRx:'الوصفة السابقة',
    importAsCurrent:'استيراد كوصفة حالية',lensType:'نوع العدسة',material:'المادة',
    coating:'الطلاء',lensCount:'عدد العيون',bothEyes:'كلا العينين',oneEye:'عين واحدة',
    inventoryMatch:'مطابقة المخزون',enterRxFirst:'أدخل قيم الوصفة أولاً',
    frameBrand:'علامة الإطار',frameType:'نوع الإطار',frameMaterial:'مادة الإطار',
    selectFromInventory:'من المخزون',selectFrame:'اختر إطاراً...',
    frameCost:'تكلفة الإطار (IQD)',framePrice:'سعر الإطار (IQD)',
    lensCost:'تكلفة العدسة (IQD)',lensPrice:'سعر العدسة (IQD)',
    checkupFee:'رسوم الفحص (IQD)',amountPaid:'المبلغ المدفوع (IQD)',
    didCheckup:'تم إجراء الفحص',nextVisitDate:'تاريخ الزيارة القادمة',
    followupMonths:'أشهر المتابعة',noFollowups:'لا توجد متابعات قريبة',
    noFollowupsSub:'ممتاز! لا يوجد مراجعين لمتابعتهم.',
    daysLeft:'الأيام المتبقية',whatsapp:'واتساب',
    template1:'قالب 1',template2:'قالب 2',template3:'قالب 3',
    allTypes:'كل الأنواع',allMaterials:'كل المواد',qty:'الكمية',
    minStock:'الحد الأدنى',status:'الحالة',sellPrice:'سعر البيع',costPrice:'التكلفة',
    lowStockAlert:'تنبيه: مخزون منخفض',noLenses:'لا توجد عدسات',
    noLensesSub:'أضف عدسة يدوياً',brand:'العلامة',type:'النوع',color:'اللون',
    noFrames:'لا توجد إطارات',noFramesSub:'أضف إطاراتك للبدء',
    totalRevenue:'إجمالي الإيرادات (IQD)',totalOutstanding:'الديون المعلقة (IQD)',
    patientsSeen:'مراجعين تمت رؤيتهم',newPatients:'مراجعين جدد',date:'التاريخ',slip:'وصفة',
    clinicProfile:'ملف العيادة',whatsappTemplates:'قوالب واتساب',
    receptionistPermissions:'صلاحيات الاستقبال',userManagement:'إدارة المستخدمين',
    followupDefaults:'إعدادات المتابعة',clinicName:'اسم العيادة',logoUpload:'الشعار (URL)',
    waVarsHint:'المتغيرات: {patient_name} {date} {next_visit} {clinic_name}',
    defaultFollowupMonths:'الأشهر الافتراضية',username:'اسم المستخدم',role:'الدور',
    doctor:'طبيب',receptionist:'موظف استقبال',password:'كلمة المرور',
    timestamp:'التوقيت',user:'المستخدم',action:'الإجراء',entity:'الكيان',
    details:'التفاصيل',filter:'تصفية',changePassword:'تغيير كلمة المرور',
    mustChangePassword:'يجب تغيير كلمة المرور قبل الاستمرار.',
    newPassword:'كلمة المرور الجديدة',confirmPassword:'تأكيد كلمة المرور',
    prescriptionSlip:'وصفة طبية',print:'طباعة',close:'إغلاق',addQty:'إضافة كمية',
    reminders:'تذكيرات',ok:'جيد',low:'منخفض',out:'نفد',
    greetingMorning:'صباح الخير',greetingAfternoon:'مساء الخير',greetingEvening:'مساء النور',
    invalidCredentials:'اسم المستخدم أو كلمة المرور غير صحيحة',
    successSaved:'تم الحفظ بنجاح',successDeleted:'تم الحذف بنجاح',
    errorRequired:'يرجى ملء جميع الحقول المطلوبة',total:'الإجمالي',
    backupRestore:'النسخ الاحتياطي والاستعادة',backupCreate:'تنزيل نسخة احتياطية',
    backupHistory:'سجل النسخ الاحتياطية',backupRestoreBtn:'استعادة البيانات',
    backupChooseFile:'اختر ملف',backupPreviewTitle:'معاينة النسخة الاحتياطية:',
    backupNone:'لا توجد نسخ احتياطية بعد',backupKindManual:'يدوي',backupKindRestore:'استعادة',
  },
  en: {
    brand:'Noor',brandTagline:'Optical Clinic SaaS',clinic:'Clinic',
    navMain:'Main',navInventory:'Inventory',navReports:'Reports & Settings',
    dashboard:'Dashboard',patients:'Patients',followups:'Follow-ups',
    lenses:'Lenses',frames:'Frames',reports:'Reports',settings:'Settings',
    auditLog:'Audit Log',language:'Language',management:'Management',
    inventory:'Inventory',analytics:'Analytics',security:'Security',
    addPatient:'Add Patient',addLens:'Add Lens',addFrame:'Add Frame',addUser:'Add User',
    addOldPrescription:'Add Old Rx',oldPrescription:'Old Prescription',topUpRemaining:'Top Up Remaining',printA5:'Print A5',latestVisit:'Latest Visit',visitDate:'Visit Date',
    operatingCosts:'Operational Costs',grossProfit:'Gross Profit',salesMix:'Sales / Cost Mix',retailSales:'Retail Sales',addSale:'Add Sale',addExpense:'Add Expense',
    save:'Save',cancel:'Cancel',edit:'Edit',delete:'Delete',restock:'Restock',
    actions:'Actions',name:'Name',phone:'Phone',age:'Age',gender:'Gender',
    address:'Address',notes:'Notes',visitNotes:'Visit Notes',fullName:'Full Name',male:'Male',female:'Female',
    lastVisit:'Last Visit',nextVisit:'Next Visit',remaining:'Remaining',
    total:'Total',paid:'Paid',todayPatients:"Today's Patients",
    todayEarnings:"Today's Earnings",outstandingDebt:'Outstanding Debt',
    lowStock:'Low Stock',monthlyRevenue:'Monthly Revenue',visits:'visit(s)',items:'item(s)',
    last7days:'Revenue — Last 7 Days',recentPatients:'Recent Patients',
    allGenders:'All Genders',noPatients:'No Patients',
    addFirstPatient:'Add your first patient to get started',patientRecord:'Patient Record',
    newVisit:'New Visit',patientInfo:'Information',prescription:'Prescription',
    frame:'Frame',financials:'Financials',previousRx:'Previous Prescription',
    importAsCurrent:'Import as Current',lensType:'Lens Type',material:'Material',
    coating:'Coating',lensCount:'Lens Count',bothEyes:'Both Eyes',oneEye:'One Eye',
    inventoryMatch:'Inventory Match',enterRxFirst:'Enter Rx values first',
    frameBrand:'Frame Brand',frameType:'Frame Type',frameMaterial:'Frame Material',
    selectFromInventory:'Select from Inventory',selectFrame:'Select frame...',
    frameCost:'Frame Cost (IQD)',framePrice:'Frame Price (IQD)',
    lensCost:'Lens Cost (IQD)',lensPrice:'Lens Price (IQD)',
    checkupFee:'Checkup Fee (IQD)',amountPaid:'Amount Paid (IQD)',
    didCheckup:'Checkup Done',nextVisitDate:'Next Visit Date',
    followupMonths:'Follow-up Months',noFollowups:'No Upcoming Follow-ups',
    noFollowupsSub:"Great! No patients need follow-up soon.",
    daysLeft:'Days Left',whatsapp:'WhatsApp',
    template1:'Template 1',template2:'Template 2',template3:'Template 3',
    allTypes:'All Types',allMaterials:'All Materials',qty:'Quantity',
    minStock:'Min Stock',status:'Status',sellPrice:'Sell Price',costPrice:'Cost',
    lowStockAlert:'Low Stock Alert',noLenses:'No Lenses',
    noLensesSub:'Add lenses manually',brand:'Brand',type:'Type',color:'Color',
    noFrames:'No Frames',noFramesSub:'Add frames to start',
    totalRevenue:'Total Revenue (IQD)',totalOutstanding:'Outstanding (IQD)',
    patientsSeen:'Patients Seen',newPatients:'New Patients',date:'Date',slip:'Rx Slip',
    clinicProfile:'Clinic Profile',whatsappTemplates:'WhatsApp Templates',
    receptionistPermissions:'Receptionist Permissions',userManagement:'User Management',
    followupDefaults:'Follow-up Defaults',clinicName:'Clinic Name',logoUpload:'Logo (URL)',
    waVarsHint:'Variables: {patient_name} {date} {next_visit} {clinic_name}',
    defaultFollowupMonths:'Default Months',username:'Username',role:'Role',
    doctor:'Doctor',receptionist:'Receptionist',password:'Password',
    timestamp:'Timestamp',user:'User',action:'Action',entity:'Entity',
    details:'Details',filter:'Filter',changePassword:'Change Password',
    mustChangePassword:'You must change your password before continuing.',
    newPassword:'New Password',confirmPassword:'Confirm Password',
    prescriptionSlip:'Prescription Slip',print:'Print',close:'Close',addQty:'Add Quantity',
    reminders:'Reminders',ok:'OK',low:'Low',out:'Out',
    greetingMorning:'Good morning',greetingAfternoon:'Good afternoon',greetingEvening:'Good evening',
    invalidCredentials:'Invalid username or password',
    successSaved:'Saved successfully',successDeleted:'Deleted successfully',
    errorRequired:'Please fill all required fields',
    backupRestore:'Backup & Restore',backupCreate:'Download Backup',
    backupHistory:'Backup History',backupRestoreBtn:'Restore Data',
    backupChooseFile:'Choose File',backupPreviewTitle:'Backup Preview:',
    backupNone:'No backups yet',backupKindManual:'Manual',backupKindRestore:'Restore',
  }
};

// ══════════════════════════════════════════════════════════
// STATE  (runtime cache; truth lives in Supabase)
// ══════════════════════════════════════════════════════════
const NOOR = {
  lang: localStorage.getItem('noor_lang') || 'ar',
  user: null, role: null, clinicId: null,
  csrfToken: null,
  offlineMode: false,
  clinicName: '',
  currentSection: 'dashboard',
  // editing IDs
  editingPatientId: null, editingLensId: null, editingFrameId: null,
  patientModalMode: 'create',
  restockTarget: null,
  editingVisitId: null,
  patientFormSnapshot: '',
  patientFormDirty: false,
  savingPatient: false,
  modalScrollY: 0,
  _selectedLensId: null,
  _selectedLensIds: { od: null, os: null },
  _matchLensById: new Map(),
  pendingRxShare: null,
  duplicatePatientResolver: null,
  sessionWarningTimer: null,
  sessionExpiryTimer: null,
  // cached data (refreshed from API on each section visit)
  patients: [], patientById: new Map(), lenses: [], frames: [], visits: [],
  users: [], auditLog: [], clinics: [],
  reportHiddenItems: new Set(),
  reportChartItems: [],
  lensRenderLimit: 250,
  settings: {},
  lensCatalog: { type: [], material: [], coating: [] },
  waTemplates: { wa_template_1:'', wa_template_2:'', wa_template_3:'' },
};

// ══════════════════════════════════════════════════════════
// I18N
// ══════════════════════════════════════════════════════════
function t(key) { return (LANG_DATA[NOOR.lang] || LANG_DATA.ar)[key] || key; }

function applyLang() {
  document.documentElement.lang = NOOR.lang;
  document.documentElement.dir = NOOR.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  // lang states and auth UI text handled below
  const lt = document.getElementById('login-title');
  const ls = document.getElementById('login-sub');
  const lu = document.getElementById('lbl-username');
  const lp = document.getElementById('lbl-password');
  if(lt) lt.textContent = NOOR.lang === 'ar' ? 'نـور' : 'Noor';
  if(ls) ls.textContent = NOOR.lang === 'ar' ? 'نظام إدارة العيادات البصرية' : 'Optical Clinic Management';
  if(lu) lu.textContent = NOOR.lang === 'ar' ? 'البريد الإلكتروني أو اسم المستخدم' : 'Email or username';
  if(lp) lp.textContent = NOOR.lang === 'ar' ? 'كلمة المرور' : 'Password';
  // Auth screen tab labels
  const isAr = NOOR.lang === 'ar';
  const setT = (id, ar, en) => { const el = document.getElementById(id); if(el) el.textContent = isAr ? ar : en; };
  setT('tab-signin',       'تسجيل الدخول',                'Sign In');
  setT('tab-signup',       'حساب جديد',                   'Create Account');
  setT('signin-title',     'أهلاً بعودتك',                'Welcome back');
  setT('signin-sub',       'سجّل دخولك للمتابعة إلى لوحة التحكم', 'Sign in to continue to your dashboard');
  setT('login-btn-text',   'تسجيل الدخول',                'Sign In');
  setT('lbl-forgot',       'نسيت كلمة المرور؟',           'Forgot password?');
  setT('trial-badge-text', 'تجربة مجانية 7 أيام',         '7-Day Free Trial');
  setT('signup-title',     'أنشئ حساب عيادتك',            'Create your clinic account');
  setT('signup-sub',       'ابدأ تجربتك المجانية — لا حاجة لبطاقة ائتمان', 'Start your free trial — no credit card required');
  setT('signup-btn-text',  'إنشاء الحساب وبدء التجربة',   'Create Account & Start Trial');
  setT('lbl-signup-clinic','اسم العيادة',                  'Clinic Name');
  setT('lbl-signup-owner', 'اسم المالك',                   'Owner Name');
  setT('lbl-signup-email', 'البريد الإلكتروني',            'Email');
  setT('lbl-signup-phone', 'رقم الهاتف',                   'Phone');
  setT('lbl-signup-password','كلمة المرور',                'Password');
  setT('reset-title',      'إعادة تعيين كلمة المرور',      'Reset Password');
  setT('reset-sub',        'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين','Enter your email and we\'ll send a reset link');
  setT('reset-btn-text',   'إرسال رابط الاسترداد',         'Send Reset Link');
  setT('lbl-reset-email',  'البريد الإلكتروني',            'Email');
  setT('lbl-back',         'العودة لتسجيل الدخول',         'Back to Sign In');
  setT('lp-hero-title',    'إدارة عيادتك البصرية بكل سهولة','Manage your optical clinic with ease');
  setT('lp-hero-sub',      'نظام متكامل لإدارة المراجعين، الوصفات، المخزون والتقارير المالية — في مكان واحد.','A complete system for patients, prescriptions, inventory, and financials — all in one place.');
  // lang btn states across both panels
  const langBtns = ['sb-lang-ar','sb-lang-en','login-lang-ar','login-lang-en','signup-lang-ar','signup-lang-en'];
  langBtns.forEach(id => document.getElementById(id)?.classList.remove('active'));
  if (isAr) {
    ['sb-lang-ar','login-lang-ar','signup-lang-ar'].forEach(id => document.getElementById(id)?.classList.add('active'));
  } else {
    ['sb-lang-en','login-lang-en','signup-lang-en'].forEach(id => document.getElementById(id)?.classList.add('active'));
  }
}

function setLang(l) {
  NOOR.lang = l;
  localStorage.setItem('noor_lang', l);
  applyLang();
  renderSection(NOOR.currentSection);
}

// ══════════════════════════════════════════════════════════
// AUTH — PANE SWITCHER
// ══════════════════════════════════════════════════════════

function fmtDate(s){ if(!s)return'—'; return new Date(s).toLocaleDateString(NOOR.lang==='ar'?'ar-IQ':'en-GB'); }
function fmtNum(n){ return Number(n||0).toLocaleString(); }
function fmtIQD(n){ return fmtNum(n)+' IQD'; }
function daysDiff(s){ return Math.round((new Date(s)-new Date())/(86400000)); }
function todayStr(){ return new Date().toISOString().split('T')[0]; }
function setPatients(rows) {
  NOOR.patients = rows || [];
  NOOR.patientById = new Map(NOOR.patients.map(p => [p.id, p]));
}
function getPatient(id){ return NOOR.patientById.get(id) || null; }
function esc(v){
  if (v === null || v === undefined || v === '') return '—';
  return String(v).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
function escAttr(v){
  if (v === null || v === undefined || v === '') return '';
  // For inline onclick="..." attributes we need raw attribute-safe encoding.
  // Do NOT call esc() first — that would double-encode & to &amp;amp; etc.
  return String(v).replace(/[&<>"'`]/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;', '`':'&#96;'
  }[ch]));
}

function normalizeIraqPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00964')) digits = digits.slice(5);
  else if (digits.startsWith('964')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits ? '964' + digits : '';
}

function fillTemplate(template, values) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}

function defaultRxWhatsAppMessage(values) {
  return fillTemplate(
    NOOR.lang === 'ar'
      ? 'وصفتك من عيادة {clinic_name} بتاريخ {date}. نتمنى لك دوام الصحة والعافية، {patient_name}.'
      : 'Your prescription from {clinic_name} dated {date}. Wishing you good health, {patient_name}.',
    values
  );
}

function canShareRxPdf(file) {
  return !!(file && navigator.share && navigator.canShare?.({ files: [file] }));
}

function openRxSharePrompt(file, text, title, waPhone) {
  NOOR.pendingRxShare = { file, text, title, waPhone };
  const isAr = NOOR.lang === 'ar';
  const msg = document.getElementById('rx-share-text');
  if (msg) msg.textContent = isAr
    ? 'ملف وصفة A5 جاهز. اضغط مشاركة PDF ثم اختر واتساب لإرسال الملف.'
    : 'The A5 prescription PDF is ready. Tap Share PDF and choose WhatsApp to send the file.';
  openModal('modal-rx-share');
}

function sharePreparedRxPdf() {
  const share = NOOR.pendingRxShare;
  if (!share?.file || !navigator.share) {
    toast(NOOR.lang === 'ar' ? 'المشاركة غير مدعومة في هذا المتصفح' : 'Sharing is not supported in this browser', 'error');
    return;
  }
  if (navigator.canShare && !navigator.canShare({ files: [share.file] })) {
    toast(NOOR.lang === 'ar' ? 'لا يمكن مشاركة ملف PDF من هذا المتصفح' : 'This browser cannot share the PDF file', 'error');
    return;
  }

  const sharePromise = navigator.share({
    files: [share.file],
    text: share.text || '',
    title: share.title || share.file.name,
  });

  sharePromise
    .then(() => {
      NOOR.pendingRxShare = null;
      closeModal('modal-rx-share');
      toast(NOOR.lang === 'ar' ? 'تم فتح المشاركة' : 'Share sheet opened', 'success');
    })
    .catch(e => {
      if (e?.name === 'AbortError') return;
      toast(e?.message || (NOOR.lang === 'ar' ? 'تعذر فتح المشاركة' : 'Could not open share sheet'), 'error');
    });
}

async function buildRxPdfFile(payload, filename) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor || typeof File === 'undefined' || typeof html2canvas === 'undefined') return null;
  const slip = document.getElementById('rx-slip-content')?.querySelector('.rx-slip');
  if (!slip) return null;
  if (document.fonts?.ready) await document.fonts.ready.catch(() => {});

  const host = document.createElement('div');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    'width:148mm',
    'min-height:210mm',
    'background:#fff',
    'padding:8mm 9mm',
    'z-index:-1',
    'direction:' + document.documentElement.dir,
    'font-family:Cairo, Noto Sans Arabic, DM Sans, sans-serif'
  ].join(';');
  const clone = slip.cloneNode(true);
  clone.style.width = '100%';
  clone.style.border = 'none';
  clone.style.boxShadow = 'none';
  clone.style.margin = '0';
  clone.style.background = '#fff';
  clone.querySelectorAll('img').forEach(img => {
    try {
      const src = img.getAttribute('src') || '';
      const url = new URL(src, window.location.href);
      if (!src.startsWith('data:') && !src.startsWith('blob:') && url.origin !== window.location.origin) {
        img.remove();
      }
    } catch(_) {
      img.remove();
    }
  });
  host.appendChild(clone);
  document.body.appendChild(host);
  try {
    const canvas = await html2canvas(host, {
      backgroundColor: '#ffffff',
      scale: Math.min(2.5, window.devicePixelRatio || 2),
      useCORS: true,
      allowTaint: false,
      logging: false,
    });
    const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: [148, 210], compress: true });
    const img = canvas.toDataURL('image/jpeg', 0.96);
    const pageW = 148;
    const pageH = 210;
    const ratio = Math.min(pageW / canvas.width, pageH / canvas.height);
    const imgW = canvas.width * ratio;
    const imgH = canvas.height * ratio;
    doc.setProperties({ title: filename, subject: 'A5 prescription', creator: 'Noor Optical' });
    doc.addImage(img, 'JPEG', (pageW - imgW) / 2, 0, imgW, imgH);
    return new File([doc.output('blob')], filename + '.pdf', { type: 'application/pdf' });
  } finally {
    host.remove();
  }
}

function buildRxPdfFileLegacy(payload, filename) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor || typeof File === 'undefined') return null;
  const v = payload.visit || {};
  const p = payload.patient || {};
  const cl = payload.clinic || {};
  const st = payload.settings || {};
  const doc = new jsPDFCtor({ orientation: 'portrait', unit: 'mm', format: [148, 210], compress: true });
  const clinicName = cl.name || NOOR.clinicName || 'Noor Optical';
  const patientName = p.full_name || filename.replace(/_/g, ' ');
  const visitDate = v.visit_date ? fmtDate(v.visit_date) : fmtDate(new Date());
  const fmtVal = x => (x === null || x === undefined || x === '') ? '-' : String(x);
  const line = (label, value, x, y) => {
    doc.setFont('helvetica', 'bold');
    doc.text(String(label), x, y);
    doc.setFont('helvetica', 'normal');
    doc.text(String(value || '-'), x + 30, y);
  };

  doc.setProperties({ title: filename, subject: 'A5 prescription', creator: 'Noor Optical' });
  doc.setTextColor(107, 26, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(clinicName, 74, 13, { align: 'center' });
  doc.setTextColor(30, 25, 20);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  if (st.print_header_text) doc.text(String(st.print_header_text), 74, 19, { align: 'center' });
  doc.setDrawColor(196, 154, 60);
  doc.line(10, 24, 138, 24);

  doc.setFontSize(9);
  line('Patient', patientName, 12, 33);
  line('Date', visitDate, 84, 33);
  line('Age', fmtVal(p.age), 12, 41);
  line('Phone', fmtVal(p.phone), 84, 41);
  const tableHead = ['Eye', 'SPH', 'CYL', 'AXIS', 'ADD', 'VA', 'BCVA'];
  const tableRows = [
    ['OD', fmtVal(v.od_sphere), fmtVal(v.od_cylinder), fmtVal(v.od_axis), fmtVal(v.od_addition), fmtVal(v.od_va), fmtVal(v.od_bcva)],
    ['OS', fmtVal(v.os_sphere), fmtVal(v.os_cylinder), fmtVal(v.os_axis), fmtVal(v.os_addition), fmtVal(v.os_va), fmtVal(v.os_bcva)],
  ];
  let tableBottom = 72;
  if (typeof doc.autoTable === 'function') {
    doc.autoTable({
      startY: 50,
      head: [tableHead],
      body: tableRows,
      theme: 'grid',
      headStyles: { fillColor: [107, 26, 42], textColor: 255 },
      styles: { fontSize: 8, cellPadding: 2 },
      margin: { left: 10, right: 10 },
    });
    tableBottom = doc.lastAutoTable.finalY;
  } else {
    const widths = [14, 18, 18, 18, 18, 18, 22];
    const left = 10;
    let x = left;
    let y0 = 50;
    doc.setFillColor(107, 26, 42);
    doc.rect(left, y0, widths.reduce((a, b) => a + b, 0), 8, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(7.5);
    tableHead.forEach((h, i) => {
      doc.text(h, x + 2, y0 + 5.2);
      x += widths[i];
    });
    doc.setTextColor(30, 25, 20);
    tableRows.forEach((row, ri) => {
      x = left;
      y0 = 58 + ri * 8;
      row.forEach((cell, i) => {
        doc.rect(x, y0, widths[i], 8);
        doc.text(String(cell), x + 2, y0 + 5.2);
        x += widths[i];
      });
    });
    tableBottom = 74;
  }

  let y = tableBottom + 9;
  line('IPD', fmtVal(v.ipd), 12, y);
  y += 8;
  line('Lens', [v.lens_type, v.lens_material, v.lens_coating].filter(Boolean).map(x => String(x).replace(/_/g, ' ')).join(' / ') || '-', 12, y);
  y += 8;
  line('Frame', [v.frame_brand, v.frame_type, v.frame_material].filter(Boolean).map(x => String(x).replace(/_/g, ' ')).join(' / ') || '-', 12, y);
  if (v.next_visit_date) {
    y += 8;
    line('Next visit', fmtDate(v.next_visit_date), 12, y);
  }
  if (st.print_warning_text) {
    y += 12;
    doc.setFont('helvetica', 'bold');
    doc.text('Notes', 12, y);
    doc.setFont('helvetica', 'normal');
    doc.text(doc.splitTextToSize(String(st.print_warning_text), 120), 12, y + 6);
  }
  doc.setFontSize(8);
  doc.setTextColor(120, 120, 120);
  doc.text([st.print_doctor_name, st.print_doctor_credentials].filter(Boolean).join(' - '), 74, 198, { align: 'center' });

  return new File([doc.output('blob')], filename + '.pdf', { type: 'application/pdf' });
}

function toast(msg, type='success', duration=3500) {
  const tc = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${type==='success'?'<polyline points="20,6 9,17 4,12"/>':'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/>'}
  </svg>${esc(msg)}`;
  tc.appendChild(el);
  setTimeout(()=>el.remove(), duration);
}

function lockPageScrollForModal() {
  if (document.body.classList.contains('modal-scroll-locked')) return;
  NOOR.modalScrollY = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${NOOR.modalScrollY}px`;
  document.body.classList.add('modal-scroll-locked');
}

function unlockPageScrollIfNoModal() {
  if (document.querySelector('.modal-overlay.show')) return;
  const y = NOOR.modalScrollY || 0;
  document.body.classList.remove('modal-scroll-locked');
  document.body.style.top = '';
  window.scrollTo(0, y);
  NOOR.modalScrollY = 0;
}

function openModal(id){
  closeMoreMenu();
  const overlay = document.getElementById(id);
  if (!overlay) return;
  lockPageScrollForModal();
  overlay.classList.add('show');
  // Stop any touch/click on the overlay reaching the bottom-nav or page beneath
  if (!overlay._touchGuarded) {
    overlay.addEventListener('touchstart', e => e.stopPropagation(), {passive:false});
    overlay.addEventListener('touchend',   e => e.stopPropagation(), {passive:false});
    overlay.addEventListener('touchmove',  e => {
      e.stopPropagation();
      if (!e.target.closest?.('.modal-body')) e.preventDefault();
    }, {passive:false});
    overlay._touchGuarded = true;
  }
  if (id === 'modal-patient') setTimeout(markPatientFormClean, 0);
}
function closeModal(id){
  if (id === 'modal-patient' && NOOR.patientFormDirty && !confirmUnsavedPatientForm()) return;
  document.getElementById(id)?.classList.remove('show');
  if (id === 'modal-patient') markPatientFormClean();
  if (id === 'modal-duplicate-patient' && NOOR.duplicatePatientResolver) {
    const resolve = NOOR.duplicatePatientResolver;
    NOOR.duplicatePatientResolver = null;
    resolve(false);
  }
  unlockPageScrollIfNoModal();
}

function patientFormState() {
  const modal = document.getElementById('modal-patient');
  if (!modal) return '';
  const fields = [...modal.querySelectorAll('input,select,textarea')].map(el => ({
    id: el.id || el.name || '',
    value: el.type === 'checkbox' ? el.checked : el.value,
    selected: el.classList.contains('selected'),
  }));
  const chips = [...modal.querySelectorAll('.coating-chip')].map(el => [el.dataset.val, el.classList.contains('selected')]);
  return JSON.stringify({ mode: NOOR.patientModalMode, fields, chips });
}
function markPatientFormClean() {
  NOOR.patientFormSnapshot = patientFormState();
  NOOR.patientFormDirty = false;
}
let _patientDirtyTimer;
function updatePatientFormDirty() {
  const modal = document.getElementById('modal-patient');
  if (!modal?.classList.contains('show')) return;
  clearTimeout(_patientDirtyTimer);
  _patientDirtyTimer = setTimeout(() => {
    NOOR.patientFormDirty = patientFormState() !== NOOR.patientFormSnapshot;
  }, 150);
}
function confirmUnsavedPatientForm() {
  return confirm(NOOR.lang === 'ar'
    ? 'لديك تغييرات غير محفوظة. هل تريد إغلاق النموذج؟'
    : 'You have unsaved changes. Close this form?');
}

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════
