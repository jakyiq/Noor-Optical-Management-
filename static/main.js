/* main.js - extracted from index.html. Plain script, globals intentionally preserved. */
// ══════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════
applyLang();
handleResize();


// ── Service Worker registration (Bug fix #22) ──────────────────────────────
// Registers sw.js to enable the PWA offline shell cache and Background Sync.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    // Register Background Sync tag so the SW can trigger a flush on reconnect
    reg.sync?.register('noor-lf-flush').catch(() => {
      // Background Sync not supported — the heartbeat handles it instead
    });
  }).catch(err => console.warn('[Noor] SW registration failed:', err));

  // Listen for SW → page messages (e.g. NF_FLUSH when back online)
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'NF_FLUSH') NoorLF?.flush?.();
  });
}

// ── LocalFirst layer init (Bug fix #19) ────────────────────────────────────
// NoorLF is provided by /localFirst.js (loaded in <head>).
// Wire up the pending-items badge and a bilingual conflict dialog.
if (typeof NoorLF !== 'undefined') {
  NoorLF.init().then(() => {
    NoorLF.bindBadge(document.getElementById('sync-pending-badge'));
  });

  NoorLF.onConflict = function(entityType, localRecord, serverRecord, resolve) {
    const isAr = NOOR.lang === 'ar';
    const msg = isAr
      ? `تعارض في بيانات ${entityType}:\nالخادم يحتوي على إصدار أحدث.\nهل تريد الاحتفاظ بنسخة الخادم؟`
      : `Conflict in ${entityType}:\nThe server has a newer version.\nKeep the server version?`;
    resolve(confirm(msg) ? 'server' : 'local');
  };
}

checkSession();  // restores session on page reload without showing login screen
