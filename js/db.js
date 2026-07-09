// Supabase DB Layer
// Uses direct REST fetch (works with all key types including sb_publishable_*)

var _sb = null;
var _sbUrl = '';
var _sbKey = '';

function initSupabase() {
  var url = window.__SUPABASE_URL__;
  var key = window.__SUPABASE_KEY__;

  if (!url || !key) {
    console.warn('[DB] Supabase credentials not found. Data will not load.');
    return false;
  }

  _sbUrl = url.replace(/\/$/, '');
  _sbKey = key;

  try {
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      _sb = window.supabase.createClient(url, key);
    }
  } catch (e) {
    console.warn('[DB] Supabase JS client failed, using REST directly:', e.message);
  }

  console.log('[DB] Supabase init: URL=' + _sbUrl.substring(0, 40) + ' Key=' + key.substring(0, 15) + '...');

  sbFetch('stories', 'limit=1')
    .then(function(r) {
      if (r.ok || r.status === 200) {
        console.log('[DB] Supabase connected via REST ✓');
      } else {
        r.json().then(function(d) {
          console.warn('[DB] Supabase REST test failed:', d.message || d.code || r.status);
        }).catch(function() {
          console.warn('[DB] Supabase REST test status:', r.status);
        });
      }
    })
    .catch(function(e) {
      console.warn('[DB] Supabase REST unreachable:', e.message);
    });

  return true;
}

// ── Debug tracking (no-op unless js/debug-panel.js sets DEBUG_PANEL = true) ──
// Purely observational: records request start/finish/duration for monitoring.
// Never changes what is fetched, when, or the returned value.
var _DBG_TABLE_CATEGORY = {
  stories: 'stories', slides: 'stories', episodes: 'episodes',
  notifications: 'notifications', comments: 'comments', likes: 'likes'
};

function _dbgCategoryFor(table) {
  return _DBG_TABLE_CATEGORY[table] || table || 'other';
}

// Wrap an async operation with request-lifecycle events for the debug panel.
// `fn` must return a Promise. Resolves/rejects exactly as `fn` would.
function _dbgTrack(category, fn) {
  var hook = window.__debugHook;
  if (!hook) return fn();
  var startedAt = Date.now();
  hook('REQUEST_STARTED', { category: category, startedAt: startedAt });
  return fn().then(function (result) {
    var finishedAt = Date.now();
    hook('SUPABASE_REQUEST', { category: category, startedAt: startedAt, finishedAt: finishedAt, duration: finishedAt - startedAt, ok: true });
    hook('REQUEST_FINISHED', { category: category });
    return result;
  }, function (err) {
    var finishedAt = Date.now();
    hook('SUPABASE_REQUEST', { category: category, startedAt: startedAt, finishedAt: finishedAt, duration: finishedAt - startedAt, ok: false, error: err && err.message });
    hook('REQUEST_FINISHED', { category: category });
    throw err;
  });
}

// ── Core REST helper ──────────────────────────────────────────────────────────

