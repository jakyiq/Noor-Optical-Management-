/**
 * localFirst.js — Noor Optical Clinic
 * ─────────────────────────────────────────────────────────────────────────────
 * Local-First architecture layer: IndexedDB queue → Supabase sync via Flask API
 *
 * Architecture overview:
 *   1. Every write goes to StorageAdapter (IndexedDB) FIRST with status:'pending'
 *   2. Heartbeat() runs every 15 s and whenever the browser goes back online
 *   3. Heartbeat flushes pending items → POST /api/sync/flush
 *   4. Flask endpoint does a timestamp comparison; if Supabase wins, it returns
 *      the server record so the UI can prompt the user
 *   5. Tauri swap: replace `BrowserStorageAdapter` with `TauriStorageAdapter`
 *      (same interface, uses __TAURI__.fs instead of IndexedDB)
 *
 * Usage in index.html:
 *   <script src="/localFirst.js"></script>
 *   // Replace direct `post('/api/patients', body)` calls with:
 *   await NoorLF.enqueue('patients', 'upsert', body);
 *   // Or wrap existing API helper:
 *   const res = await NoorLF.write('patients', 'upsert', body);
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// § 1  CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const LF_DB_NAME      = 'noor_lf';
const LF_DB_VERSION   = 1;
const LF_STORE        = 'sync_queue';
const HEARTBEAT_MS    = 15_000;      // poll interval when online
const MAX_RETRY       = 5;           // drop item after this many hard failures
const CONFLICT_POLICY = 'prompt';    // 'prompt' | 'server' | 'local'

// ─────────────────────────────────────────────────────────────────────────────
// § 2  STORAGE ADAPTER INTERFACE
//      Both adapters expose the same async methods so the sync engine is
//      completely agnostic.  Swap adapters by changing NoorLF.storage.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BrowserStorageAdapter — backed by IndexedDB.
 * Used in all PWA / browser contexts.
 */
class BrowserStorageAdapter {
  constructor() {
    this._db = null;
  }

