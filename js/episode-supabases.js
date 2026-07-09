// ── Episode Multi-Supabase Story-ID Router ────────────────────────────────────
// Episodes are served EXCLUSIVELY from Episode Supabase projects.
// The Main Supabase is NEVER queried for episodes.
//
// ── Routing key: Story ID (always known, always O(1)) ────────────────────────
// Every episode request carries a story_id. The router scans the tiny _dbs[]
// array to find the one DB whose storyStart ≤ storyId ≤ storyEnd and sends
// EXACTLY ONE API request. No guessing, no probing, no fallback.
//
// ── Adding a new Episode Supabase (zero code changes) ────────────────────────
// Set four environment variables and restart the server:
//   EPISODE_SUPABASE_N_URL         = "https://yourproject.supabase.co"
//   EPISODE_SUPABASE_N_KEY         = "your-publishable-anon-key"
//   EPISODE_SUPABASE_N_STORY_START = first story_id in this DB
//   EPISODE_SUPABASE_N_STORY_END   = last  story_id in this DB
// Replace N with the next integer (3, 4, 5, …).
//
// ── Failure ───────────────────────────────────────────────────────────────────
// Retry once (1 s delay) on network error or non-2xx.
// After two failures: return { error: 'unavailable' }.
// NEVER query another DB. NEVER query the Main Supabase.
// ─────────────────────────────────────────────────────────────────────────────