function sbFetch(table, params, opts) {
  opts = opts || {};
  var qs = params ? '?' + params : '';
  var url = _sbUrl + '/rest/v1/' + table + qs;
  var headers = {
    'apikey': _sbKey,
    'Authorization': 'Bearer ' + _sbKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  if (opts.count) headers['Prefer'] = (headers['Prefer'] ? headers['Prefer'] + ',' : '') + 'count=exact';

  return _dbgTrack(_dbgCategoryFor(table), function () {
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  });
}

async function sbSelect(table, params) {
  if (!_sbUrl || !_sbKey) return null;
  try {
    var r = await sbFetch(table, params);
    if (!r.ok) {
      var err = await r.json().catch(function() { return {}; });
      throw new Error(err.message || err.code || ('HTTP ' + r.status));
    }
    return await r.json();
  } catch (e) {
    throw e;
  }
}

async function sbInsert(table, row) {
  if (!_sbUrl || !_sbKey) return null;
  var r = await sbFetch(table, null, { method: 'POST', body: row, prefer: 'return=representation' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    throw new Error(err.message || 'Insert failed');
  }
  var data = await r.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbDelete(table, params) {
  if (!_sbUrl || !_sbKey) return;
  var r = await sbFetch(table, params, { method: 'DELETE' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    throw new Error(err.message || 'Delete failed');
  }
}

var _DBG_RPC_CATEGORY = {
  increment_views: 'views',
  increment_story_likes: 'likes', decrement_story_likes: 'likes'
};

async function sbRpc(funcName, params) {
  if (!_sbUrl || !_sbKey) return false;
  return _dbgTrack(_DBG_RPC_CATEGORY[funcName] || 'other', async function () {
    // Use user JWT if available so SECURITY DEFINER RPCs run in the right context
    var token = null;
    try {
      if (_sb) {
        var sr = await _sb.auth.getSession();
        if (sr && sr.data && sr.data.session) token = sr.data.session.access_token;
      }
    } catch (e) {}
    var r = await fetch(_sbUrl + '/rest/v1/rpc/' + funcName, {
      method: 'POST',
      headers: {
        'apikey': _sbKey,
        'Authorization': 'Bearer ' + (token || _sbKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params || {}),
    });
    if (!r.ok) {
      var err = await r.json().catch(function() { return {}; });
      console.warn('[RPC] ' + funcName + ' failed (' + r.status + '):', err.message || JSON.stringify(err));
    }
    return r.ok;
  });
}

// ── Stories ───────────────────────────────────────────────────────────────────
// Column lists kept minimal (never SELECT *) — only fields the UI actually renders.
var STORY_COLUMNS = 'id,title,image_url,category,total_episodes,views_count,likes_count,created_at';
var SLIDE_COLUMNS = 'id,story_id,image_url,position';

// Home stories / category grid / story order — cached 6h, stale-while-revalidate.
// Pass { bypass: true } (pull-to-refresh) to force a fresh Supabase fetch.
async function fetchStories(category, limit, opts) {
  category = category || 'all';
  limit = limit || 20;
  opts = opts || {};

  if (!_sbUrl) {
    console.warn('[DB] fetchStories: Supabase not configured, returning empty.');
    return [];
  }

  var key = 'stories_' + category + '_' + limit;
  var run = async function() {
    var qs = 'select=' + STORY_COLUMNS + '&limit=' + limit + '&order=created_at.desc';
    if (category !== 'all') qs += '&category=eq.' + encodeURIComponent(category);
    var data = await sbSelect('stories', qs);
    console.log('STORIES:', data);
    return data || [];
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, {
      bypass: opts.bypass,
      onBackgroundUpdate: opts.onBackgroundUpdate
    });
  } catch (e) {
    console.log('ERROR (fetchStories):', e.message);
    return [];
  }
}

// Trending list — cached 6h, stale-while-revalidate.
async function fetchTrending(limit, opts) {
  limit = limit || 10;
  opts = opts || {};

  if (!_sbUrl) {
    console.warn('[DB] fetchTrending: Supabase not configured, returning empty.');
    return [];
  }

  var key = 'trending_' + limit;
  var run = async function() {
    var data = await sbSelect('stories', 'select=' + STORY_COLUMNS + '&order=views_count.desc&limit=' + limit);
    console.log('STORIES (trending):', data);
    return data || [];
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, {
      bypass: opts.bypass,
      onBackgroundUpdate: opts.onBackgroundUpdate
    });
  } catch (e) {
    console.log('ERROR (fetchTrending):', e.message);
    return [];
  }
}

async function fetchStoryById(storyId) {
  if (!_sbUrl) {
    console.warn('[DB] fetchStoryById: Supabase not configured, returning null.');
    return null;
  }
  // Reuse already-cached story lists in memory before hitting the network —
  // avoids a duplicate request when the story was just shown on Home/Trending.
  var fromCache = _findStoryInAnyCachedList(storyId);
  if (fromCache) return fromCache;

  try {
    var data = await sbSelect('stories', 'select=' + STORY_COLUMNS + '&id=eq.' + storyId + '&limit=1');
    console.log('[DB] fetchStoryById(' + storyId + '):', data && data.length ? 'found' : 'not found');
    if (data && data.length > 0) return data[0];
    return null;
  } catch (e) {
    console.log('ERROR (fetchStoryById):', e.message);
    return null;
  }
}

// Look through any cached stories/trending lists in localStorage for a matching id.
// Pure read of already-fetched data — never triggers a network call.
function _findStoryInAnyCachedList(storyId) {
  if (!window.AppCache) return null;
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (!k || (k.indexOf('efm_cache_stories_') !== 0 && k.indexOf('efm_cache_trending_') !== 0)) continue;
      var raw = localStorage.getItem(k);
      if (!raw) continue;
      var parsed = JSON.parse(raw);
      if (!parsed || !AppCache.isFresh(parsed, AppCache.TTL_6H) || !Array.isArray(parsed.data)) continue;
      for (var j = 0; j < parsed.data.length; j++) {
        if (String(parsed.data[j].id) === String(storyId)) return parsed.data[j];
      }
    }
  } catch (e) {}
  return null;
}

async function fetchStoriesByIds(ids) {
  if (!ids || !ids.length) return [];
  if (!_sbUrl) {
    console.warn('[DB] fetchStoriesByIds: Supabase not configured, returning empty.');
    return [];
  }
  // Serve from cached lists first; only fetch the ids that are missing.
  var found = {};
  var missing = [];
  ids.forEach(function(id) {
    var s = _findStoryInAnyCachedList(id);
    if (s) found[String(id)] = s;
    else missing.push(id);
  });

  if (missing.length) {
    try {
      var qs = 'select=' + STORY_COLUMNS + '&id=in.(' + missing.join(',') + ')';
      var data = await sbSelect('stories', qs);
      console.log('[DB] fetchStoriesByIds:', data ? data.length : 0, 'results (network)');
      (data || []).forEach(function(s) { found[String(s.id)] = s; });
    } catch (e) {
      console.log('ERROR (fetchStoriesByIds):', e.message);
    }
  }

  // Preserve requested order
  return ids.map(function(id) { return found[String(id)]; }).filter(Boolean);
}

// ── Slides ────────────────────────────────────────────────────────────────────

// Slider content — cached 6h, stale-while-revalidate.
async function fetchSlides(limit, opts) {
  limit = limit || 10;
  opts = opts || {};

  if (!_sbUrl) {
    console.warn('[DB] fetchSlides: Supabase not configured, returning empty.');
    return [];
  }

  var key = 'slides_' + limit;
  var run = async function() {
    var data = await sbSelect('slides', 'select=' + SLIDE_COLUMNS + '&limit=' + limit);
    console.log('SLIDES:', data);
    return (data || []).filter(function(s) { return s.active !== false; });
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, {
      bypass: opts.bypass,
      onBackgroundUpdate: opts.onBackgroundUpdate
    });
  } catch (e) {
    console.log('SLIDES: not available (' + e.message + ')');
    return [];
  }
}

