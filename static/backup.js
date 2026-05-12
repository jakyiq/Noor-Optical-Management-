/* backup.js - extracted from index.html. Plain script, globals intentionally preserved. */
// ══════════════════════════════════════════════════════════
// BACKUP & RESTORE
// ══════════════════════════════════════════════════════════

let _restorePayload = null; // holds parsed backup JSON pending confirmation

function _backupI18n() {
  const isAr = NOOR.lang === 'ar';
  // Static labels on the backup tab (updated when tab is opened or lang changes)
  const set = (id, ar, en) => { const el = document.getElementById(id); if (el) el.textContent = isAr ? ar : en; };
  set('backup-section-title',    'النسخ الاحتياطي',                    'Backup');
  set('btn-create-backup-label', 'تنزيل نسخة احتياطية',               'Download Backup');
  set('restore-section-title',   'استعادة من نسخة احتياطية',           'Restore from Backup');
  set('btn-choose-file-label',   'اختر ملف',                           'Choose File');
  set('restore-preview-title',   'معاينة النسخة الاحتياطية:',          'Backup Preview:');
  set('btn-confirm-restore-label','استعادة البيانات',                   'Restore Data');
  set('backup-history-title',    'سجل النسخ الاحتياطية',               'Backup History');
  set('th-backup-date',          'التاريخ',                            'Date');
  set('th-backup-type',          'النوع',                              'Type');
  set('th-backup-records',       'السجلات',                            'Records');
  set('th-backup-actions',       'تنزيل',                              'Download');

  const descBkp = document.getElementById('backup-desc-text');
  if (descBkp) descBkp.textContent = isAr
    ? 'يحتوي النسخ الاحتياطي على جميع بيانات العيادة: المراجعين، الزيارات، المخزون، المبيعات، التكاليف، والإعدادات. يمكن استخدامه لاستعادة البيانات أو نقلها إلى نسخة سطح المكتب مستقبلاً.'
    : 'The backup contains all clinic data: patients, visits, inventory, sales, expenses, and settings. Use it to restore data or migrate to a future desktop version.';

  const descRst = document.getElementById('restore-desc-text');
  if (descRst) descRst.textContent = isAr
    ? 'اختر ملف نسخة احتياطية بصيغة JSON لاستعادة البيانات. ستُدمج البيانات مع الموجودة (لن يتم حذف أي شيء).'
    : 'Choose a JSON backup file to restore. Data will be merged with existing records (nothing is deleted).';
}

async function openBackupTab() {
  _backupI18n();
  await loadBackupHistory();
}

