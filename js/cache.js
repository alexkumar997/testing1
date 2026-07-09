// ── Local Cache Layer ──────────────────────────────────────────────────────
// Purpose: reduce Supabase Egress by serving repeat reads from localStorage
// instead of the network, while keeping data fresh via TTL + background
// refresh. Never used for Continue Watching, Auth, or writes.
//
// Design:
//  - Every cache entry is namespaced under 'efm_cache_' and tagged with the
//    app version shown on the About page. When that version changes, every
//    cache entry is wiped automatically (no manual CACHE_VERSION constant).
//  - cachedFetch() implements strict expiry: if an entry is expired it is
//    deleted immediately and a synchronous fresh fetch is made. Expired data
//    is never served.
//  - In-flight de-duplication ensures that if multiple parts of the UI ask
//    for the same key at the same time, only one network request is made.
//  - A background cleanup worker runs every 5 minutes, scans all cache keys,
//    and removes any that have passed their TTL. Only one worker can exist
//    (singleton guard). No page refresh required for cleanup to take effect.

(function (global) {
  var CACHE_PREFIX = 'efm_cache_';
  var VERSION_KEY  = 'efm_cache_app_version';

  // ── TTL constants ─────────────────────────────────────────────────────────
  var TTL_6H  = 6  * 60 * 60 * 1000;
  var TTL_3H  = 3  * 60 * 60 * 1000;
  var TTL_24H = 24 * 60 * 60 * 1000;

  var CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  var _cleanupTimer = null; // singleton guard — only one worker allowed

  // ── Debug hook (no-op unless js/debug-panel.js sets DEBUG_PANEL = true) ──
  // Purely observational: emits event notifications for monitoring only.
  // Never changes control flow, return values, or timing of real logic.
  function _hook(type, payload) {
    if (typeof global.__debugHook === 'function') {
      try { global.__debugHook(type, payload); } catch (e) {}
    }
  }

  // ── App version (used for automatic cache bust on deploy) ─────────────────
  function getAppVersion() {
    try {
      var el = document.querySelector('.about-version');
      if (el && el.textContent) {
        var m = el.textContent.match(/\d+(\.\d+)+/);
        if (m) return m[0];
      }
    } catch (e) {}
    return 'v0';
  }

  function ensureVersion() {
    try {
      var current = getAppVersion();
      var stored  = localStorage.getItem(VERSION_KEY);
      if (stored !== current) {
        clearAllCache();
        localStorage.setItem(VERSION_KEY, current);
        console.log('[CACHE] App version changed (' + stored + ' → ' + current + ') — cache cleared');
        _hook('VERSION_CHANGED', { previous: stored, current: current });
      }
    } catch (e) {}
  }

  // ── Core storage primitives ───────────────────────────────────────────────

  function getCache(key) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // Every entry stores: data, ts (created timestamp, ms), createdAt (alias of
  // ts for clarity), expiresAt (ts + ttl, ms), ttl (ms). All fields present
  // when ttlMs is provided. Backward-compat: old entries with only ts/ttl
  // still work because isFresh() reads ts.
  function setCache(key, data, ttlMs) {
    try {
      var now   = Date.now();
      var entry = { data: data, ts: now, createdAt: now };
      if (ttlMs) {
        entry.ttl       = ttlMs;
        entry.expiresAt = now + ttlMs;
      }
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      // Storage full / blocked (private mode) — fail silently, never break the app
    }
  }

  function deleteCache(key) {
    try { localStorage.removeItem(CACHE_PREFIX + key); } catch (e) {}
  }

  function clearAllCache() {
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
      _hook('CACHE_CLEARED', { count: toRemove.length });
    } catch (e) {}
  }

  // ── Freshness check ───────────────────────────────────────────────────────

  function isFresh(entry, ttlMs) {
    return !!entry && (Date.now() - entry.ts) < ttlMs;
  }

  // ── Read-only metadata for a cache key — used only by the debug panel ─────
  // Never triggers a network call or mutates anything.
  function getMeta(key, fallbackTtlMs) {
    var entry = getCache(key);
    if (!entry) return null;
    var ttl      = entry.ttl || fallbackTtlMs || 0;
    var created  = entry.createdAt || entry.ts;
    var age      = Date.now() - created;
    var raw      = null;
    try { raw = localStorage.getItem(CACHE_PREFIX + key); } catch (e) {}
    return {
      key:        key,
      createdAt:  created,
      ttlMs:      ttl,
      age:        age,
      expiresAt:  ttl ? (created + ttl) : null,
      remaining:  ttl ? Math.max(0, (created + ttl) - Date.now()) : null,
      fresh:      ttl ? isFresh(entry, ttl) : null,
      sizeBytes:  raw ? raw.length : 0
    };
  }

  // ── Mutate a cached entry in place ────────────────────────────────────────
  // (e.g. flip a "read" flag) without touching its timestamp/TTL.
  // Preserves all original entry fields (ts, ttl, createdAt, expiresAt).
  // No-op if nothing is cached for the key yet.
  function updateCached(key, mutateFn) {
    try {
      var entry = getCache(key);
      if (!entry) return;
      var updated  = mutateFn(entry.data);
      var newEntry = Object.assign({}, entry, { data: updated });
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(newEntry));
    } catch (e) {}
  }

  // ── Prefix invalidation ───────────────────────────────────────────────────

  function invalidatePrefix(prefix) {
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX + prefix) === 0) toRemove.push(k);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
    } catch (e) {}
  }

  // ── Background cleanup ────────────────────────────────────────────────────
  // Scans every cache key, removes expired entries, fires debug hooks.
  // Returns array of removed key names (without prefix).
  function cleanupExpiredCache() {
    var removed = [];
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(CACHE_PREFIX) !== 0) continue;
        var stripped = k.slice(CACHE_PREFIX.length);
        if (stripped === 'app_version') continue;
        keys.push(stripped);
      }
      keys.forEach(function (stripped) {
        var entry = getCache(stripped);
        if (!entry) return;
        var ttl = entry.ttl;
        if (!ttl) return; // no TTL = no expiry enforced
        if (!isFresh(entry, ttl)) {
          var age = Date.now() - (entry.createdAt || entry.ts);
          _hook('CACHE_EXPIRED', { key: stripped, age: age, ttlMs: ttl, reason: 'cleanup-worker' });
          deleteCache(stripped);
          _hook('CACHE_REMOVED', { key: stripped, reason: 'cleanup-expired' });
          removed.push(stripped);
        }
      });
    } catch (e) {}
    _hook('CACHE_CLEANUP', { removed: removed.length, keys: removed, ts: Date.now() });
    return removed;
  }

  // Start the singleton background cleanup worker.
  // Safe to call multiple times — second+ calls are no-ops.
  function startCleanupWorker() {
    if (_cleanupTimer !== null) return; // already running
    // Run once immediately on startup to clear stale entries from last session.
    try { cleanupExpiredCache(); } catch (e) {}
    _cleanupTimer = setInterval(function () {
      try { cleanupExpiredCache(); } catch (e) {}
    }, CLEANUP_INTERVAL_MS);
  }

  // ── In-flight request de-duplication ─────────────────────────────────────
  var _inflight = {};
  function dedupe(key, fn) {
    if (_inflight[key]) {
      _hook('REQUEST_DEDUPLICATED', { key: key });
      return _inflight[key];
    }
    var p = Promise.resolve().then(fn).then(
      function (result) { delete _inflight[key]; return result; },
      function (err)    { delete _inflight[key]; throw err; }
    );
    _inflight[key] = p;
    return p;
  }

  function getInflightKeys() { return Object.keys(_inflight); }

  // ── Cached fetch with strict expiry ──────────────────────────────────────
  // key:      unique cache key (without prefix)
  // ttlMs:    freshness window in ms (use TTL_6H, TTL_3H, or TTL_24H constants)
  // fetchFn:  () => Promise<data> — the real Supabase call
  // opts.bypass: skip/clear existing cache entirely (pull-to-refresh)
  // opts.onBackgroundUpdate: called with fresh data once a refresh completes
  //
  // Every read validates expiry first. An expired entry is deleted immediately
  // (never silently reused) and a fresh Supabase request is made synchronously
  // to rebuild the cache. This guarantees expired data is never served.
  async function cachedFetch(key, ttlMs, fetchFn, opts) {
    opts = opts || {};
    ensureVersion();

    if (opts.bypass) {
      // Pull-to-refresh / explicit refresh — ignore and clear any existing
      // cache entry (valid or expired) before forcing a fresh request.
      var existingBypass = getCache(key);
      if (existingBypass) {
        deleteCache(key);
        _hook('CACHE_DELETED', { key: key, reason: 'bypass' });
      }
      _hook('CACHE_MISS', { key: key, loadedFrom: 'supabase', reason: 'bypass' });
      var fresh = await dedupe(key, fetchFn);
      setCache(key, fresh, ttlMs);
      _hook('CACHE_CREATED', { key: key, reason: 'bypass' });
      _hook('CACHE_UPDATED',  { key: key, reason: 'bypass' });
      return fresh;
    }

    var entry = getCache(key);

    if (isFresh(entry, ttlMs)) {
      _hook('CACHE_HIT', { key: key, loadedFrom: 'cache', age: Date.now() - (entry.createdAt || entry.ts), ttlMs: ttlMs });
      return entry.data;
    }

    if (entry) {
      // Expired: delete immediately, never serve stale data.
      var expiredAge = Date.now() - (entry.createdAt || entry.ts);
      _hook('CACHE_EXPIRED', { key: key, age: expiredAge, ttlMs: ttlMs });
      deleteCache(key);
      _hook('CACHE_DELETED', { key: key, reason: 'expired' });
    }

    // No valid cache — must fetch fresh from Supabase.
    _hook('CACHE_MISS', { key: key, loadedFrom: 'supabase', reason: entry ? 'expired' : 'no-entry' });
    var data = await dedupe(key, fetchFn);
    setCache(key, data, ttlMs);
    _hook('CACHE_CREATED', { key: key, reason: entry ? 'expired-refresh' : 'created' });
    _hook('CACHE_UPDATED',  { key: key, reason: entry ? 'expired-refresh' : 'created' });
    if (opts.onBackgroundUpdate) {
      try { opts.onBackgroundUpdate(data); } catch (e) {}
    }
    return data;
  }

  // ── Pull-to-refresh gesture (touch only, no visual redesign) ─────────────
  function attachPullToRefresh(container, onRefresh) {
    if (!container || container._ptrAttached) return;
    container._ptrAttached = true;

    var indicator = document.createElement('div');
    indicator.className = 'ptr-indicator';
    indicator.textContent = '↓ Pull to refresh';
    indicator.style.cssText =
      'position:relative;text-align:center;font-size:12px;color:var(--text-secondary,#888);' +
      'height:0;overflow:hidden;transition:height .15s ease;opacity:0.85;';
    container.insertBefore(indicator, container.firstChild);

    var startY = 0, pulling = false, refreshing = false;

    container.addEventListener('touchstart', function (e) {
      if (container.scrollTop <= 0 && !refreshing) {
        startY  = e.touches[0].clientY;
        pulling = true;
      } else {
        pulling = false;
      }
    }, { passive: true });

    container.addEventListener('touchmove', function (e) {
      if (!pulling || refreshing) return;
      var dy = e.touches[0].clientY - startY;
      if (dy > 0 && container.scrollTop <= 0) {
        var h = Math.min(dy / 2, 56);
        indicator.style.height   = h + 'px';
        indicator.textContent    = h > 40 ? '↑ Release to refresh' : '↓ Pull to refresh';
      }
    }, { passive: true });

    container.addEventListener('touchend', function () {
      if (!pulling || refreshing) return;
      pulling    = false;
      var h      = parseInt(indicator.style.height, 10) || 0;
      if (h > 40) {
        refreshing              = true;
        indicator.textContent   = 'Refreshing…';
        _hook('PULL_TO_REFRESH', { phase: 'start' });
        Promise.resolve(onRefresh()).then(function () {
          _hook('PULL_TO_REFRESH', { phase: 'success' });
        }).catch(function () {
          _hook('PULL_TO_REFRESH', { phase: 'fail' });
        }).then(function () {
          indicator.style.height = '0px';
          refreshing             = false;
        });
      } else {
        indicator.style.height = '0px';
      }
    }, { passive: true });
  }

  // ── Public API ────────────────────────────────────────────────────────────
  global.AppCache = {
    // TTL constants
    TTL_6H:  TTL_6H,
    TTL_3H:  TTL_3H,
    TTL_24H: TTL_24H,

    // Core storage (both named and legacy aliases)
    getCache:     getCache,
    setCache:     setCache,
    deleteCache:  deleteCache,
    get:          getCache,   // legacy alias
    set:          setCache,   // legacy alias
    invalidate:   deleteCache, // legacy alias

    // Helpers
    getMeta:              getMeta,
    invalidatePrefix:     invalidatePrefix,
    updateCached:         updateCached,
    clearAll:             clearAllCache,
    isFresh:              isFresh,

    // Fetch layer
    cachedFetch:          cachedFetch,
    dedupe:               dedupe,
    getInflightKeys:      getInflightKeys,

    // Cleanup
    cleanupExpiredCache:  cleanupExpiredCache,

    // Version
    ensureVersion:        ensureVersion,
    getAppVersion:        getAppVersion,

    // Pull-to-refresh
    attachPullToRefresh:  attachPullToRefresh,

    // Internals exposed for debug panel
    CACHE_PREFIX:         CACHE_PREFIX
  };

  // Run once on load so a version bump clears cache before anything reads it.
  ensureVersion();

  // Start the background cleanup worker (singleton, every 5 minutes).
  startCleanupWorker();
})(window);