// ── Episodes ──────────────────────────────────────────────────────────────────
// Episodes are served EXCLUSIVELY from Episode Supabase projects.
// The Main Supabase is NEVER queried for episodes.
// Column list kept minimal — only fields the player/episode-list UI renders.
var EPISODE_COLUMNS  = 'id,story_id,episode_number,episode_name,audio_url';
var EP_BATCH_LIMIT   = 10;   // episodes per API request — Pocket FM style lazy loading

// Fetch exactly EP_BATCH_LIMIT episodes at a given row offset.
// Cache key: ep_{storyId}_{offset+1}_{offset+limit}  e.g. ep_3_1_10, ep_3_11_20
// One Supabase request, one batch — never downloads 100 episodes at once.
// Returns [] for the last (possibly partial) batch; null on unavailability.
async function fetchEpisodeBatch(storyId, offset, opts) {
  opts   = opts || {};
  offset = Number(offset) || 0;
  var limit      = EP_BATCH_LIMIT;
  var batchStart = offset + 1;                             // 1-indexed label for key
  var batchEnd   = offset + limit;
  var key        = 'ep_' + storyId + '_' + batchStart + '_' + batchEnd;
  var params     = 'select=' + EPISODE_COLUMNS +
    '&story_id=eq.' + storyId +
    '&story_id=not.is.null' +
    '&order=episode_number.asc' +
    '&limit=' + limit +
    '&offset=' + offset;

  var run = async function () {
    if (!window.EpisodeDB || !EpisodeDB.hasSupabases()) {
      throw new Error('No Episode Supabases configured');
    }
    var result = await EpisodeDB.fetch('episodes', params, storyId);
    if (result === null) throw new Error('No Episode Supabases configured');
    if (result.error)    throw new Error('EPISODE_UNAVAILABLE');
    console.log('[EP] batch storyId=' + storyId + ' offset=' + offset +
                ' from=' + (result.dbName || '?') + ' count=' + result.data.length);
    return result.data;
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, { bypass: opts.bypass });
  } catch (e) {
    if (e.message === 'EPISODE_UNAVAILABLE') return null;
    console.error('[EP] fetchEpisodeBatch error:', e.message);
    return null;
  }
}

// Fetch all episodes for a story.
// Routing is by story_id — exactly one Episode Supabase is queried.
async function fetchEpisodes(storyId, opts) {
  opts = opts || {};
  var key    = 'episodes_full_' + storyId;
  var params = 'select=' + EPISODE_COLUMNS +
    '&story_id=eq.' + storyId +
    '&story_id=not.is.null&order=episode_number.asc';

  var run = async function () {
    if (!window.EpisodeDB || !EpisodeDB.hasSupabases()) {
      throw new Error('No Episode Supabases configured');
    }
    var result = await EpisodeDB.fetch('episodes', params, storyId);
    if (result === null) throw new Error('No Episode Supabases configured');
    if (result.error)    throw new Error('EPISODE_UNAVAILABLE');
    console.log('[EP] fetchEpisodes story=' + storyId + ' from=' + (result.dbName || '?') + ' count=' + result.data.length);
    return result.data;
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, { bypass: opts.bypass });
  } catch (e) {
    if (e.message === 'EPISODE_UNAVAILABLE') throw e;
    console.error('[EP] fetchEpisodes error:', e.message);
    return [];
  }
}

// Total episode count for a story — cached 6h.
// Routing is by story_id — exactly one Episode Supabase is queried.
// Returns null when the Episode Supabase is temporarily unavailable.
async function fetchEpisodeCount(storyId, opts) {
  opts = opts || {};
  var key    = 'epcount_' + storyId;
  var params = 'select=id&story_id=eq.' + storyId + '&story_id=not.is.null';

  var run = async function () {
    if (!window.EpisodeDB || !EpisodeDB.hasSupabases()) {
      throw new Error('No Episode Supabases configured');
    }
    var result = await EpisodeDB.fetchCount('episodes', params, storyId);
    if (result === null) throw new Error('No Episode Supabases configured');
    if (result.error)    throw new Error('EPISODE_UNAVAILABLE');
    console.log('[EP] fetchEpisodeCount story=' + storyId + ' count=' + result.data + ' from=' + (result.dbName || '?'));
    return result.data;
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run, { bypass: opts.bypass });
  } catch (e) {
    if (e.message === 'EPISODE_UNAVAILABLE') return null;
    console.error('[EP] fetchEpisodeCount error:', e.message);
    return 0;
  }
}