async function createBackup() {
  if (!_checkExportAllowed()) return;
  const btn = document.getElementById('btn-create-backup');
  if (btn) btn.disabled = true;
  try {
    const res = await post('/api/backup', {});
    const payload = res.data?.backup;
    if (!payload) throw new Error('No backup data returned');

    const clinicName = (payload.clinic?.name || 'clinic').replace(/[^a-z0-9_؀-ۿ]/gi, '_');
    const date = new Date().toISOString().slice(0, 10);
    const filename = `noor-backup-${clinicName}-${date}.json`;

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const rc = res.data?.row_counts || {};
    const total = Object.values(rc).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const info = document.getElementById('backup-last-info');
    if (info) info.textContent = (NOOR.lang === 'ar')
      ? `✓ تم التنزيل — ${total} سجل`
      : `✓ Downloaded — ${total} records`;

    toast(NOOR.lang === 'ar' ? 'تم إنشاء النسخة الاحتياطية بنجاح' : 'Backup created successfully', 'success');
    await loadBackupHistory();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadBackupHistory() {
  const tbody = document.getElementById('backup-history-tbody');
  if (!tbody) return;
  try {
    const res = await get('/api/backup/history');
    const rows = res.data || [];
    const isAr = NOOR.lang === 'ar';

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-light)">${isAr ? 'لا توجد نسخ احتياطية بعد' : 'No backups yet'}</td></tr>`;
      return;
    }

    tbody.innerHTML = rows.map(r => {
      const rc = r.row_counts || {};
      const total = Object.values(rc).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
      const kind = r.kind === 'restore'
        ? (isAr ? 'استعادة' : 'Restore')
        : (isAr ? 'يدوي' : 'Manual');
      const dt = r.created_at ? new Date(r.created_at).toLocaleString(isAr ? 'ar-IQ' : 'en-GB') : '—';
      return `<tr>
        <td>${dt}</td>
        <td><span class="badge badge-${r.kind === 'restore' ? 'warning' : 'success'}">${kind}</span></td>
        <td>${total.toLocaleString()}</td>
        <td>
          ${r.kind !== 'restore' ? `<button class="btn btn-sm btn-outline" onclick="downloadStoredBackup('${r.id}')">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>` : '—'}
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    const isAr = NOOR.lang === 'ar';
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--ink-light)">${isAr ? 'تعذر تحميل السجل' : 'Failed to load history'}</td></tr>`;
  }
}

async function downloadStoredBackup(backupId) {
  try {
    const res = await get(`/api/backup/${backupId}/download`);
    const row = res.data;
    if (!row) throw new Error('Not found');
    const payload = row.backup_data;
    const clinicName = (payload?.clinic?.name || 'clinic').replace(/[^a-z0-9_؀-ۿ]/gi, '_');
    const date = (row.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `noor-backup-${clinicName}-${date}.json`;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function onRestoreFileChosen(input) {
  const file = input.files[0];
  if (!file) return;
  const nameEl = document.getElementById('restore-file-name');
  if (nameEl) nameEl.textContent = file.name;

  // Guard: only accept .json files
  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
    _restorePayload = null;
    const isAr = NOOR.lang === 'ar';
    toast(isAr ? 'يُقبل ملف JSON فقط (.json)' : 'Only JSON backup files are accepted (.json)', 'error');
    document.getElementById('restore-preview').style.display = 'none';
    return;
  }

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const rawText = String(e.target.result || '').replace(/^\uFEFF/, '').trim();
      const parsed = JSON.parse(rawText);
      const isAr = NOOR.lang === 'ar';
      const backup = normalizeBackupPayload(parsed);

      // Must be an object (not array/null)
      if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
        throw new Error('not_object');
      }

      // Must contain at least one known backup table key
      const KNOWN = ['patients','visits','frames','lenses','clinic_lens_catalog','retail_sales','operating_expenses','clinic_settings','clinic'];
      const hasData = KNOWN.some(k => backup[k] !== undefined);
      if (!hasData) {
        toast(isAr ? 'هذا ملف JSON صحيح، لكنه لا يحتوي على بيانات نسخة Noor الاحتياطية.' : 'This is valid JSON, but it does not contain Noor backup data.', 'error');
        _restorePayload = null;
        document.getElementById('restore-preview').style.display = 'none';
        return;
      }

      // Warn (but don't block) if format version is unexpected
      const fmt = backup._meta && backup._meta.format_version;
      if (fmt && fmt !== '2') {
        toast(isAr ? ('تحذير: إصدار النسخة ' + fmt + ' — قد تكون بعض الحقول غير متوافقة') : ('Warning: backup format v' + fmt + ' — some fields may not be compatible'), 'warning');
      }

      _restorePayload = backup;
      _showRestorePreview(backup);
    } catch (err) {
      _restorePayload = null;
      const isAr = NOOR.lang === 'ar';
      const msg = err.message === 'not_object'
        ? (isAr ? 'الملف ليس نسخة احتياطية صالحة من Noor' : 'File is not a valid Noor backup object')
        : (isAr ? `تعذر قراءة JSON: ${err.message}` : `Could not parse JSON: ${err.message}`);
      toast(msg, 'error');
      document.getElementById('restore-preview').style.display = 'none';
    }
  };
  reader.readAsText(file);
}

function normalizeBackupPayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (parsed.backup && typeof parsed.backup === 'object') return parsed.backup;
  if (parsed.data?.backup && typeof parsed.data.backup === 'object') return parsed.data.backup;
  if (parsed.backup_data && typeof parsed.backup_data === 'object') return parsed.backup_data;
  if (parsed.data?.backup_data && typeof parsed.data.backup_data === 'object') return parsed.data.backup_data;
  return parsed;
}

