// ── Developer Debug Panel ───────────────────────────────────────────────────
// Set DEBUG_PANEL = true to show the panel and start collecting metrics.
// Set DEBUG_PANEL = false (default) to disable it completely:
//   - no DOM is created, no event listeners are attached, no hooks are
//     registered, and every instrumentation call-site in cache.js/db.js/
//     app.js/home.js/notifications.js short-circuits on a single `if` check.
// This file is monitoring-only. It never changes what data is fetched, when
// it is fetched, or how the app behaves — it only observes and displays.
// ─────────────────────────────────────────────────────────────────────────────

const DEBUG_PANEL = true;

(function () {
  'use strict';
  if (!DEBUG_PANEL) return; // Panel fully disabled — zero DOM, zero listeners, zero cost.

  // ── Internal state ─────────────────────────────────────────────────────────
  var state = {
    caches: {},               // key -> { key, status, loadedFrom, createdAt, lastRefresh }
    requestCounters: { total: 0, stories: 0, episodes: 0, notifications: 0, comments: 0, likes: 0, views: 0, other: 0 },
    requestLog: [],           // { category, startedAt, finishedAt, duration, ok }
    activeRequests: {},       // category -> count
    dedupCount: 0,
    // ── Main Supabase real-time request monitor (read-only — see FETCH INSTRUMENTATION below) ──
    sbRequests: [],           // rolling log of every Main Supabase request: { time, feature, table, method, url, status, duration, size, uploadSize, egress, success, error }
    sbTotals: { count: 0, download: 0, upload: 0, egress: 0, durationSum: 0, failed: 0 },
    featureUsage: {},         // feature label -> { requests, download }
    backgroundRefresh: { status: 'idle', last: null, next: null, success: 0, failed: 0 },
    cleanupWorker: { lastRun: null, lastRemoved: 0, totalRemoved: 0, runCount: 0 },
    pullToRefresh: { enabled: true, last: null, cacheCleared: false, freshData: false },
    version: { current: null, cacheVersion: null, previous: null, clearedAfterChange: false },
    episodeDebug: { storyId: null, episodeCount: 0, cached: false, loadedFrom: null, firstLoad: null, lastLoad: null },
    episodeDb:    { dbs: {}, activeDbIndex: null, activeDbName: null, routedAt: null },
    perf: {},                 // label -> { startedAt, lastDuration }
    log: []                   // rolling event log, capped at 400
  };

  // TTL constants — match what cache.js and db.js actually use.
  // Do not read AppCache.TTL_* before DOMContentLoaded: cache.js may not yet be parsed.
  // Instead resolve lazily inside helpers where AppCache is guaranteed available.
  var _TTL_6H  = 6  * 60 * 60 * 1000;
  var _TTL_3H  = 3  * 60 * 60 * 1000;
  var _TTL_24H = 24 * 60 * 60 * 1000;

  // CACHE_KEY_DEFS drives the Cache section of the panel.
  //   prefixes:     localStorage key prefixes to scan (without 'efm_cache_').
  //   ttl:          expected TTL — must match what db.js passes to cachedFetch().
  //   implemented:  false → show "NOT IMPLEMENTED" instead of "EMPTY".
  var CACHE_KEY_DEFS = [
    { label: 'Home Stories',    prefixes: ['stories_'],                     ttl: _TTL_6H,  implemented: true  },
    { label: 'Slider',          prefixes: ['slides_'],                      ttl: _TTL_6H,  implemented: true  },
    { label: 'Trending',        prefixes: ['trending_'],                    ttl: _TTL_6H,  implemented: true  },
    { label: 'Story Position',  prefixes: ['stories_'],                     ttl: _TTL_6H,  implemented: true  },
    { label: 'Episode Batches', prefixes: ['ep_'],                          ttl: _TTL_6H,  implemented: true  },
    { label: 'Episode Count',   prefixes: ['epcount_'],                     ttl: _TTL_6H,  implemented: true  },
    { label: 'Notifications',   prefixes: ['notifications_list'],           ttl: _TTL_3H,  implemented: true  },
    { label: 'Comments',        prefixes: ['comments_'],                    ttl: _TTL_3H,  implemented: true  },
    { label: 'Likes',           prefixes: ['likestatus_', 'likescount_'],   ttl: _TTL_6H,  implemented: true  },
    { label: 'Views',           prefixes: ['views_'],                       ttl: _TTL_6H,  implemented: false }
  ];

  // Canonical feature list for the Main Supabase request monitor / Feature Usage summary.
  var FEATURE_ORDER = [
    'Home Stories', 'Story Detail', 'Episode List', 'Continue Watching',
    'Notifications', 'Search', 'Likes', 'Comments', 'Views',
    'Authentication', 'Profile', 'Library', 'Slider', 'Trending'
  ];
  FEATURE_ORDER.forEach(function (f) { state.featureUsage[f] = { requests: 0, download: 0 }; });

  function pushLog(type, payload) {
    state.log.unshift({ t: Date.now(), type: type, payload: payload });
    if (state.log.length > 400) state.log.length = 400;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString();
  }

  function fmtDur(ms) {
    if (ms === null || ms === undefined) return '—';
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  }

  function fmtBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }

  // ── Normalize internal hook status to user-facing display labels ──────────
  // Valid output statuses: CACHE HIT, CACHE MISS, FETCHING, REFRESHING,
  //   EMPTY, EXPIRED, NOT IMPLEMENTED, ERROR.
  // Unknown states are never surfaced — they fall through to EMPTY.
  function resolveDisplayStatus(rawStatus, meta, implemented) {
    if (implemented === false) return { label: 'NOT IMPLEMENTED', cls: '' };
    switch (rawStatus) {
      case 'HIT':       return { label: 'CACHE HIT',       cls: 'ok' };
      case 'MISS':      return { label: 'CACHE MISS',      cls: 'warn' };
      case 'EXPIRED':   return { label: 'EXPIRED',         cls: 'err' };
      case 'DELETED':   return { label: 'EMPTY',           cls: 'warn' };
      case 'FETCHING':  return { label: 'FETCHING',        cls: 'warn' };
      case 'REFRESHING':return { label: 'REFRESHING',      cls: 'warn' };
      case 'ERROR':     return { label: 'ERROR',           cls: 'err' };
    }
    // No hook event recorded — derive from live localStorage meta.
    if (meta) {
      if (meta.fresh === true)  return { label: 'CACHE HIT',  cls: 'ok' };
      if (meta.fresh === false) return { label: 'EXPIRED',    cls: 'err' };
    }
    return { label: 'EMPTY', cls: 'warn' };
  }

  // ── Main Supabase real-time request monitor ────────────────────────────────
  // Purely observational: wraps window.fetch to watch requests that were
  // ALREADY going to be made by db.js/auth.js/app.js/tokens.js (both the raw
  // sbFetch() calls and the supabase-js client, which uses window.fetch under
  // the hood). It never issues a request of its own, never delays or alters
  // the response returned to the real caller, and only inspects traffic aimed
  // at the Main Supabase project. Episode Supabase 1/2 traffic is explicitly
  // excluded here — that traffic keeps flowing through the existing
  // EPISODE_DB_* hooks in EpisodeDB / episode-supabases.js, untouched.

  function _mainSupabaseBase() {
    var url = window.__SUPABASE_URL__ || '';
    return url.replace(/\/$/, '');
  }

  function _episodeSupabaseBases() {
    var list = window.__EPISODE_SUPABASES__ || [];
    return list.map(function (db) { return (db.url || '').replace(/\/$/, ''); });
  }

  function isMainSupabaseUrl(urlStr) {
    var base = _mainSupabaseBase();
    if (!base || !urlStr || urlStr.indexOf(base) !== 0) return false;
    // Guard against the (unlikely) case of Main/Episode Supabases sharing a host.
    var episodeBases = _episodeSupabaseBases();
    for (var i = 0; i < episodeBases.length; i++) {
      if (episodeBases[i] && urlStr.indexOf(episodeBases[i]) === 0) return false;
    }
    return true;
  }

  // Map a Main Supabase request URL + HTTP verb to a display Feature Name,
  // Table Name, and normalized Method (SELECT / INSERT / UPDATE / DELETE / RPC).
  function classifyMainRequest(urlStr, httpVerb) {
    var path = urlStr, search = '';
    try {
      var u = new URL(urlStr, window.location.origin);
      path = u.pathname;
      search = u.search || '';
    } catch (e) {}

    if (path.indexOf('/auth/v1/') !== -1) {
      return { feature: 'Authentication', table: 'auth', method: 'RPC' };
    }

    if (path.indexOf('/rest/v1/rpc/') !== -1) {
      var fn = path.split('/rest/v1/rpc/')[1] || 'unknown';
      var feature = 'Other';
      if (fn.indexOf('view') !== -1) feature = 'Views';
      else if (fn.indexOf('like') !== -1) feature = 'Likes';
      return { feature: feature, table: fn, method: 'RPC' };
    }

    var m = path.match(/\/rest\/v1\/([^\/?]+)/);
    var table = m ? m[1] : 'unknown';
    var method;
    switch ((httpVerb || 'GET').toUpperCase()) {
      case 'GET':    method = 'SELECT'; break;
      case 'POST':   method = 'INSERT'; break;
      case 'PATCH':  method = 'UPDATE'; break;
      case 'PUT':    method = 'UPDATE'; break;
      case 'DELETE': method = 'DELETE'; break;
      default:       method = 'SELECT';
    }

    var featureByTable = {
      stories: null, // resolved below (Home Stories / Trending / Story Detail)
      slides: 'Slider',
      notifications: 'Notifications',
      comments: 'Comments',
      likes: 'Likes',
      library: 'Library',
      continue_watching: 'Continue Watching',
      users: 'Profile',
      episodes: 'Episode List'
    };

    var resolvedFeature;
    if (table === 'stories') {
      if (search.indexOf('order=views_count') !== -1) resolvedFeature = 'Trending';
      else if (search.indexOf('id=eq.') !== -1 && search.indexOf('limit=1') !== -1) resolvedFeature = 'Story Detail';
      else resolvedFeature = 'Home Stories';
    } else {
      resolvedFeature = featureByTable[table] || 'Other';
    }

    return { feature: resolvedFeature, table: table, method: method };
  }

  function _byteLength(str) {
    try { return new Blob([str]).size; }
    catch (e) { return str ? String(str).length : 0; }
  }

  // Records one completed (or failed) Main Supabase request into state.
  // `res` is the (already-forwarded) Response, or null on network failure.
  function recordMainSupabaseRequest(urlStr, httpVerb, res, startedAt, uploadSize, err) {
    var finishedAt = Date.now();
    var duration   = finishedAt - startedAt;
    var info       = classifyMainRequest(urlStr, httpVerb);
    var success    = !!(res && res.ok);

    var entry = {
      time: finishedAt, feature: info.feature, table: info.table, method: info.method,
      url: urlStr, status: res ? res.status : 0, duration: duration,
      size: 0, uploadSize: uploadSize || 0, egress: uploadSize || 0,
      success: success, error: err ? (err.message || String(err)) : (res ? null : 'Network error')
    };

    state.sbRequests.unshift(entry);
    if (state.sbRequests.length > 300) state.sbRequests.length = 300;

    state.sbTotals.count++;
    state.sbTotals.upload      += entry.uploadSize;
    state.sbTotals.egress      += entry.uploadSize;
    state.sbTotals.durationSum += duration;
    if (!success) state.sbTotals.failed++;

    if (!state.featureUsage[info.feature]) state.featureUsage[info.feature] = { requests: 0, download: 0 };
    state.featureUsage[info.feature].requests++;

    pushLog('SUPABASE_API_REQUEST', { key: info.feature + ' — ' + info.table });

    if (res) {
      // Read the already-received body from a CLONE — never touches the
      // Response object the real caller (db.js / supabase-js) will consume.
      try {
        res.clone().arrayBuffer().then(function (buf) {
          var bytes = buf.byteLength;
          entry.size    = bytes;
          entry.egress += bytes;
          state.sbTotals.download += bytes;
          state.sbTotals.egress   += bytes;
          state.featureUsage[info.feature].download += bytes;
          if (panelVisible) scheduleRender();
        }).catch(function () {});
      } catch (e) {}
    }

    if (panelVisible) scheduleRender();
  }

  // Wrap window.fetch exactly once. Pass-through for everything except Main
  // Supabase requests; never changes arguments, timing, or the resolved value.
  (function instrumentFetch() {
    if (typeof window.fetch !== 'function' || window.fetch.__efmWrapped) return;
    var origFetch = window.fetch.bind(window);
    var wrapped = function (input, init) {
      var urlStr = typeof input === 'string' ? input : (input && input.url) || '';
      if (!isMainSupabaseUrl(urlStr)) return origFetch(input, init);

      var method     = (init && init.method) || (input && input.method) || 'GET';
      var uploadSize = (init && init.body) ? _byteLength(init.body) : 0;
      var startedAt  = Date.now();

      return origFetch(input, init).then(function (res) {
        recordMainSupabaseRequest(urlStr, method, res, startedAt, uploadSize);
        return res;
      }, function (err) {
        recordMainSupabaseRequest(urlStr, method, null, startedAt, uploadSize, err);
        throw err;
      });
    };
    wrapped.__efmWrapped = true;
    window.fetch = wrapped;
  })();

  // ── The global hook consumed by cache.js / db.js / app.js / home.js / notifications.js ──
  window.__debugHook = function (type, payload) {
    payload = payload || {};
    pushLog(type, payload);

    switch (type) {
      case 'CACHE_HIT':
        state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
          key: payload.key, status: 'HIT', loadedFrom: payload.loadedFrom,
          lastRefresh: (state.caches[payload.key] && state.caches[payload.key].lastRefresh) || null
        });
        break;

      case 'CACHE_MISS':
        state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
          key: payload.key, status: 'MISS', loadedFrom: payload.loadedFrom
        });
        break;

      case 'CACHE_EXPIRED':
        // Only record in state when this comes from a cachedFetch() read.
        // The cleanup worker fires its own CACHE_EXPIRED but immediately follows
        // with CACHE_REMOVED which wipes the key from state entirely.
        if (!payload.reason || payload.reason !== 'cleanup-worker') {
          state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
            key: payload.key, status: 'EXPIRED', expiredAt: Date.now(), lastAge: payload.age
          });
        }
        break;

      case 'CACHE_DELETED':
        // Deleted from cachedFetch() path (bypass or expired-on-read).
        // Status will be overwritten by CACHE_MISS → CACHE_CREATED very shortly.
        state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
          key: payload.key, status: 'DELETED', deletedAt: Date.now(), deleteReason: payload.reason
        });
        break;

      case 'CACHE_REMOVED':
        // Physically removed by the cleanup worker — wipe from in-memory state
        // so the panel stops tracking it. It is also gone from localStorage.
        delete state.caches[payload.key];
        break;

      case 'CACHE_CREATED':
        state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
          key: payload.key, status: 'HIT', loadedFrom: 'supabase',
          createdAt: Date.now(), lastRefresh: Date.now()
        });
        break;

      case 'CACHE_UPDATED':
        state.caches[payload.key] = Object.assign(state.caches[payload.key] || {}, {
          key: payload.key, lastRefresh: Date.now()
        });
        break;

      case 'CACHE_CLEARED':
        state.caches = {};
        state.pullToRefresh.cacheCleared = true;
        break;

      case 'CACHE_CLEANUP':
        state.cleanupWorker.lastRun     = payload.ts || Date.now();
        state.cleanupWorker.lastRemoved = payload.removed || 0;
        state.cleanupWorker.totalRemoved = (state.cleanupWorker.totalRemoved || 0) + (payload.removed || 0);
        state.cleanupWorker.runCount    = (state.cleanupWorker.runCount || 0) + 1;
        break;

      case 'VERSION_CHANGED':
        state.version.previous          = payload.previous;
        state.version.current           = payload.current;
        state.version.clearedAfterChange = true;
        break;

      case 'REQUEST_STARTED':
        state.activeRequests[payload.category] = (state.activeRequests[payload.category] || 0) + 1;
        break;

      case 'REQUEST_FINISHED':
        if (state.activeRequests[payload.category]) state.activeRequests[payload.category]--;
        break;

      case 'REQUEST_DEDUPLICATED':
        state.dedupCount++;
        break;

      case 'SUPABASE_REQUEST':
        state.requestCounters.total++;
        state.requestCounters[payload.category] = (state.requestCounters[payload.category] || 0) + 1;
        state.requestLog.unshift(payload);
        if (state.requestLog.length > 200) state.requestLog.length = 200;
        break;

      case 'BACKGROUND_REFRESH_STARTED':
        state.backgroundRefresh.status = 'running';
        state.backgroundRefresh.last   = Date.now();
        break;

      case 'BACKGROUND_REFRESH_COMPLETED':
        state.backgroundRefresh.status = 'idle';
        state.backgroundRefresh.next   = Date.now() + _TTL_6H;
        if (payload.success) state.backgroundRefresh.success++; else state.backgroundRefresh.failed++;
        break;

      case 'PULL_TO_REFRESH':
        if (payload.phase === 'start') {
          state.pullToRefresh.cacheCleared = false;
          state.pullToRefresh.freshData    = false;
        } else if (payload.phase === 'success') {
          state.pullToRefresh.last      = Date.now();
          state.pullToRefresh.freshData = true;
        }
        break;

      case 'EPISODE_DEBUG':
        state.episodeDebug.storyId      = payload.storyId;
        state.episodeDebug.episodeCount = payload.episodeCount;
        state.episodeDebug.cached       = !!(state.caches['episodes_full_' + payload.storyId] || state.caches['epcount_' + payload.storyId]);
        state.episodeDebug.loadedFrom   = state.episodeDebug.cached ? 'cache' : 'supabase';
        if (!state.episodeDebug.firstLoad) state.episodeDebug.firstLoad = Date.now();
        state.episodeDebug.lastLoad     = Date.now();
        break;

      case 'EPISODE_DB_ROUTED':
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        state.episodeDb.dbs[payload.index].routerDecision = payload.decision;
        state.episodeDb.dbs[payload.index].active         = true;
        break;

      case 'EPISODE_DB_REQUEST': {
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        var _ds = state.episodeDb.dbs[payload.index];
        _ds.requests     = (_ds.requests || 0) + 1;
        _ds.lastDuration = payload.duration;
        if (!payload.ok) _ds.failed = (_ds.failed || 0) + 1;
        _ds.active       = false;
        break;
      }

      case 'EPISODE_DB_HIT':
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        Object.assign(state.episodeDb.dbs[payload.index], { ok: true, empty: false, lastSuccessAt: Date.now(), lastCheck: Date.now() });
        state.episodeDb.activeDbIndex = payload.index;
        state.episodeDb.activeDbName  = payload.name;
        state.episodeDb.routedAt      = Date.now();
        break;

      case 'EPISODE_DB_FAIL':
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        Object.assign(state.episodeDb.dbs[payload.index], {
          ok: false, lastCheck: Date.now(),
          error: payload.error || ('HTTP ' + (payload.status || '?'))
        });
        break;

      case 'EPISODE_DB_EMPTY':
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        Object.assign(state.episodeDb.dbs[payload.index], { ok: true, empty: true, lastCheck: Date.now() });
        break;

      case 'EPISODE_DB_RETRY':
        if (!state.episodeDb.dbs[payload.index]) state.episodeDb.dbs[payload.index] = {};
        state.episodeDb.dbs[payload.index].retried = true;
        break;

      case 'EPISODE_DB_UNAVAILABLE':
        break;

      case 'EPISODE_DB_FALLBACK':
        break;

      case 'PERF_START':
        state.perf[payload.label]           = state.perf[payload.label] || {};
        state.perf[payload.label].startedAt = Date.now();
        break;

      case 'PERF_END':
        if (state.perf[payload.label] && state.perf[payload.label].startedAt) {
          state.perf[payload.label].lastDuration = Date.now() - state.perf[payload.label].startedAt;
        }
        break;
    }

    if (panelVisible) scheduleRender();
  };

  // ── Build CSS ─────────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#efm-dbg { position: fixed; top: 60px; right: 12px; width: 380px; max-height: 82vh; z-index: 2147483647;',
    '  background: rgba(12,12,20,0.97); color: #e6e6e6; font-family: monospace; font-size: 11px;',
    '  border: 1px solid #3a3a55; border-radius: 10px; box-shadow: 0 6px 30px rgba(0,0,0,0.6);',
    '  display: flex; flex-direction: column; resize: both; overflow: hidden; min-width: 280px; min-height: 120px; }',
    '#efm-dbg-hdr { cursor: move; user-select: none; display:flex; align-items:center; justify-content:space-between;',
    '  padding: 8px 10px; background: #181828; border-radius: 10px 10px 0 0; font-weight: bold; letter-spacing:.4px; }',
    '#efm-dbg-hdr .efm-dbg-title { color: #a78bfa; }',
    '#efm-dbg-hdr .efm-dbg-btns button { background:transparent;border:none;color:#aaa;font-size:14px;cursor:pointer;padding:0 4px; }',
    '#efm-dbg-body { padding: 8px 10px; overflow-y: auto; flex: 1; }',
    '#efm-dbg.collapsed #efm-dbg-body { display:none; }',
    '#efm-dbg .efm-sec { margin-top: 10px; font-size: 10px; color:#a78bfa; text-transform: uppercase; letter-spacing:.5px; border-top:1px solid #2a2a3d; padding-top:6px; cursor:pointer; }',
    '#efm-dbg .efm-sec:first-child { border-top:none; margin-top:0; padding-top:0; }',
    '#efm-dbg .efm-sec-body { display:block; }',
    '#efm-dbg .efm-sec-body.collapsed { display:none; }',
    '#efm-dbg .efm-row { display:flex; justify-content:space-between; padding: 2px 0; border-bottom: 1px solid #1e1e2e; gap: 8px; }',
    '#efm-dbg .efm-label { color:#888; white-space:nowrap; }',
    '#efm-dbg .efm-val { color:#fff; text-align:right; word-break:break-all; }',
    '#efm-dbg .efm-val.ok { color:#4ade80; } #efm-dbg .efm-val.warn { color:#facc15; } #efm-dbg .efm-val.err { color:#f87171; }',
    '#efm-dbg .efm-cache-block { background:#151522; border-radius:6px; padding:5px 7px; margin: 4px 0; }',
    '#efm-dbg .efm-cache-block .efm-cache-title { color:#60a5fa; font-weight:bold; margin-bottom:2px; }',
    '#efm-dbg button.efm-btn { width:100%; margin-top:4px; padding:6px 0; background:#4c1d95; color:#fff; border:none;',
    '  border-radius:5px; font-size:10.5px; font-weight:bold; cursor:pointer; letter-spacing:.3px; }',
    '#efm-dbg button.efm-btn:active { background:#312066; }',
    '#efm-dbg .efm-btn-grid { display:grid; grid-template-columns: 1fr 1fr; gap:4px; }',
    '#efm-dbg pre.efm-log { white-space:pre-wrap; word-break:break-all; background:#0a0a12; border-radius:4px;',
    '  padding:5px 6px; max-height:140px; overflow-y:auto; font-size:9.5px; color:#c9c9d9; margin:4px 0 0; }',
    '@media (max-width: 600px) { #efm-dbg { left: 4px; right: 4px; width: auto; top: 6px; max-height: 90vh; } }'
  ].join('\n');
  document.head.appendChild(style);

  // ── Build panel skeleton ──────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.id = 'efm-dbg';
  panel.innerHTML =
    '<div id="efm-dbg-hdr">' +
      '<span class="efm-dbg-title">🛠 Debug Panel</span>' +
      '<span class="efm-dbg-btns">' +
        '<button id="efm-dbg-collapse" title="Collapse">▾</button>' +
      '</span>' +
    '</div>' +
    '<div id="efm-dbg-body"></div>';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(panel); attachInteractions(); render(); });
  // In case DOMContentLoaded already fired (script loaded late)
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    document.body
      ? (document.body.appendChild(panel), attachInteractions(), render())
      : document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(panel); attachInteractions(); render(); });
  }

  var panelVisible = true;

  // ── Drag ──────────────────────────────────────────────────────────────────
  function attachInteractions() {
    var hdr         = document.getElementById('efm-dbg-hdr');
    var collapseBtn = document.getElementById('efm-dbg-collapse');
    var dragging    = false, offX = 0, offY = 0;

    hdr.addEventListener('mousedown', function (e) {
      if (e.target === collapseBtn) return;
      dragging = true;
      var rect = panel.getBoundingClientRect();
      offX = e.clientX - rect.left;
      offY = e.clientY - rect.top;
      panel.style.right = 'auto';
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panel.style.left = (e.clientX - offX) + 'px';
      panel.style.top  = (e.clientY - offY) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });

    hdr.addEventListener('touchstart', function (e) {
      if (e.target === collapseBtn) return;
      var t    = e.touches[0];
      var rect = panel.getBoundingClientRect();
      offX     = t.clientX - rect.left;
      offY     = t.clientY - rect.top;
      panel.style.right = 'auto';
      dragging = true;
    }, { passive: true });
    hdr.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = e.touches[0];
      panel.style.left = (t.clientX - offX) + 'px';
      panel.style.top  = (t.clientY - offY) + 'px';
    }, { passive: true });
    hdr.addEventListener('touchend', function () { dragging = false; }, { passive: true });

    collapseBtn.addEventListener('click', function () {
      panel.classList.toggle('collapsed');
      collapseBtn.textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
      panelVisible = !panel.classList.contains('collapsed');
      if (panelVisible) render();
    });
  }

  // ── Debug actions (call only real, existing public APIs) ──────────────────
  function refreshLive(fetcher) {
    try { Promise.resolve(fetcher()).catch(function () {}); } catch (e) {}
  }

  var actions = {
    clearAllCache: function () {
      if (window.AppCache) AppCache.clearAll();
    },
    refreshHome: function () {
      if (window.AppCache) AppCache.invalidatePrefix('stories_');
      if (typeof loadCategoryStories === 'function') {
        refreshLive(function () {
          return loadCategoryStories(typeof currentCategory !== 'undefined' ? currentCategory : 'all', { bypass: true });
        });
      }
    },
    refreshEpisodes: function () {
      if (window.AppCache) {
        AppCache.invalidatePrefix('episodes_full_');
        AppCache.invalidatePrefix('ep_');
        AppCache.invalidatePrefix('epcount_');
      }
    },
    refreshNotifications: function () {
      if (window.AppCache) AppCache.deleteCache('notifications_list');
      if (typeof loadNotifications === 'function') refreshLive(function () { return loadNotifications({ bypass: true }); });
    },
    refreshComments: function () {
      if (window.AppCache) AppCache.invalidatePrefix('comments_');
      if (typeof currentDetailStory !== 'undefined' && currentDetailStory && typeof loadComments === 'function') {
        refreshLive(function () { return loadComments(currentDetailStory.id, { bypass: true }); });
      }
    },
    refreshLikes: function () {
      if (window.AppCache) {
        AppCache.invalidatePrefix('likescount_');
        AppCache.invalidatePrefix('likestatus_');
      }
    },
    refreshTrending: function () {
      if (window.AppCache) AppCache.invalidatePrefix('trending_');
      if (typeof renderTrending === 'function') refreshLive(function () { return renderTrending({ bypass: true }); });
    },
    refreshSlider: function () {
      if (window.AppCache) AppCache.invalidatePrefix('slides_');
      if (typeof initSlider === 'function') refreshLive(function () { return initSlider({ bypass: true }); });
    },
    refreshStoryPosition: function () {
      if (window.AppCache) AppCache.invalidatePrefix('stories_');
    },
    runCleanupNow: function () {
      if (window.AppCache) AppCache.cleanupExpiredCache();
    },
    forceBackgroundRefresh: function () {
      if (!window.AppCache) return;
      window.__debugHook('BACKGROUND_REFRESH_STARTED', {});
      var keys = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(AppCache.CACHE_PREFIX) === 0) keys.push(k.slice(AppCache.CACHE_PREFIX.length));
        }
      } catch (e) {}
      keys.forEach(function (k) {
        if (k === 'app_version') return;
        var entry = AppCache.getCache(k);
        if (entry) AppCache.setCache(k, entry.data, 1); // ttl 1ms => immediately stale
      });
      window.__debugHook('BACKGROUND_REFRESH_COMPLETED', { success: true });
    },
    simulateVersionChange: function () {
      try { localStorage.setItem('efm_cache_app_version', 'debug-sim-' + Date.now()); } catch (e) {}
      if (window.AppCache) AppCache.ensureVersion();
    },
    exportLog: function () {
      var blob = new Blob([JSON.stringify({ state: state, log: state.log }, null, 2)], { type: 'application/json' });
      var a    = document.createElement('a');
      a.href   = URL.createObjectURL(blob);
      a.download = 'efm-debug-log-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    },
    copyReport: function () {
      var text = buildReportText();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
      }
    }
  };

  function buildReportText() {
    var lines = [];
    lines.push('EMPEROR FM — DEBUG REPORT — ' + new Date().toLocaleString());
    lines.push('Version: current=' + (state.version.current || (window.AppCache ? AppCache.getAppVersion() : '—')) + ' previous=' + (state.version.previous || '—'));
    lines.push('Total Supabase requests: ' + state.requestCounters.total);
    Object.keys(state.requestCounters).forEach(function (k) {
      if (k === 'total') return;
      lines.push('  ' + k + ': ' + state.requestCounters[k]);
    });
    lines.push('Duplicate requests prevented: ' + state.dedupCount);
    lines.push('Background refresh — success: ' + state.backgroundRefresh.success + ' failed: ' + state.backgroundRefresh.failed);
    lines.push('Cleanup worker runs: ' + state.cleanupWorker.runCount + ' total removed: ' + state.cleanupWorker.totalRemoved);
    lines.push('Cached keys tracked: ' + Object.keys(state.caches).length);
    return lines.join('\n');
  }

  // ── Read-only accessors into other modules (never mutate) ─────────────────
  function safeContinueWatching() {
    try {
      if (typeof getContinueWatching !== 'function') return [];
      return getContinueWatching();
    } catch (e) { return []; }
  }

  // Read-only snapshot of EpisodeDB config + stats — never mutates EpisodeDB.
  function safeEpisodeDbState() {
    try {
      if (typeof EpisodeDB === 'undefined') return { dbs: [], stats: {} };
      return {
        dbs:   typeof EpisodeDB.getDbs   === 'function' ? EpisodeDB.getDbs()   : [],
        stats: typeof EpisodeDB.getStats === 'function' ? EpisodeDB.getStats() : {}
      };
    } catch (e) {
      return { dbs: [], stats: {} };
    }
  }

  // Returns all VALID (non-expired) cache entries from localStorage.
  function localStorageCacheEntries() {
    var out = [];
    try {
      var prefix = window.AppCache ? AppCache.CACHE_PREFIX : 'efm_cache_';
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(prefix) !== 0) continue;
        var stripped = k.slice(prefix.length);
        var raw      = localStorage.getItem(k);
        var parsed   = null;
        try { parsed = JSON.parse(raw); } catch (e) {}
        // Skip expired entries — they will be removed by the cleanup worker
        // and should not appear in the Local Storage section.
        if (parsed && parsed.ttl && window.AppCache && !AppCache.isFresh(parsed, parsed.ttl)) continue;
        out.push({
          key:     stripped,
          size:    raw ? raw.length : 0,
          created: parsed ? (parsed.createdAt || parsed.ts) : null,
          ttl:     parsed ? parsed.ttl : null
        });
      }
    } catch (e) {}
    return out;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  var renderScheduled = false;
  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(function () { renderScheduled = false; render(); });
  }

  function row(label, val, cls) {
    return '<div class="efm-row"><span class="efm-label">' + label + '</span><span class="efm-val' + (cls ? ' ' + cls : '') + '">' + val + '</span></div>';
  }

  function section(title, bodyHtml) {
    var id = 'sec-' + title.replace(/\W+/g, '');
    return '<div class="efm-sec" data-target="' + id + '">' + title + '</div>' +
      '<div class="efm-sec-body" id="' + id + '">' + bodyHtml + '</div>';
  }

  // Discover every NON-EXPIRED localStorage key matching a given cache prefix.
  // This is the single source of truth for "does this cache exist", independent
  // of whether a hook event happened to fire this page session (e.g. data
  // cached on a previous page load).
  // Expired entries are excluded: the cleanup worker removes them from
  // localStorage within 5 minutes; the panel never displays them.
  function findCacheKeysByPrefix(prefix) {
    var out = [];
    try {
      var cachePrefix = window.AppCache ? AppCache.CACHE_PREFIX : 'efm_cache_';
      var fullPrefix  = cachePrefix + prefix;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(fullPrefix) !== 0) continue;
        var stripped = k.slice(cachePrefix.length);
        // Filter out expired entries — never display them.
        if (window.AppCache) {
          var entry = AppCache.getCache(stripped);
          if (entry && entry.ttl && !AppCache.isFresh(entry, entry.ttl)) continue;
        }
        out.push(stripped);
      }
    } catch (e) {}
    return out;
  }

  function cacheSectionFor(def) {
    var blocks = def.prefixes.map(function (prefix) {
      // Not-implemented features always show a single block regardless of data.
      if (def.implemented === false) {
        return '<div class="efm-cache-block">' +
          '<div class="efm-cache-title">' + prefix + '*</div>' +
          row('Status', 'NOT IMPLEMENTED', '') +
        '</div>';
      }

      var matches = findCacheKeysByPrefix(prefix);
      if (!matches.length) {
        return '<div class="efm-cache-block">' +
          '<div class="efm-cache-title">' + prefix + '*</div>' +
          row('Status', 'EMPTY', 'warn') +
        '</div>';
      }

      return matches.map(function (key) {
        var meta        = window.AppCache ? AppCache.getMeta(key, def.ttl) : null;
        var c           = state.caches[key] || {};
        var rawStatus   = c.status || null;
        var ds          = resolveDisplayStatus(rawStatus, meta, def.implemented);
        var loadedFrom  = c.loadedFrom || (meta ? 'cache' : '—');
        var lastRefresh = c.lastRefresh || (meta ? meta.createdAt : null);

        return '<div class="efm-cache-block">' +
          '<div class="efm-cache-title">' + key + '</div>' +
          row('Status',        ds.label,                                    ds.cls) +
          row('Loaded From',   loadedFrom) +
          row('Created',       meta ? fmtTime(meta.createdAt) : '—') +
          row('Age',           meta ? fmtDur(meta.age)        : '—') +
          row('Expiry',        meta && meta.expiresAt ? fmtTime(meta.expiresAt) : '—') +
          row('Time Remaining',meta && meta.remaining !== null ? fmtDur(meta.remaining) : '—') +
          row('Size',          meta ? fmtBytes(meta.sizeBytes) : '—') +
          row('Last Refresh',  lastRefresh ? fmtTime(lastRefresh) : '—') +
        '</div>';
      }).join('');
    }).join('');
    return blocks;
  }

  function render() {
    if (!panelVisible) return;
    var body = document.getElementById('efm-dbg-body');
    if (!body) return;

    var version       = window.AppCache ? AppCache.getAppVersion() : '—';
    var storedVersion = null;
    try { storedVersion = localStorage.getItem('efm_cache_app_version'); } catch (e) {}

    var cacheSectionsHtml = CACHE_KEY_DEFS.map(function (def) {
      return section(def.label, cacheSectionFor(def));
    }).join('');

    var reqRowsHtml =
      row('Total API Requests',          state.requestCounters.total) +
      row('Stories Requests',            state.requestCounters.stories       || 0) +
      row('Episodes Requests',           state.requestCounters.episodes      || 0) +
      row('Notifications Requests',      state.requestCounters.notifications || 0) +
      row('Comments Requests',           state.requestCounters.comments      || 0) +
      row('Likes Requests',              state.requestCounters.likes         || 0) +
      row('Views Requests',              state.requestCounters.views         || 0) +
      '<pre class="efm-log">' + state.requestLog.slice(0, 8).map(function (r) {
        return '[' + fmtTime(r.startedAt) + ' → ' + fmtTime(r.finishedAt) + '] ' + r.category + ' — ' + fmtDur(r.duration) + (r.ok ? ' OK' : ' FAIL');
      }).join('\n') + '</pre>';

    var activeReqCount = Object.keys(state.activeRequests).reduce(function (sum, k) { return sum + (state.activeRequests[k] || 0); }, 0);
    var dedupHtml =
      row('Duplicate Requests Prevented', state.dedupCount) +
      row('Current Active Requests',      activeReqCount) +
      row('In-flight Requests',           window.AppCache ? AppCache.getInflightKeys().length : 0);

    var bgHtml =
      row('Status',                  state.backgroundRefresh.status, state.backgroundRefresh.status === 'running' ? 'warn' : 'ok') +
      row('Last Background Refresh', fmtTime(state.backgroundRefresh.last)) +
      row('Next Background Refresh', fmtTime(state.backgroundRefresh.next)) +
      row('Success',                 state.backgroundRefresh.success, 'ok') +
      row('Failed',                  state.backgroundRefresh.failed, state.backgroundRefresh.failed ? 'err' : '');

    var cleanupHtml =
      row('Last Cleanup Run',            state.cleanupWorker.lastRun ? fmtTime(state.cleanupWorker.lastRun) : 'Never') +
      row('Entries Removed Last Run',    state.cleanupWorker.lastRemoved || 0, state.cleanupWorker.lastRemoved ? 'warn' : '') +
      row('Total Entries Removed',       state.cleanupWorker.totalRemoved || 0) +
      row('Total Cleanup Runs',          state.cleanupWorker.runCount || 0) +
      row('Interval',                    '5 minutes') +
      row('Cache TTL',                   '6 hours (default)');

    var ptrHtml =
      row('Enabled',             state.pullToRefresh.enabled ? 'Yes' : 'No', 'ok') +
      row('Last Refresh Time',   fmtTime(state.pullToRefresh.last)) +
      row('Cache Cleared',       state.pullToRefresh.cacheCleared ? 'Yes' : 'No') +
      row('Fresh Data Downloaded', state.pullToRefresh.freshData ? 'Yes' : 'No');

    var versionHtml =
      row('Current Website Version',           version) +
      row('Current Cache Version',             storedVersion || '—') +
      row('Previous Cache Version',            state.version.previous || '—') +
      row('Cache Cleared After Version Change', state.version.clearedAfterChange ? 'Yes' : 'No');

    // ── Supabase Connections ─────────────────────────────────────────────────
    var epDbSnap     = safeEpisodeDbState();
    var mainSbStatus = (typeof _sbUrl !== 'undefined' && _sbUrl) ? 'Connected' : 'Not configured';
    var sbConnHtml   =
      row('Main Supabase', mainSbStatus, mainSbStatus === 'Connected' ? 'ok' : 'err') +
      row('Main Supabase Role', 'Stories, Slides, Trending, Notifications, Comments, Likes, Auth') +
      row('Episodes on Main Supabase', 'Never — Episode Supabases only', 'ok');

    if (!epDbSnap.dbs.length) {
      sbConnHtml += row('Episode Supabases', 'None configured — episodes will fail', 'err');
    } else {
      epDbSnap.dbs.forEach(function (db) {
        var liveStat  = epDbSnap.stats[db.index]       || {};
        var hookStat  = state.episodeDb.dbs[db.index]  || {};
        var requests  = liveStat.requests  || hookStat.requests  || 0;
        var failed    = liveStat.failed    || hookStat.failed    || 0;
        var lastDur   = liveStat.lastDuration  != null ? liveStat.lastDuration  : hookStat.lastDuration;
        var lastOk    = liveStat.lastSuccessAt || hookStat.lastSuccessAt;
        var decision  = liveStat.routerDecision || hookStat.routerDecision || '—';
        var lastCheck = hookStat.lastCheck || null;
        var isOk      = hookStat.ok;
        var isEmpty   = hookStat.empty;
        var isActive  = hookStat.active;
        var errMsg    = hookStat.error;

        var status, cls;
        if (lastCheck == null && !lastOk) {
          status = 'Not yet queried'; cls = '';
        } else if (isOk === false) {
          status = 'Offline — ' + (errMsg || 'unknown error'); cls = 'err';
        } else if (isEmpty) {
          status = 'Online (no episodes for this story)'; cls = 'ok';
        } else if (isActive) {
          status = 'Active — request in flight'; cls = 'warn';
        } else {
          status = lastOk ? 'Online' : 'Not yet queried'; cls = lastOk ? 'ok' : '';
        }

        var range = 'Story ' + (db.storyStart != null ? Number(db.storyStart).toLocaleString() : '?') +
                    ' – ' + (db.storyEnd !== Infinity && db.storyEnd != null ? Number(db.storyEnd).toLocaleString() : '∞');

        sbConnHtml +=
          row('─ ' + db.name, status, cls) +
          row('  Story ID Range',     range) +
          row('  API Requests',       requests) +
          row('  Failed Requests',    failed, failed ? 'err' : '') +
          row('  Last Response Time', lastDur != null ? fmtDur(lastDur) : '—') +
          row('  Last Success',       lastOk ? fmtTime(lastOk) : '—', lastOk ? 'ok' : '') +
          row('  Router Decision',    decision);
      });

      var activeIdx  = state.episodeDb.activeDbIndex;
      var activeName = state.episodeDb.activeDbName;
      sbConnHtml += row('Current Active Supabase',
        activeName ? (activeName + (state.episodeDb.routedAt ? ' at ' + fmtTime(state.episodeDb.routedAt) : '')) : 'None yet',
        activeName ? 'ok' : '');
    }

    var epHtml =
      row('Current Story ID',    state.episodeDebug.storyId   || '—') +
      row('Current Episode Count', state.episodeDebug.episodeCount || 0) +
      row('Episodes Cached',     state.episodeDebug.cached ? 'Yes' : 'No') +
      row('Loaded From',         state.episodeDebug.loadedFrom || '—') +
      row('First Load',          fmtTime(state.episodeDebug.firstLoad)) +
      row('Last Load',           fmtTime(state.episodeDebug.lastLoad));

    var cw       = safeContinueWatching();
    var cwLatest = cw[0] || null;
    var cwHtml   =
      row('Current Story', cwLatest ? cwLatest.story_id    : '—') +
      row('Episode',       cwLatest ? cwLatest.episode_number : '—') +
      row('Position',      cwLatest ? Math.round(cwLatest.current_time) + 's' : '—') +
      row('Sync Status',   (typeof _sb !== 'undefined' && _sb) ? 'Supabase client active' : 'Local only') +
      row('Last Sync',     cwLatest ? fmtTime(cwLatest.updated_at) : '—');

    var notifCacheMeta = window.AppCache ? AppCache.getMeta('notifications_list', _TTL_3H) : null;
    var notifCount     = 0;
    if (notifCacheMeta) {
      try { var nEntry = AppCache.getCache('notifications_list'); notifCount = (nEntry && Array.isArray(nEntry.data)) ? nEntry.data.length : 0; } catch (e) {}
    }
    var notifStatus = notifCacheMeta ? (notifCacheMeta.fresh ? 'CACHE HIT' : 'EXPIRED') : 'EMPTY';
    var notifHtml   =
      row('Cache Status',      notifStatus, notifCacheMeta && notifCacheMeta.fresh ? 'ok' : 'warn') +
      row('Cache Age',         notifCacheMeta ? fmtDur(notifCacheMeta.age) : '—') +
      row('Notification Count', notifCount) +
      row('Loaded From',       state.caches['notifications_list'] ? (state.caches['notifications_list'].loadedFrom || '—') : '—');

    var commentKeys    = Object.keys(state.caches).filter(function (k) { return k.indexOf('comments_') === 0; });
    var lastCommentKey = commentKeys[commentKeys.length - 1];
    var commentMeta    = lastCommentKey && window.AppCache ? AppCache.getMeta(lastCommentKey, _TTL_3H) : null;
    var commentCount   = 0;
    if (lastCommentKey) { try { var cEntry = AppCache.getCache(lastCommentKey); commentCount = (cEntry && Array.isArray(cEntry.data)) ? cEntry.data.length : 0; } catch (e) {} }
    var commentStatus  = commentMeta ? (commentMeta.fresh ? 'CACHE HIT' : 'EXPIRED') : 'EMPTY';
    var commentsHtml   =
      row('Cache Status',  commentStatus, commentMeta && commentMeta.fresh ? 'ok' : 'warn') +
      row('Comment Count', commentCount) +
      row('Loaded From',   lastCommentKey && state.caches[lastCommentKey] ? (state.caches[lastCommentKey].loadedFrom || '—') : '—');

    var likeKeys    = Object.keys(state.caches).filter(function (k) { return k.indexOf('likescount_') === 0; });
    var lastLikeKey = likeKeys[likeKeys.length - 1];
    var likeVal     = null;
    if (lastLikeKey) { try { var lEntry = AppCache.getCache(lastLikeKey); likeVal = lEntry ? lEntry.data : null; } catch (e) {} }
    var likesHtml   =
      row('Likes Count', likeVal !== null && likeVal !== undefined ? JSON.stringify(likeVal) : '—') +
      row('Loaded From', lastLikeKey && state.caches[lastLikeKey] ? (state.caches[lastLikeKey].loadedFrom || '—') : '—') +
      row('Last Update', lastLikeKey && state.caches[lastLikeKey] ? fmtTime(state.caches[lastLikeKey].lastRefresh) : '—');

    var lsEntries = localStorageCacheEntries();
    var lsHtml    = '<pre class="efm-log">' + (lsEntries.length ? lsEntries.map(function (e) {
      return e.key + ' — ' + fmtBytes(e.size) + ' — created ' + fmtTime(e.created) + (e.ttl ? ' — expires ' + fmtTime((e.created || 0) + e.ttl) : '');
    }).join('\n') : 'No cache entries yet') + '</pre>';

    var perfHtml =
      row('Home Loading Time',         state.perf.home          ? fmtDur(state.perf.home.lastDuration)          : '—') +
      row('Story Opening Time',        state.perf.storyOpen     ? fmtDur(state.perf.storyOpen.lastDuration)     : '—') +
      row('Episode Loading Time',      state.perf.episode       ? fmtDur(state.perf.episode.lastDuration)       : '—') +
      row('Notification Loading Time', state.perf.notifications ? fmtDur(state.perf.notifications.lastDuration) : '—') +
      row('Comments Loading Time',     state.perf.comments      ? fmtDur(state.perf.comments.lastDuration)      : '—');

    // Statistics: only CACHE_HIT events count as hits. CACHE_EXPIRED events
    // are never counted as hits — they become CACHE_MISS + CACHE_CREATED.
    var totalCacheHits    = state.log.filter(function (l) { return l.type === 'CACHE_HIT'; }).length;
    var totalCacheMisses  = state.log.filter(function (l) { return l.type === 'CACHE_MISS'; }).length;
    var totalCacheLookups = totalCacheHits + totalCacheMisses;
    var hitRate           = totalCacheLookups ? Math.round((totalCacheHits / totalCacheLookups) * 100) : 0;
    var missRate          = 100 - hitRate;
    // Rough egress estimate: each avoided request assumed to save ~2KB average payload.
    var estEgressSavedKB  = totalCacheHits * 2;
    var networkHtml =
      row('Estimated Supabase Egress Saved', fmtBytes(estEgressSavedKB * 1024)) +
      row('Estimated API Calls Saved',       totalCacheHits) +
      row('Estimated Cache Hit Rate',        hitRate + '%', 'ok') +
      row('Estimated Cache Miss Rate',       missRate + '%', hitRate < 50 ? 'warn' : '');

    // ── Main Supabase — real-time request monitor (Totals / Live / Feature Usage) ──
    var avgResponseTime = state.sbTotals.count ? Math.round(state.sbTotals.durationSum / state.sbTotals.count) : null;
    var sbTotalsHtml =
      row('Total API Requests',       state.sbTotals.count) +
      row('Total Download Size',      fmtBytes(state.sbTotals.download)) +
      row('Total Upload Size',        fmtBytes(state.sbTotals.upload)) +
      row('Total Estimated Egress',   fmtBytes(state.sbTotals.egress)) +
      row('Average Response Time',    avgResponseTime !== null ? fmtDur(avgResponseTime) : '—') +
      row('Failed Requests',          state.sbTotals.failed, state.sbTotals.failed ? 'err' : '');

    var sbLiveHtml = state.sbRequests.length ? state.sbRequests.slice(0, 15).map(function (r) {
      return '<div class="efm-cache-block">' +
        '<div class="efm-cache-title">' + fmtTime(r.time) + ' — ' + r.feature + '</div>' +
        row('Table',            r.table) +
        row('Method',           r.method) +
        row('URL',              r.url) +
        row('Response Status',  r.status, r.success ? 'ok' : 'err') +
        row('Response Time',    fmtDur(r.duration)) +
        row('Response Size',    fmtBytes(r.size)) +
        row('Est. Egress',      fmtBytes(r.egress)) +
        row('Result',           r.success ? 'SUCCESS' : 'FAILED', r.success ? 'ok' : 'err') +
      '</div>';
    }).join('') : row('Status', 'No Main Supabase requests captured yet', 'warn');

    var featureUsageHtml = FEATURE_ORDER.map(function (f) {
      var u = state.featureUsage[f] || { requests: 0, download: 0 };
      return '<div class="efm-cache-block">' +
        '<div class="efm-cache-title">' + f + '</div>' +
        row('Requests', u.requests) +
        row('Download', fmtBytes(u.download)) +
      '</div>';
    }).join('');

    var actionsHtml =
      '<div class="efm-btn-grid">' +
        '<button class="efm-btn" data-action="clearAllCache">Clear All Cache</button>' +
        '<button class="efm-btn" data-action="refreshHome">Refresh Home Cache</button>' +
        '<button class="efm-btn" data-action="refreshEpisodes">Refresh Episode Cache</button>' +
        '<button class="efm-btn" data-action="refreshNotifications">Refresh Notifications</button>' +
        '<button class="efm-btn" data-action="refreshComments">Refresh Comments</button>' +
        '<button class="efm-btn" data-action="refreshLikes">Refresh Likes</button>' +
        '<button class="efm-btn" data-action="refreshTrending">Refresh Trending</button>' +
        '<button class="efm-btn" data-action="refreshSlider">Refresh Slider</button>' +
        '<button class="efm-btn" data-action="refreshStoryPosition">Refresh Story Position</button>' +
        '<button class="efm-btn" data-action="runCleanupNow">Run Cleanup Now</button>' +
        '<button class="efm-btn" data-action="forceBackgroundRefresh">Force BG Refresh</button>' +
        '<button class="efm-btn" data-action="simulateVersionChange">Simulate Version Change</button>' +
        '<button class="efm-btn" data-action="exportLog">Export Debug Log</button>' +
      '</div>' +
      '<button class="efm-btn" data-action="copyReport" style="margin-top:6px">Copy Debug Report</button>';

    // Event log — all supported event types; unknown types are never emitted.
    var eventLogHtml = '<pre class="efm-log">' + state.log.slice(0, 50).map(function (l) {
      return '[' + fmtTime(l.t) + '] ' + l.type +
        (l.payload && l.payload.key      ? ' — ' + l.payload.key      : '') +
        (l.payload && l.payload.category ? ' — ' + l.payload.category : '') +
        (l.payload && l.payload.removed  ? ' (' + l.payload.removed + ' removed)' : '');
    }).join('\n') + '</pre>';

    body.innerHTML =
      section('Cache',                        cacheSectionsHtml) +
      section('Supabase Connections',         sbConnHtml) +
      section('Supabase Requests',            reqRowsHtml) +
      section('Main Supabase — Totals',       sbTotalsHtml) +
      section('Main Supabase — Live Requests',sbLiveHtml) +
      section('Feature Usage',                featureUsageHtml) +
      section('Request Deduplication',        dedupHtml) +
      section('Background Refresh',           bgHtml) +
      section('Cleanup Worker',               cleanupHtml) +
      section('Pull-To-Refresh',              ptrHtml) +
      section('Version Cache',                versionHtml) +
      section('Episode Debug',                epHtml) +
      section('Continue Watching (read-only)', cwHtml) +
      section('Notifications',                notifHtml) +
      section('Comments',                     commentsHtml) +
      section('Likes',                        likesHtml) +
      section('Local Storage',                lsHtml) +
      section('Performance',                  perfHtml) +
      section('Network',                      networkHtml) +
      section('Debug Actions',                actionsHtml) +
      section('Event Log',                    eventLogHtml);

    // Wire collapsible sections
    body.querySelectorAll('.efm-sec').forEach(function (sec) {
      sec.addEventListener('click', function () {
        var target = document.getElementById(sec.getAttribute('data-target'));
        if (target) target.classList.toggle('collapsed');
      });
    });

    // Wire action buttons
    body.querySelectorAll('[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var fn = actions[btn.getAttribute('data-action')];
        if (fn) fn();
        scheduleRender();
      });
    });
  }

  // Periodic refresh so ages/countdowns stay live even with no new events.
  setInterval(function () { if (panelVisible) render(); }, 1000);
})();