// ── Play Count ────────────────────────────────────────────────────────────────

var _sessionPlayedStories = {};

async function recordPlayCount(storyId) {
  // increment_story_views RPC was removed server-side (returned 404).
  // The session-level dedup guard is kept so the flag remains usable by
  // any future replacement, but no network request is sent.
  if (!storyId || _sessionPlayedStories[storyId]) return;
  _sessionPlayedStories[storyId] = true;
}

// ── Auth Helper (Supabase-only, no localStorage) ──────────────────────────────

async function getAuthUser() {
  // Layer 1: Live Supabase session (most authoritative)
  if (_sb) {
    try {
      var res = await _sb.auth.getUser();
      if (res && res.data && res.data.user && res.data.user.id) {
        console.log('[AUTH] getAuthUser → Supabase session ✓', res.data.user.id);
        return res.data.user;
      }
    } catch (e) {
      console.log('[AUTH] getAuthUser Supabase error:', e.message);
    }
  }

  // Layer 2: In-memory currentUser (set ONLY by Supabase auth events)
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
    console.log('[AUTH] getAuthUser → in-memory currentUser ✓', currentUser.id);
    return currentUser;
  }

  console.log('[AUTH] getAuthUser → no logged-in user found');
  return null;
}

// ── Get current session access token (needed for RLS-protected writes) ────────

async function _getSessionToken() {
  if (_sb) {
    try {
      var res = await _sb.auth.getSession();
      if (res && res.data && res.data.session && res.data.session.access_token) {
        return res.data.session.access_token;
      }
    } catch (e) {
      console.log('[AUTH] _getSessionToken error:', e.message);
    }
  }
  return null;
}

// ── Authenticated REST helper (uses user JWT when available) ──────────────────

async function sbAuthFetch(table, params, opts) {
  opts = opts || {};
  var token = await _getSessionToken();
  var bearerToken = token || _sbKey;
  var qs = params ? '?' + params : '';
  var url = _sbUrl + '/rest/v1/' + table + qs;
  var headers = {
    'apikey': _sbKey,
    'Authorization': 'Bearer ' + bearerToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  if (opts.prefer) headers['Prefer'] = opts.prefer;
  return fetch(url, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
}

async function sbAuthInsert(table, row) {
  if (!_sbUrl || !_sbKey) return null;
  var r = await sbAuthFetch(table, null, { method: 'POST', body: row, prefer: 'return=representation' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    throw new Error(err.message || err.hint || ('Insert failed: HTTP ' + r.status));
  }
  var data = await r.json();
  return Array.isArray(data) ? data[0] : data;
}

async function sbAuthDelete(table, params) {
  if (!_sbUrl || !_sbKey) return;
  var r = await sbAuthFetch(table, params, { method: 'DELETE' });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    throw new Error(err.message || err.hint || ('Delete failed: HTTP ' + r.status));
  }
}

async function sbAuthSelect(table, params) {
  if (!_sbUrl || !_sbKey) return null;
  try {
    var r = await sbAuthFetch(table, params);
    if (!r.ok) {
      var err = await r.json().catch(function() { return {}; });
      throw new Error(err.message || err.hint || ('HTTP ' + r.status));
    }
    return await r.json();
  } catch (e) {
    throw e;
  }
}

// ── Views (at 50% — session-only, NO localStorage) ────────────────────────────
// Works for guest AND logged-in users.
// viewCounted flag in player.js (reset on every 'play' event) prevents
// duplicate increments within a single play session.

async function recordView(storyId) {
  console.log('[VIEW] recordView called — story:', storyId);
  if (!storyId) { console.log('[VIEW] No storyId — skipping'); return; }
  if (!_sbUrl)  { console.log('[VIEW] Supabase not configured — skipping'); return; }
  try {
    var ok = await sbRpc('increment_views', { story_id: storyId });
    console.log('[VIEW] Story view increment →', ok ? 'SUCCESS ✓' : 'FAILED ✗');
  } catch (e) {
    console.log('[VIEW] recordView error:', e.message);
  }
}

// ── Likes (Supabase JS client — handles JWT + RLS automatically) ───────────────

async function getLikeStatus(storyId) {
  var user = await getAuthUser();
  var sid = Number(storyId);
  console.log('[LIKE] getLikeStatus — user:', user ? user.id : 'not logged in', '| story:', sid, '(bigint)');
  if (!user || !_sb) return false;

  var key = 'likestatus_' + sid + '_' + user.id;
  var run = async function() {
    return _dbgTrack('likes', async function() {
      var res = await _sb.from('likes')
        .select('id')
        .eq('user_id', user.id)
        .eq('story_id', sid)
        .maybeSingle();
      console.log('[LIKE] getLikeStatus raw response:', JSON.stringify(res));
      if (res.error) {
        console.error('[LIKE] getLikeStatus error:', res.error);
        return false;
      }
      return !!res.data;
    });
  };

  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run);
  } catch (e) {
    console.error('[LIKE] getLikeStatus exception:', e);
    return false;
  }
}