function _showRestorePreview(payload) {
  const isAr = NOOR.lang === 'ar';
  const preview = document.getElementById('restore-preview');
  const body    = document.getElementById('restore-preview-body');
  const meta    = document.getElementById('restore-meta');
  if (!preview || !body) return;

  const TABLE_LABELS = {
    patients:           { ar: 'المراجعين',        en: 'Patients' },
    visits:             { ar: 'الزيارات',          en: 'Visits' },
    frames:             { ar: 'الإطارات',           en: 'Frames' },
    lenses:             { ar: 'العدسات',            en: 'Lenses' },
    retail_sales:       { ar: 'المبيعات الإضافية', en: 'Retail Sales' },
    operating_expenses: { ar: 'التكاليف التشغيلية',en: 'Expenses' },
    clinic_settings:    { ar: 'الإعدادات',          en: 'Settings' },
    clinic_lens_catalog:{ ar: 'كتالوج العدسات',     en: 'Lens Catalog' },
  };

  body.innerHTML = Object.entries(TABLE_LABELS).map(([key, lbl]) => {
    const count = Array.isArray(payload[key]) ? payload[key].length : (payload[key] ? 1 : 0);
    return `<div style="background:var(--surface);border:1px solid var(--cream-border);border-radius:6px;padding:8px 12px">
      <div style="font-weight:600;font-size:.8rem">${isAr ? lbl.ar : lbl.en}</div>
      <div style="font-size:1.1rem;font-weight:700;color:var(--burgundy)">${count.toLocaleString()}</div>
    </div>`;
  }).join('');

  const m = payload._meta || {};
  const createdAt = m.created_at ? new Date(m.created_at).toLocaleString(isAr ? 'ar-IQ' : 'en-GB') : '—';
  const srcClinic = payload.clinic?.name || m.clinic_id || '—';
  meta.innerHTML = `${isAr ? 'تاريخ النسخة' : 'Backup date'}: <strong>${createdAt}</strong> &nbsp;|&nbsp; ${isAr ? 'العيادة' : 'Clinic'}: <strong>${esc(srcClinic)}</strong> &nbsp;|&nbsp; ${isAr ? 'الإصدار' : 'Format'}: <strong>v${m.format_version || '?'}</strong>`;

  preview.style.display = 'block';
}

async function confirmRestore() {
  if (!_restorePayload) return;
  const isAr = NOOR.lang === 'ar';
  const msg = isAr
    ? 'سيتم دمج هذه البيانات مع بيانات العيادة الحالية. لن يتم حذف أي سجلات. هل أنت متأكد؟'
    : 'This backup will be merged into the current clinic data. No records will be deleted. Confirm?';
  if (!confirm(msg)) return;

  const btn = document.getElementById('btn-confirm-restore');
  if (btn) btn.disabled = true;

  try {
    // Dry run first
    const dry = await post('/api/restore', { backup: _restorePayload, confirm: false });
    const summary = dry.data?.summary || {};
    const total = Object.values(summary).reduce((s, v) => s + v, 0);
    const confirmMsg = isAr
      ? `سيتم استعادة ${total.toLocaleString()} سجل. المتابعة؟`
      : `This will restore ${total.toLocaleString()} records. Proceed?`;
    if (!confirm(confirmMsg)) { if (btn) btn.disabled = false; return; }

    // Actual restore
    const res = await post('/api/restore', { backup: _restorePayload, confirm: true });
    const restored = res.data?.restored || {};
    const errors   = res.data?.errors || [];
    const resTotal = Object.values(restored).reduce((s, v) => s + v, 0);

    if (errors.length) {
      toast((isAr ? 'اكتملت الاستعادة مع بعض الأخطاء: ' : 'Restore completed with errors: ') + errors.join('; '), 'error');
    } else {
      toast(isAr ? `تمت الاستعادة بنجاح — ${resTotal.toLocaleString()} سجل` : `Restore successful — ${resTotal.toLocaleString()} records`, 'success');
    }

    cancelRestore();
    await loadBackupHistory();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function cancelRestore() {
  _restorePayload = null;
  const preview = document.getElementById('restore-preview');
  const fileInput = document.getElementById('restore-file-input');
  const fileName  = document.getElementById('restore-file-name');
  if (preview)   preview.style.display = 'none';
  if (fileInput) fileInput.value = '';
  if (fileName)  fileName.textContent = '';
}