(function (global) {
  'use strict';

  // ── Debug hook ───────────────────────────────────────────────────────────────
  function _hook(type, payload) {
    if (typeof global.__debugHook === 'function') {
      try { global.__debugHook(type, payload); } catch (_) {}
    }
  }

  // ── Internal state ───────────────────────────────────────────────────────────
  var _dbs         = [];   // sorted by storyStart
  var _stats       = {};   // dbIndex → { requests, failed, lastSuccessAt, lastDuration, routerDecision, activeRequests }
  var _initialised = false;

  function _ensureStats(db) {
    if (!_stats[db.index]) {
      _stats[db.index] = {
        requests: 0, failed: 0,
        lastSuccessAt: null, lastDuration: null,
        routerDecision: null, activeRequests: 0
      };
    }
  }

  function _init() {
    if (_initialised) return;
    _initialised = true;
    var configs = global.__EPISODE_SUPABASES__;
    if (!Array.isArray(configs) || !configs.length) { _dbs = []; return; }

    _dbs = configs
      .map(function (c, i) {
        return {
          index:      i,
          name:       c.name || ('Episode Supabase ' + (i + 1)),
          url:        (c.url || '').replace(/\/$/, ''),
          key:        c.key  || '',
          storyStart: c.storyStart != null ? Number(c.storyStart) : 1,
          storyEnd:   c.storyEnd   != null ? Number(c.storyEnd)   : Infinity
        };
      })
      .filter(function (c) { return c.url && c.key; })
      .sort(function (a, b) { return a.storyStart - b.storyStart; });

    _dbs.forEach(function (db) { _ensureStats(db); });
  }

  // ── O(1) story-ID lookup ──────────────────────────────────────────────────────
  // _dbs has ≤ 20 entries; linear scan is effectively O(1).
  function _findDbForStory(storyId) {
    var id = Number(storyId);
    for (var i = 0; i < _dbs.length; i++) {
      if (id >= _dbs[i].storyStart && id <= _dbs[i].storyEnd) return _dbs[i];
    }
    return null;
  }

  // ── Raw REST call ─────────────────────────────────────────────────────────────
  function _rawFetch(db, table, params, countOnly) {
    var qs  = params ? '?' + params : '';
    var url = db.url + '/rest/v1/' + table + qs;
    var headers = {
      'apikey':        db.key,
      'Authorization': 'Bearer ' + db.key,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    };
    if (countOnly) {
      headers['Prefer'] = 'count=exact';
      headers['Range']  = '0-0';
    }
    return global.fetch(url, { method: 'GET', headers: headers });
  }

  // ── Retry-once wrapper ────────────────────────────────────────────────────────
  // Returns a fetch Response or throws after exactly two attempts.
  async function _fetchWithRetry(db, table, params, countOnly) {
    var lastErr;
    for (var attempt = 1; attempt <= 2; attempt++) {
      try {
        var res = await _rawFetch(db, table, params, countOnly);
        if (res.ok || res.status === 206 || res.status === 416) return res;
        lastErr = new Error('HTTP ' + res.status);
      } catch (e) {
        lastErr = e;
      }
      if (attempt === 1) {
        _hook('EPISODE_DB_RETRY', { index: db.index, name: db.name, attempt: 1 });
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }
    throw lastErr;
  }

  // ── Execute a data fetch against one specific DB ──────────────────────────────
  // Returns { data: Array, dbIndex, dbName } | { error: 'unavailable' }
  async function _doFetch(db, table, params, storyId) {
    _ensureStats(db);
    _stats[db.index].requests++;
    _stats[db.index].activeRequests++;
    var decision = 'story-id-range (story ' + storyId + ' → ' + db.name + ')';
    _stats[db.index].routerDecision = decision;
    var startedAt = Date.now();
    _hook('EPISODE_DB_ROUTED', { index: db.index, name: db.name, decision: decision });

    try {
      var res      = await _fetchWithRetry(db, table, params, false);
      var duration = Date.now() - startedAt;
      _stats[db.index].lastDuration   = duration;
      _stats[db.index].activeRequests = Math.max(0, _stats[db.index].activeRequests - 1);
      _hook('EPISODE_DB_REQUEST', { index: db.index, name: db.name, duration: duration, ok: true });

      if (!res.ok) {
        _stats[db.index].failed++;
        _hook('EPISODE_DB_FAIL', { index: db.index, name: db.name, status: res.status });
        return { error: 'unavailable' };
      }

      var data = await res.json();
      if (!Array.isArray(data) || !data.length) {
        _hook('EPISODE_DB_EMPTY', { index: db.index, name: db.name });
        return { data: [], dbIndex: db.index, dbName: db.name };
      }

      var rows = data.filter(function (ep) { return ep.story_id != null; });
      _stats[db.index].lastSuccessAt = Date.now();
      _hook('EPISODE_DB_HIT', { index: db.index, name: db.name, count: rows.length });
      return { data: rows, dbIndex: db.index, dbName: db.name };

    } catch (e) {
      var dur2 = Date.now() - startedAt;
      _stats[db.index].lastDuration   = dur2;
      _stats[db.index].failed++;
      _stats[db.index].activeRequests = Math.max(0, _stats[db.index].activeRequests - 1);
      _hook('EPISODE_DB_FAIL',    { index: db.index, name: db.name, error: e.message });
      _hook('EPISODE_DB_REQUEST', { index: db.index, name: db.name, duration: dur2, ok: false });
      return { error: 'unavailable' };
    }
  }

  // ── Execute a count-only fetch against one specific DB ────────────────────────
  // Returns { data: Number, dbIndex, dbName } | { error: 'unavailable' }
  async function _doCount(db, table, params, storyId) {
    _ensureStats(db);
    _stats[db.index].requests++;
    _stats[db.index].activeRequests++;
    var decision = 'story-id-range (story ' + storyId + ' → ' + db.name + ')';
    _stats[db.index].routerDecision = decision;
    var startedAt = Date.now();
    _hook('EPISODE_DB_ROUTED', { index: db.index, name: db.name, decision: decision, countOnly: true });

    try {
      var res      = await _fetchWithRetry(db, table, params, true);
      var duration = Date.now() - startedAt;
      _stats[db.index].lastDuration   = duration;
      _stats[db.index].activeRequests = Math.max(0, _stats[db.index].activeRequests - 1);
      _hook('EPISODE_DB_REQUEST', { index: db.index, name: db.name, duration: duration, ok: true });

      if (res.status === 416) {
        _hook('EPISODE_DB_EMPTY', { index: db.index, name: db.name });
        return { data: 0, dbIndex: db.index, dbName: db.name };
      }
      if (!res.ok && res.status !== 206) {
        _stats[db.index].failed++;
        _hook('EPISODE_DB_FAIL', { index: db.index, name: db.name, status: res.status });
        return { error: 'unavailable' };
      }

      var cr    = res.headers.get('Content-Range') || '';
      var match = cr.match(/\/(\d+)/);
      var count = match ? parseInt(match[1], 10) : 0;

      if (count === 0) {
        _hook('EPISODE_DB_EMPTY', { index: db.index, name: db.name });
        return { data: 0, dbIndex: db.index, dbName: db.name };
      }

      _stats[db.index].lastSuccessAt = Date.now();
      _hook('EPISODE_DB_HIT', { index: db.index, name: db.name, count: count });
      return { data: count, dbIndex: db.index, dbName: db.name };

    } catch (e) {
      var dur2 = Date.now() - startedAt;
      _stats[db.index].lastDuration   = dur2;
      _stats[db.index].failed++;
      _stats[db.index].activeRequests = Math.max(0, _stats[db.index].activeRequests - 1);
      _hook('EPISODE_DB_FAIL',    { index: db.index, name: db.name, error: e.message });
      _hook('EPISODE_DB_REQUEST', { index: db.index, name: db.name, duration: dur2, ok: false });
      return { error: 'unavailable' };
    }
  }

  // ── Public: fetch episode rows ────────────────────────────────────────────────
  // storyId is the ONLY routing key. One DB selected, one request sent.
  async function fetch(table, params, storyId) {
    _init();
    if (!_dbs.length) return null;           // no episode DBs configured at all

    var db = _findDbForStory(storyId);
    if (!db) {
      _hook('EPISODE_DB_UNAVAILABLE', { reason: 'no-db-for-story-' + storyId });
      return { error: 'unavailable' };        // story ID not covered by any configured range
    }

    var result = await _doFetch(db, table, params, storyId);
    if (result.error) {
      _hook('EPISODE_DB_UNAVAILABLE', { index: db.index, name: db.name, storyId: storyId });
    }
    return result;
  }

  // ── Public: fetch episode count ───────────────────────────────────────────────
  // storyId is the ONLY routing key. One DB selected, one request sent.
  async function fetchCount(table, params, storyId) {
    _init();
    if (!_dbs.length) return null;

    var db = _findDbForStory(storyId);
    if (!db) {
      _hook('EPISODE_DB_UNAVAILABLE', { reason: 'no-db-for-story-' + storyId });
      return { error: 'unavailable' };
    }

    var result = await _doCount(db, table, params, storyId);
    if (result.error) {
      _hook('EPISODE_DB_UNAVAILABLE', { index: db.index, name: db.name, storyId: storyId });
    }
    return result;
  }

  // ── Public API ────────────────────────────────────────────────────────────────
  global.EpisodeDB = {
    fetch:        fetch,
    fetchCount:   fetchCount,
    hasSupabases: function () { _init(); return _dbs.length > 0; },
    getDbs:       function () { _init(); return _dbs; },
    getStats:     function () { _init(); return _stats; },
    getState:     function () { _init(); return { supabases: _dbs, stats: _stats }; }
  };

  _init();
})(window);