async function toggleLikeDB(storyId) {
  // Always get a fresh authenticated user — never use custom UID
  var user = await getAuthUser();
  // story_id column is bigint — always cast
  var sid = Number(storyId);
  console.log('[LIKE] toggleLike — user:', user ? user.id : 'NOT LOGGED IN', '| story_id:', sid, '(bigint) | raw type:', typeof storyId);

  if (!user || !user.id) {
    console.log('[LIKE] toggleLike blocked — user not logged in');
    return null;
  }
  if (!_sb) {
    console.log('[LIKE] toggleLike — Supabase JS client not available');
    return 'error:Supabase not configured';
  }

  try {
    return await _dbgTrack('likes', async function() {
    // Step 1: Check existing like using bigint story_id
    var checkRes = await _sb.from('likes')
      .select('id')
      .eq('user_id', user.id)
      .eq('story_id', sid)
      .maybeSingle();
    console.log('[LIKE] check existing:', JSON.stringify(checkRes));

    if (checkRes.error) {
      console.error('[LIKE] check error:', checkRes.error);
      return 'error:' + (checkRes.error.message || JSON.stringify(checkRes.error));
    }

    var isLiked = !!checkRes.data;
    console.log('[LIKE] current isLiked:', isLiked);

    if (isLiked) {
      // ── UNLIKE ──
      var delRes = await _sb.from('likes')
        .delete()
        .eq('user_id', user.id)
        .eq('story_id', sid);
      console.log('[LIKE] delete response:', JSON.stringify(delRes));
      if (delRes.error) {
        console.error('[LIKE] delete error:', delRes.error);
        return 'error:' + (delRes.error.message || JSON.stringify(delRes.error));
      }
      var rpcOk = await sbRpc('decrement_story_likes', { s_id: sid });
      console.log('[LIKE] decrement_story_likes RPC ok:', rpcOk);
      if (window.AppCache) {
        AppCache.invalidate('likestatus_' + sid + '_' + user.id);
        AppCache.invalidatePrefix('likescount_');
      }
      return false;

    } else {
      // ── LIKE — user_id (uuid) + story_id (bigint) ──
      var insPayload = { user_id: user.id, story_id: sid };
      console.log('[LIKE] inserting payload:', JSON.stringify(insPayload));
      var insRes = await _sb.from('likes')
        .insert(insPayload)
        .select()
        .single();
      console.log('[LIKE] insert response:', JSON.stringify(insRes));
      if (insRes.error) {
        console.error('[LIKE] insert error:', insRes.error);
        console.error('[LIKE] insert error details:', JSON.stringify(insRes.error));
        return 'error:' + (insRes.error.message || JSON.stringify(insRes.error));
      }
      console.log('[LIKE] inserted row:', JSON.stringify(insRes.data));
      var rpcOk = await sbRpc('increment_story_likes', { s_id: sid });
      console.log('[LIKE] increment_story_likes RPC ok:', rpcOk);
      if (window.AppCache) {
        AppCache.invalidate('likestatus_' + sid + '_' + user.id);
        AppCache.invalidatePrefix('likescount_');
      }
      return true;
    }
    });

  } catch (e) {
    console.error('[LIKE] toggleLike exception:', e);
    return 'error:' + e.message;
  }
}

// ── Library ───────────────────────────────────────────────────────────────────

function getSavedStories() {
  try { return JSON.parse(localStorage.getItem('library_saved') || '[]'); }
  catch (e) { return []; }
}

function getLibraryStatus(storyId) {
  return getSavedStories().indexOf(String(storyId)) !== -1;
}

async function toggleLibraryDB(story) {
  var storyId = String(story.id);
  var saved = getSavedStories();
  var isSaved = saved.indexOf(storyId) !== -1;
  if (isSaved) {
    saved = saved.filter(function(id) { return id !== storyId; });
  } else {
    saved.push(storyId);
  }
  localStorage.setItem('library_saved', JSON.stringify(saved));
  if (_sbUrl && isLoggedIn()) {
    try {
      var userId = getCurrentUserId();
      if (isSaved) {
        await sbDelete('library', 'user_id=eq.' + userId + '&story_id=eq.' + storyId);
      } else {
        await sbInsert('library', { user_id: userId, story_id: storyId });
      }
    } catch (e) {
      console.log('[DB] toggleLibrary (library table may not exist):', e.message);
    }
  }
  return !isSaved;
}