  /** Open (or upgrade) the IndexedDB database. */
  async open() {
    if (this._db) return this._db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(LF_DB_NAME, LF_DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db    = e.target.result;
        // sync_queue stores every pending mutation
        if (!db.objectStoreNames.contains(LF_STORE)) {
          const store = db.createObjectStore(LF_STORE, { keyPath: 'local_id', autoIncrement: true });
          store.createIndex('by_status',    'status',       { unique: false });
          store.createIndex('by_entity',    'entity_type',  { unique: false });
          store.createIndex('by_entity_id', 'entity_id',    { unique: false });
        }
      };

      req.onsuccess = (e) => { this._db = e.target.result; resolve(this._db); };
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  async _tx(mode, fn) {
    const db    = await this.open();
    const tx    = db.transaction(LF_STORE, mode);
    const store = tx.objectStore(LF_STORE);
    return new Promise((resolve, reject) => {
      const result = fn(store);
      tx.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  /** Add a new item to the queue. Returns the generated local_id. */
  async enqueue(item) {
    const db  = await this.open();
    const tx  = db.transaction(LF_STORE, 'readwrite');
    const req = tx.objectStore(LF_STORE).add(item);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);   // local_id
      tx.onerror   = (e) => reject(e.target.error);
    });
  }

  /** Return all items matching a given status. */
  async getByStatus(status) {
    const db    = await this.open();
    const tx    = db.transaction(LF_STORE, 'readonly');
    const index = tx.objectStore(LF_STORE).index('by_status');
    const req   = index.getAll(status);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** Update an existing item by its local_id. */
  async update(local_id, patch) {
    const db   = await this.open();
    const tx   = db.transaction(LF_STORE, 'readwrite');
    const store = tx.objectStore(LF_STORE);
    return new Promise((resolve, reject) => {
      const getReq = store.get(local_id);
      getReq.onsuccess = () => {
        const item    = getReq.result;
        if (!item) return reject(new Error(`local_id ${local_id} not found`));
        const updated = { ...item, ...patch };
        const putReq  = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
      };
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /** Delete a queue item after successful sync. */
  async remove(local_id) {
    const db  = await this.open();
    const tx  = db.transaction(LF_STORE, 'readwrite');
    const req = tx.objectStore(LF_STORE).delete(local_id);
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve();
      tx.onerror    = (e) => reject(e.target.error);
    });
  }

  /** Count items by status (used for the BeforeUnload guard). */
  async countPending() {
    const db    = await this.open();
    const tx    = db.transaction(LF_STORE, 'readonly');
    const index = tx.objectStore(LF_STORE).index('by_status');
    const req   = index.count('pending');
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /** Wipe everything — used after a successful full restore. */
  async clear() {
    return this._tx('readwrite', (store) => store.clear());
  }
}

/**
 * TauriStorageAdapter — backed by the Tauri filesystem API.
 * Drop-in replacement for BrowserStorageAdapter when running inside Tauri.
 *
 * To activate: NoorLF.useAdapter(new TauriStorageAdapter());
 *
 * Stores the queue as a JSON file at {appData}/noor_queue.json
 * All methods are async and match the BrowserStorageAdapter interface exactly.
 */
class TauriStorageAdapter {
  constructor() {
    this._path  = 'noor_queue.json';
    this._cache = null;   // in-memory mirror to avoid FS thrash
    this._nextId = 1;
  }

  async _load() {
    if (this._cache) return this._cache;
    try {
      const { readTextFile, BaseDirectory } = window.__TAURI__.fs;
      const raw = await readTextFile(this._path, { dir: BaseDirectory.AppData });
      this._cache = JSON.parse(raw);
      this._nextId = (this._cache.reduce((m, i) => Math.max(m, i.local_id), 0) || 0) + 1;
    } catch (_) {
      // File doesn't exist yet — start fresh
      this._cache  = [];
      this._nextId = 1;
    }
    return this._cache;
  }

  async _save() {
    const { writeTextFile, BaseDirectory } = window.__TAURI__.fs;
    await writeTextFile(this._path, JSON.stringify(this._cache), { dir: BaseDirectory.AppData });
  }

  async enqueue(item) {
    const items = await this._load();
    const local_id = this._nextId++;
    items.push({ ...item, local_id });
    await this._save();
    return local_id;
  }

  async getByStatus(status) {
    const items = await this._load();
    return items.filter(i => i.status === status);
  }

  async update(local_id, patch) {
    const items = await this._load();
    const idx   = items.findIndex(i => i.local_id === local_id);
    if (idx === -1) throw new Error(`local_id ${local_id} not found`);
    items[idx] = { ...items[idx], ...patch };
    await this._save();
    return items[idx];
  }

  async remove(local_id) {
    const items    = await this._load();
    this._cache    = items.filter(i => i.local_id !== local_id);
    await this._save();
  }

  async countPending() {
    const items = await this._load();
    return items.filter(i => i.status === 'pending').length;
  }

  async clear() {
    this._cache = [];
    await this._save();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3  CONFLICT RESOLUTION UI
//      Called when the server reports a newer timestamp than our local record.
//      Returns a Promise that resolves to 'local' | 'server'.
// ─────────────────────────────────────────────────────────────────────────────

function _showConflictDialog(entityType, localRecord, serverRecord) {
  return new Promise((resolve) => {
    // Attempt to use any existing NoorLF.onConflict hook first
    if (typeof NoorLF.onConflict === 'function') {
      return NoorLF.onConflict(entityType, localRecord, serverRecord, resolve);
    }

    // Default: native confirm dialog (replace with a beautiful modal in index.html)
    const isAr = document.documentElement.lang === 'ar';
    const msg  = isAr
      ? `تعارض في البيانات:\nالسجل على الخادم أحدث من نسختك المحلية.\n\nاضغط موافق للاحتفاظ بنسخة الخادم، أو إلغاء للاحتفاظ بالنسخة المحلية.`
      : `Data conflict detected:\nThe server has a newer version of this record.\n\nPress OK to keep the server version, or Cancel to keep your local changes.`;
    resolve(confirm(msg) ? 'server' : 'local');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  CORE SYNC ENGINE
// ─────────────────────────────────────────────────────────────────────────────

let _heartbeatTimer = null;
let _syncInProgress = false;

/**
 * Flush all pending items in the queue to the server.
 * Called by the heartbeat and by the online event listener.
 */
async function _flush() {
  if (_syncInProgress || !navigator.onLine) return;
  _syncInProgress = true;

  try {
    const pending = await NoorLF.storage.getByStatus('pending');
    if (!pending.length) return;

    for (const item of pending) {
      await _syncItem(item);
    }
  } catch (err) {
    console.warn('[NoorLF] flush error', err);
  } finally {
    _syncInProgress = false;
  }
}

/**
 * Push a single queue item to the Flask backend.
 * The backend endpoint POST /api/sync/item handles the Supabase upsert
 * and returns conflict information if the server record is newer.
 */
async function _syncItem(item) {
  try {
    const resp = await fetch('/api/sync/item', {
      method:      'POST',
      credentials: 'include',
      headers: {
        'Content-Type':  'application/json',
        'X-CSRF-Token':  _getCsrfToken(),
      },
      body: JSON.stringify({
        local_id:    item.local_id,
        entity_type: item.entity_type,
        entity_id:   item.entity_id,
        operation:   item.operation,
        payload:     item.payload,
        last_modified: item.last_modified,
      }),
    });

    const body = await resp.json();

    // ── Conflict: server record is newer ──────────────────────────────────
    if (resp.status === 409 || body.conflict) {
      let resolution = CONFLICT_POLICY;

      if (CONFLICT_POLICY === 'prompt') {
        resolution = await _showConflictDialog(
          item.entity_type,
          item.payload,
          body.server_record,
        );
      }

      if (resolution === 'server') {
        // Accept server version → remove local item, notify app
        await NoorLF.storage.remove(item.local_id);
        NoorLF._emit('conflict_resolved', { winner: 'server', item, server_record: body.server_record });
      } else {
        // Force-push local version → re-queue with force flag
        await NoorLF.storage.update(item.local_id, { force: true, retry_count: (item.retry_count || 0) + 1 });
        await _syncItem({ ...item, force: true });
      }
      return;
    }

    // ── Success ───────────────────────────────────────────────────────────
    if (resp.ok && body.ok) {
      await NoorLF.storage.remove(item.local_id);
      NoorLF._emit('synced', { item, server_record: body.data });
      return;
    }

    // ── Retryable server error ─────────────────────────────────────────────
    throw new Error(body.error || `HTTP ${resp.status}`);

  } catch (err) {
    const retries = (item.retry_count || 0) + 1;
    if (retries >= MAX_RETRY) {
      await NoorLF.storage.update(item.local_id, { status: 'failed', retry_count: retries, last_error: String(err) });
      NoorLF._emit('sync_failed', { item, error: err });
      console.error('[NoorLF] item permanently failed', item.local_id, err);
    } else {
      await NoorLF.storage.update(item.local_id, { status: 'pending', retry_count: retries, last_error: String(err) });
    }
  }
}

/** Read the CSRF token from the hidden meta tag that Flask injects. */
function _getCsrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.content
      || window.NOOR?.csrfToken
      || '';
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  HEARTBEAT
// ─────────────────────────────────────────────────────────────────────────────

function _startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    if (navigator.onLine) _flush();
  }, HEARTBEAT_MS);

  window.addEventListener('online',  () => { NoorLF._emit('online');  _flush(); });
  window.addEventListener('offline', () => { NoorLF._emit('offline'); });
}

function _stopHeartbeat() {
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6  BEFOREUNLOAD GUARD
// ─────────────────────────────────────────────────────────────────────────────

async function _beforeUnloadGuard(e) {
  const count = await NoorLF.storage.countPending();
  if (count > 0) {
    const msg = document.documentElement.lang === 'ar'
      ? 'لديك بيانات سريرية لم تُحفظ. الإغلاق الآن قد يؤدي إلى فقدان البيانات.'
      : 'You have unsaved clinical data. Closing now may result in data loss.';
    e.preventDefault();
    e.returnValue = msg;   // Chrome requires returnValue to be set
    return msg;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  PUBLIC API  — NoorLF namespace
// ─────────────────────────────────────────────────────────────────────────────

const NoorLF = {
  // Pluggable storage adapter
  storage: new BrowserStorageAdapter(),

  // Adapters exposed for easy import
  BrowserStorageAdapter,
  TauriStorageAdapter,

  // Optional conflict hook — set from index.html after nice modal is built:
  // NoorLF.onConflict = (entityType, local, server, resolve) => { ... }
  onConflict: null,

  // ── Event bus (lightweight) ──────────────────────────────────────────────
  _listeners: {},

  on(event, fn) {
    (this._listeners[event] = this._listeners[event] || []).push(fn);
    return this;
  },

  off(event, fn) {
    this._listeners[event] = (this._listeners[event] || []).filter(f => f !== fn);
    return this;
  },

  _emit(event, detail) {
    (this._listeners[event] || []).forEach(fn => {
      try { fn(detail); } catch (e) { console.error('[NoorLF] listener error', e); }
    });
  },

  // ── Adapter swap ──────────────────────────────────────────────────────────
  /**
   * Call this BEFORE init() to use a different storage backend.
   * Example: NoorLF.useAdapter(new NoorLF.TauriStorageAdapter());
   */
  useAdapter(adapter) {
    this.storage = adapter;
    return this;
  },

  // ── Initialise (call once on app boot) ───────────────────────────────────
  async init() {
    await this.storage.open?.();     // optional: BrowserStorageAdapter pre-opens IDB
    _startHeartbeat();
    window.addEventListener('beforeunload', _beforeUnloadGuard);
    if (navigator.onLine) _flush();  // flush any items left from last session
    console.info('[NoorLF] initialised. Adapter:', this.storage.constructor.name);
    return this;
  },

  // ── Write helpers ─────────────────────────────────────────────────────────

  /**
   * Core method: save a mutation locally, then attempt immediate sync.
   *
   * @param {string}  entityType  e.g. 'patients', 'visits', 'frames'
   * @param {string}  operation   'upsert' | 'delete'
   * @param {object}  payload     The full record body (as you would send to Flask)
   * @param {string}  [entityId]  The record's UUID (if already known)
   * @returns {number}            The local_id assigned to this queue item
   */
  async enqueue(entityType, operation, payload, entityId = null) {
    const item = {
      entity_type:   entityType,
      entity_id:     entityId ?? payload?.id ?? null,
      operation,
      payload,
      status:        'pending',
      last_modified: new Date().toISOString(),
      retry_count:   0,
      last_error:    null,
      force:         false,
      created_at:    new Date().toISOString(),
    };

    const local_id = await this.storage.enqueue(item);
    this._emit('queued', { local_id, ...item });

    // Attempt immediate sync if online
    if (navigator.onLine) {
      _flush();   // non-blocking
    }

    return local_id;
  },

  /**
   * write() — convenience wrapper that mirrors the old `post()` call pattern.
   * Saves locally first, then returns an optimistic result so the UI can
   * update immediately without waiting for network.
   *
   * Usage:
   *   // Before (direct API):
   *   const res = await post('/api/patients', body);
   *   // After (local-first):
   *   const res = await NoorLF.write('patients', 'upsert', body);
   */
  async write(entityType, operation, payload, entityId = null) {
    const local_id = await this.enqueue(entityType, operation, payload, entityId);

    // Return an optimistic response so the caller can proceed immediately
    return {
      ok:       true,
      local_id,
      pending:  true,
      data:     { ...payload, _local_id: local_id, _pending: true },
    };
  },

  // ── Sync status helpers ───────────────────────────────────────────────────

  /** Returns the count of un-synced items. */
  async pendingCount() {
    return this.storage.countPending();
  },

  /** Returns true if there are items waiting to be synced. */
  async hasPending() {
    return (await this.storage.countPending()) > 0;
  },

  /** Manually trigger a sync flush. Useful for a "sync now" button. */
  async flush() {
    return _flush();
  },

  /** Stop the background heartbeat (e.g., on logout). */
  stopHeartbeat: _stopHeartbeat,

  // ── Queue introspection ───────────────────────────────────────────────────

  /** Returns all pending items. Useful for a debug panel. */
  async getPending() {
    return this.storage.getByStatus('pending');
  },

  /** Returns all permanently failed items. */
  async getFailed() {
    return this.storage.getByStatus('failed');
  },

  /** Retry all failed items by resetting their status to 'pending'. */
  async retryFailed() {
    const failed = await this.storage.getByStatus('failed');
    for (const item of failed) {
      await this.storage.update(item.local_id, { status: 'pending', retry_count: 0, last_error: null });
    }
    if (failed.length > 0 && navigator.onLine) _flush();
    return failed.length;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// § 8  AUTO-DETECT TAURI
//      If the page is running inside a Tauri webview, swap the adapter
//      automatically so no manual code change is required.
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window.__TAURI__ !== 'undefined') {
  NoorLF.useAdapter(new TauriStorageAdapter());
  console.info('[NoorLF] Tauri detected — using filesystem storage adapter');
}

// ─────────────────────────────────────────────────────────────────────────────
// § 9  PENDING BADGE HELPER
//      Keeps a DOM badge in sync with the queue count.
//      Attach it to any element: NoorLF.bindBadge(document.getElementById('sync-badge'))
// ─────────────────────────────────────────────────────────────────────────────

NoorLF.bindBadge = function (el) {
  if (!el) return;

  const refresh = async () => {
    const n = await NoorLF.pendingCount();
    el.textContent  = n > 0 ? String(n) : '';
    el.style.display = n > 0 ? '' : 'none';
    el.title = n > 0
      ? (document.documentElement.lang === 'ar' ? `${n} عملية في الانتظار` : `${n} pending`)
      : '';
  };

  NoorLF.on('queued',             refresh);
  NoorLF.on('synced',             refresh);
  NoorLF.on('sync_failed',        refresh);
  NoorLF.on('conflict_resolved',  refresh);
  refresh();
};

// ─────────────────────────────────────────────────────────────────────────────
// § 10  EXPORT (works as a plain <script> tag or an ES module)
// ─────────────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NoorLF;
} else if (typeof globalThis !== 'undefined') {
  globalThis.NoorLF = NoorLF;
}