// ── Comments ──────────────────────────────────────────────────────────────────
var COMMENT_COLUMNS = 'id,story_id,user_id,user_name,comment,created_at';

// Full comments list — cached 3h, stale-while-revalidate.
// Pass { bypass: true } (pull-to-refresh) to force a fresh Supabase fetch.
async function fetchComments(storyId, opts) {
  opts = opts || {};
  if (!_sbUrl) return [];
  var key = 'comments_' + storyId;
  var run = async function() {
    var data = await sbSelect('comments', 'select=' + COMMENT_COLUMNS + '&story_id=eq.' + storyId + '&order=created_at.desc&limit=30');
    return data || [];
  };
  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_3H, run, {
      bypass: opts.bypass,
      onBackgroundUpdate: opts.onBackgroundUpdate
    });
  } catch (e) {
    console.log('ERROR (fetchComments):', e.message);
    return [];
  }
}

async function postComment(storyId, text) {
  if (!text || !text.trim()) return null;

  // Always get a fresh Supabase user — never use custom UID or cached state
  var user = await getAuthUser();
  console.log('[COMMENT] postComment — user:', user ? user.id : 'not logged in', '| story:', storyId, '| type:', typeof storyId);

  if (!user || !user.id) {
    console.log('[COMMENT] Blocked — user not logged in');
    return null;
  }

  if (!_sb) {
    console.log('[COMMENT] Blocked — Supabase JS client not available');
    return null;
  }

  // Resolve display name — prefer name > username > email prefix > 'User'
  var userName = 'User';
  if (typeof currentUser !== 'undefined' && currentUser) {
    userName = currentUser.name || currentUser.username ||
               (currentUser.email ? currentUser.email.split('@')[0] : '') || 'User';
  }

  // Build insert payload matching exact DB column names and types:
  //   user_id  → uuid
  //   user_name → text  (displayed in comments UI)
  //   story_id → bigint (Number cast required)
  //   comment  → text   (column is "comment", NOT "comment_text")
  var payload = {
    user_id:   user.id,
    user_name: userName,
    story_id:  Number(storyId),
    comment:   text.trim()
  };
  console.log('[COMMENT] inserting payload:', JSON.stringify(payload), '| story_id type:', typeof Number(storyId));

  try {
    return await _dbgTrack('comments', async function() {
      var res = await _sb.from('comments')
        .insert(payload)
        .select()
        .single();

      console.log('[COMMENT] insert response:', JSON.stringify(res));

      if (res.error) {
        console.error('[COMMENT] insert error:', res.error);
        console.error('[COMMENT] insert error details:', JSON.stringify(res.error));
        // Return error object so caller can show the real message
        return { _error: res.error.message || JSON.stringify(res.error) };
      }

      console.log('[COMMENT] Posted successfully ✓', res.data);
      if (window.AppCache) AppCache.invalidate('comments_' + storyId);
      return res.data;
    });
  } catch (e) {
    console.error('[COMMENT] postComment exception:', e);
    return { _error: e.message || 'Unknown error' };
  }
}

// ── Continue Watching ─────────────────────────────────────────────────────────
// localStorage = fast/offline layer  |  Supabase = persistent cross-device layer
// Structure: [{ story_id, episode_id, episode_number, current_time, duration, updated_at }]

function saveProgress(storyId, episodeId, episodeNumber, currentTime, duration) {
  try {
    // 1. Always save locally first (instant, works offline)
    var history = getContinueWatching();
    var idx = -1;
    for (var i = 0; i < history.length; i++) {
      if (String(history[i].story_id) === String(storyId)) { idx = i; break; }
    }
    var entry = {
      story_id:       String(storyId),
      episode_id:     String(episodeId),
      episode_number: episodeNumber || 1,
      current_time:   currentTime,
      duration:       duration,
      updated_at:     Date.now()
    };
    if (idx >= 0) history[idx] = entry;
    else history.unshift(entry);
    history.sort(function(a, b) { return b.updated_at - a.updated_at; });
    localStorage.setItem('continue_watching', JSON.stringify(history.slice(0, 15)));

    // ── Debug panel: saveProgress() was called ──────────────────────────────
    if (typeof window._cwDbgSP === 'function') {
      window._cwDbgSP(storyId, episodeId, episodeNumber, currentTime, duration);
    }

    // 2. Async upsert to Supabase (fire-and-forget — never blocks playback)
    saveProgressToSupabase(storyId, episodeId, episodeNumber, currentTime, duration);
  } catch (e) { console.log('[DB] saveProgress error:', e); }
}

// Upsert one row per (user_id, story_id) in Supabase continue_watching table
// Full diagnostic logging + debug panel hooks
async function saveProgressToSupabase(storyId, episodeId, episodeNumber, currentTime, duration) {
  var _dbg = typeof window._cwDbgSPS === 'function' ? window._cwDbgSPS : null;

  try {
    // ── 1. Verify Supabase client exists ─────────────────────────────────────
    if (!_sb) {
      var r1 = '[CW] SKIP — _sb client not initialised';
      console.warn(r1);
      if (_dbg) _dbg('skip', { reason: r1 });
      return;
    }

    // ── 2. Verify active session ──────────────────────────────────────────────
    var sessionRes = await _sb.auth.getSession();
    var session    = sessionRes && sessionRes.data && sessionRes.data.session;

    if (!session || !session.user || !session.user.id) {
      var r2 = '[CW] SKIP — no active session. sessionRes: ' + JSON.stringify(sessionRes && sessionRes.data);
      console.warn(r2);
      if (_dbg) _dbg('skip', { reason: r2 });
      return;
    }
    var userId = session.user.id;
    if (_dbg) _dbg('uuid', { userId: userId });
    console.log('[CW] Session OK — user_id:', userId);

    // ── 3. Build payload ──────────────────────────────────────────────────────
    var pct = (duration > 0) ? Math.min(Math.round((currentTime / duration) * 100), 100) : 0;
    var row = {
      user_id:           userId,
      story_id:          String(storyId),
      episode_id:        String(episodeId),
      episode_number:    episodeNumber || 1,
      playback_position: Math.round(currentTime) || 0,
      progress_percent:  pct,
      duration:          Math.round(duration) || 0,
      updated_at:        new Date().toISOString()
    };

    console.log('[CW] PAYLOAD →', JSON.stringify(row));
    if (_dbg) _dbg('sending', { payload: row });

    // ── 4. Upsert ─────────────────────────────────────────────────────────────
    var res = await _sb
      .from('continue_watching')
      .upsert(row, { onConflict: 'user_id,story_id' });

    // ── 5. Log full response ──────────────────────────────────────────────────
    if (res.error) {
      var errDetail = {
        code:    res.error.code,
        message: res.error.message,
        details: res.error.details,
        hint:    res.error.hint,
        status:  res.status
      };
      console.error('[CW] UPSERT FAILED ✗', errDetail);
      if (_dbg) _dbg('error', { error: errDetail, response: { status: res.status } });
    } else {
      console.log('[CW] UPSERT SUCCESS ✓ — story:', storyId,
        '| ep:', episodeNumber,
        '| pos:', row.playback_position + 's',
        '| pct:', pct + '%');
      if (_dbg) _dbg('success', { response: 'OK — no error (status 2xx)' });
    }
  } catch (e) {
    console.error('[CW] saveProgressToSupabase EXCEPTION:', e.message, e);
    if (_dbg) _dbg('exception', { message: e.message });
  }
}

// Fetch all continue_watching rows for current user; merge into localStorage
async function syncContinueWatchingFromSupabase() {
  try {
    var userId = getCurrentUserId();
    if (!userId || !_sb) return; // Guest mode — use localStorage only

    var res = await _sb
      .from('continue_watching')
      .select('story_id, episode_id, episode_number, playback_position, progress_percent, duration, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(15);

    if (res.error) {
      console.log('[CW] Supabase fetch error:', res.error.message);
      return;
    }
    if (!res.data || !res.data.length) {
      console.log('[CW] Supabase: no continue_watching rows for user');
      return;
    }

    // Convert Supabase rows → local format, then merge with localStorage
    var remote = res.data.map(function(r) {
      return {
        story_id:       String(r.story_id),
        episode_id:     String(r.episode_id || ''),
        episode_number: r.episode_number || 1,
        current_time:   r.playback_position || 0,
        duration:       r.duration || 0,
        updated_at:     r.updated_at ? new Date(r.updated_at).getTime() : 0
      };
    });

    // Merge: for each story keep whichever entry is newer
    var local = getContinueWatching();
    var merged = {};
    local.forEach(function(e)  { merged[e.story_id] = e; });
    remote.forEach(function(e) {
      var existing = merged[e.story_id];
      if (!existing || e.updated_at > existing.updated_at) {
        merged[e.story_id] = e;
      }
    });

    var sorted = Object.values(merged).sort(function(a, b) { return b.updated_at - a.updated_at; });
    localStorage.setItem('continue_watching', JSON.stringify(sorted.slice(0, 15)));
    console.log('[CW] Supabase sync complete —', sorted.length, 'stories merged');
  } catch (e) {
    console.log('[CW] syncContinueWatchingFromSupabase exception:', e.message);
  }
}

function getContinueWatching() {
  try { return JSON.parse(localStorage.getItem('continue_watching') || '[]'); }
  catch (e) { return []; }
}

function getStoryProgress(storyId) {
  try {
    var history = getContinueWatching();
    for (var i = 0; i < history.length; i++) {
      if (String(history[i].story_id) === String(storyId)) return history[i];
    }
    return null;
  } catch (e) { return null; }
}

// ── Notifications ─────────────────────────────────────────────────────────────
// Note: type/story_id/read are referenced defensively in notifications.js UI
// code but do not exist as columns in this schema — omitted here since
// PostgREST rejects selects naming nonexistent columns.
var NOTIF_COLUMNS = 'id,title,message,created_at';

// Cached 3h, stale-while-revalidate. Pass { bypass: true } for pull-to-refresh.
async function fetchNotifications(opts) {
  opts = opts || {};
  if (!_sbUrl) {
    console.log('[NOTIF] Supabase not configured');
    return [];
  }
  var key = 'notifications_list';
  var run = async function() {
    var data = await sbSelect('notifications', 'select=' + NOTIF_COLUMNS + '&order=created_at.desc&limit=50');
    console.log('[NOTIF] Fetched:', data ? data.length : 0, 'notifications', data);
    return data || [];
  };
  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_3H, run, {
      bypass: opts.bypass,
      onBackgroundUpdate: opts.onBackgroundUpdate
    });
  } catch (e) {
    console.log('[NOTIF] fetchNotifications error:', e.message);
    return [];
  }
}

async function markNotifRead(notifId) {
  if (_sbUrl && isLoggedIn()) {
    try {
      await sbFetch('notifications', 'id=eq.' + notifId, {
        method: 'PATCH',
        body: { read: true },
        prefer: 'return=minimal'
      });
    } catch (e) {}
  }
  try {
    var notifs = JSON.parse(localStorage.getItem('notifications') || '[]');
    notifs = notifs.map(function(n) { return n.id == notifId ? Object.assign({}, n, { read: true }) : n; });
    localStorage.setItem('notifications', JSON.stringify(notifs));
  } catch (e) {}
  // Keep the cached list's read flags in sync so a later cache hit doesn't
  // show a notification as unread again after the user already read it.
  if (window.AppCache) {
    AppCache.updateCached('notifications_list', function(cached) {
      if (!Array.isArray(cached)) return cached;
      return cached.map(function(n) { return n.id == notifId ? Object.assign({}, n, { read: true }) : n; });
    });
  }
}

// ── Auth Helpers (Supabase-only, no localStorage) ────────────────────────────

function getCurrentUserId() {
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
    return currentUser.id;
  }
  return null;
}

function isLoggedIn() {
  if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
    return true;
  }
  return false;
}

// ── Real Likes Counts (never use stories.likes_count) ────────────────────────

// Single story — returns integer count from likes table
async function fetchLikesCount(storyId) {
  if (!_sb) return 0;
  var key = 'likescount_' + Number(storyId);
  var run = async function() {
    return _dbgTrack('likes', async function() {
      var res = await _sb
        .from('likes')
        .select('*', { count: 'exact', head: true })
        .eq('story_id', Number(storyId));
      if (res.error) { console.error('[LIKES-COUNT] error:', res.error); return 0; }
      return (res.count !== null && res.count !== undefined) ? res.count : 0;
    });
  };
  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run);
  } catch (e) {
    console.error('[LIKES-COUNT] exception:', e);
    return 0;
  }
}

// Batch — ONE query for N stories, returns { storyId: count } map
// Stories with no likes appear with count 0 (never missing from map)
async function fetchLikesCountMap(storyIds) {
  if (!_sb || !storyIds || !storyIds.length) return {};
  var ids = storyIds.map(Number).filter(Boolean);
  if (!ids.length) return {};
  var key = 'likescount_map_' + ids.slice().sort(function(a, b) { return a - b; }).join(',');
  var run = async function() {
    return _dbgTrack('likes', async function() {
      var res = await _sb
        .from('likes')
        .select('story_id')
        .in('story_id', ids);
      if (res.error) { console.error('[LIKES-COUNT-MAP] error:', res.error); return {}; }
      var map = {};
      (res.data || []).forEach(function(row) {
        var id = row.story_id;
        map[id] = (map[id] || 0) + 1;
      });
      ids.forEach(function(id) { if (!(id in map)) map[id] = 0; });
      return map;
    });
  };
  try {
    if (!window.AppCache) return await run();
    return await AppCache.cachedFetch(key, AppCache.TTL_6H, run);
  } catch (e) {
    console.error('[LIKES-COUNT-MAP] exception:', e);
    return {};
  }
}

// Patch all [data-likes-sid] badge spans in the DOM for the given countMap.
// Call after any grid/list innerHTML is set.
function patchLikesBadges(countMap) {
  Object.keys(countMap).forEach(function(sid) {
    document.querySelectorAll('[data-likes-sid="' + sid + '"]').forEach(function(span) {
      span.textContent = formatCount(countMap[sid]);
    });
  });
}

// ── Relative time helper ──────────────────────────────────────────────────────

function formatRelativeTime(ts) {
  if (!ts) return '';
  // Always parse as UTC — Supabase stores UTC but may omit the 'Z' suffix.
  // Without 'Z', JavaScript treats the string as LOCAL time, causing a ±5:30
  // offset for India users. Appending 'Z' when no timezone is present fixes this.
  var tsStr = String(ts).trim();
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(tsStr)) tsStr += 'Z';
  var diff = Math.floor((Date.now() - new Date(tsStr).getTime()) / 1000);
  if (diff < 0) diff = 0; // guard against tiny clock skew
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
