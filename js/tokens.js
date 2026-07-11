// ════════════════════════════════════════════════════════════════════════
// Emperor FM — Play Token Engine
// • Server time ONLY via Supabase Date response header (never device clock)
// • Background sync every 5 min + on foreground + on boot
// • Pre-playback check blocks BEFORE audio starts when tokens = 0
// • Deduction at 50% — one token per episode, replay-proof
// • Realtime subscription keeps all open sessions in sync
// ════════════════════════════════════════════════════════════════════════

// ── Module state ──────────────────────────────────────────────────────────────
var _tokenChannel     = null;   // Supabase Realtime channel
var _tokenDeducting   = false;  // Guards concurrent deduction calls
var _lastKnownTokens  = null;   // Latest token row — kept fresh by engine
var _cacheTimestamp   = 0;      // ms since epoch when cache was last populated
var _engineTimer      = null;   // setInterval handle for background sync
var _policyPollTimer  = null;   // setInterval handle for policy-page refresh
var _tokenUICallbacks = [];     // Display callbacks registered by policy page

// ── Internal: push fresh data to all UI callbacks ─────────────────────────────
function _notifyTokenUI(data) {
  if (!data) return;
  _lastKnownTokens = data;
  _cacheTimestamp  = Date.now();
  _tokenUICallbacks.forEach(function(cb) { try { cb(data); } catch (e) {} });
}

// ── Internal: fetch the play_limits row + server time in ONE request ──────────
// Previously two parallel fetches (_getServerTime + _fetchRow) were made; both
// hit the same endpoint. This consolidates them into a single REST call.
// Returns { row, serverTime } — serverTime is from the Date response header.
async function _fetchRowAndTime() {
  if (!_sbUrl || !_sbKey) return { row: null, serverTime: new Date() };
  var r = await fetch(_sbUrl + '/rest/v1/play_limits?id=eq.1&limit=1', {
    headers: {
      'apikey': _sbKey,
      'Authorization': 'Bearer ' + _sbKey,
      'Accept': 'application/json'
    }
  });
  if (!r.ok) throw new Error('fetch failed: HTTP ' + r.status);
  // Server time from Date header — same source the old _getServerTime used.
  var serverTime = new Date();
  var d = r.headers.get('date') || r.headers.get('Date');
  if (d) { var t = new Date(d); if (!isNaN(t.getTime())) serverTime = t; }
  var rows = await r.json();
  if (!rows || !rows.length) throw new Error('play_limits row not found — run SQL setup');
  return { row: rows[0], serverTime: serverTime };
}

// ── Internal: PATCH play_limits — returns updated row ─────────────────────────
async function _patchRow(filter, body) {
  var r = await fetch(_sbUrl + '/rest/v1/play_limits?' + filter, {
    method: 'PATCH',
    headers: {
      'apikey': _sbKey,
      'Authorization': 'Bearer ' + _sbKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    var err = await r.json().catch(function() { return {}; });
    var e = new Error(err.message || err.hint || ('PATCH HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  var data = await r.json();
  // return=representation gives back an array of updated rows
  var row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

// ── IST helpers ───────────────────────────────────────────────────────────────
// All scheduling (reset, refill window) runs in Asia/Kolkata time (UTC+5:30).
// Device timezone is NEVER used — only the Supabase server UTC Date header.

var _IST_OFFSET_MS = 5.5 * 3600000; // +05:30 in milliseconds

// Convert a UTC Date into an "IST Date" where getUTCHours() returns the IST hour.
function _toIST(utcDate) {
  return new Date(utcDate.getTime() + _IST_OFFSET_MS);
}

// Return the IST midnight of the given UTC date, expressed as a real UTC timestamp.
// E.g.  IST midnight of "IST 2026-05-12"  →  UTC 2026-05-11 18:30:00
function _istMidnightUTC(utcDate) {
  var ist = _toIST(utcDate);
  // Zero out the time portion in the IST frame
  var istMidnightMs = utcDate.getTime() + _IST_OFFSET_MS
    - (ist.getUTCHours()   * 3600000)
    - (ist.getUTCMinutes() *   60000)
    - (ist.getUTCSeconds() *    1000)
    - ist.getUTCMilliseconds();
  // Convert back to real UTC
  return new Date(istMidnightMs - _IST_OFFSET_MS);
}

// Return the IST calendar date as "YYYY-MM-DD" for a given UTC timestamp.
// Used for day-boundary comparison — never for display.
function _istDateStr(utcDate) {
  var ist = _toIST(utcDate);
  var y = ist.getUTCFullYear();
  var m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  var d = String(ist.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

// Return a UTC timestamp that represents the START of the current IST hour.
// E.g.  IST 05:18 → IST 05:00:00 → UTC 23:30 (prev day)
function _istHourStartUTC(utcDate) {
  var ist = _toIST(utcDate);
  var istHourMs = utcDate.getTime() + _IST_OFFSET_MS
    - (ist.getUTCMinutes() * 60000)
    - (ist.getUTCSeconds() *  1000)
    - ist.getUTCMilliseconds();
  return new Date(istHourMs - _IST_OFFSET_MS);
}

// ── Core sync: fetch + apply refill/reset + persist ───────────────────────────
// Returns the latest play_limits row, or null on failure.
// Side-effects: persists any pending refill/reset to Supabase, notifies UI.
async function fetchAndSyncTokens() {
  if (!_sbUrl || !_sbKey) return null;
  try {
    // Single request for both server time (Date header) and the play_limits row
    var fetched    = await _fetchRowAndTime();
    var serverTime = fetched.serverTime;  // UTC timestamp from Supabase Date header
    var pl         = fetched.row;

    // ── Convert server UTC → IST for ALL scheduling decisions ─────────────
    var istTime = _toIST(serverTime);
    var istHour = istTime.getUTCHours(); // 0-23 in IST

    var updates = {};
    var changed = false;

    console.log('[ENGINE] Server UTC:', serverTime.toISOString(),
      '| IST hour:', istHour,
      '| available:', pl.available_tokens,
      '| used_today:', pl.used_today);

    // ── 1. Daily reset — IST calendar day comparison ─────────────────────────
    // Reset fires when:
    //   • The IST calendar date of last_reset ≠ today's IST date  (new day)
    //   • AND current IST hour ≥ 4  (4 AM IST gate)
    //
    // This is strictly date-based — no "20 h elapsed" approximation.
    // After reset, tokens are zeroed and last_refill is set to IST 3 AM today
    // so the refill step below counts every IST hour from 4 AM onward.
    var todayIST     = _istDateStr(serverTime);
    var lastResetIST = _istDateStr(new Date(pl.last_reset));
    var isNewISTDay  = todayIST !== lastResetIST;

    console.log('[ENGINE] IST day check — today:', todayIST,
      '| last_reset IST day:', lastResetIST,
      '| isNewDay:', isNewISTDay, '| istHour:', istHour);

    if (isNewISTDay && istHour >= 4) {
      // IST 3 AM of today as real UTC — one hour before 4 AM window opens.
      // The refill step counts: floor((now − IST_3AM) / 1h) missed hours.
      // E.g. app opened at IST 8:18 AM → 5 missed hours → 5 × 222 = 1110 tokens.
      var resetRefillBase = new Date(_istMidnightUTC(serverTime).getTime() + 3 * 3600000);

      updates.used_today       = 0;
      updates.available_tokens = 0;
      updates.last_reset       = serverTime.toISOString();
      updates.last_refill      = resetRefillBase.toISOString();

      // Apply locally so the refill step below reads these zeroed values
      pl.used_today       = 0;
      pl.available_tokens = 0;
      pl.last_refill      = updates.last_refill;
      changed = true;
      console.log('[ENGINE] Daily reset applied — IST', todayIST,
        'hour', istHour, '| refill base (IST 3 AM):', resetRefillBase.toISOString());
    }

    // ── 2. Hourly refill — IST 4 AM to IST 10 PM (hours 4–22 inclusive) ────
    // 10 PM (hour 22) gets the last refill. 11 PM–3 AM: no refill (night freeze).
    // Tokens carry forward; never exceed total_daily_limit - used_today.
    if (istHour >= 4 && istHour <= 22) {
      var lastRefillTime = new Date(pl.last_refill);
      var hoursMissed    = Math.floor((serverTime - lastRefillTime) / 3600000);

      if (hoursMissed >= 1) {
        var refillPerHour = pl.hourly_refill     || 222;
        var dailyLimit    = pl.total_daily_limit || 4000;
        var usedNow       = (updates.used_today !== undefined)
                              ? updates.used_today : pl.used_today;
        var budget        = Math.max(dailyLimit - usedNow, 0);
        var tokensToAdd   = refillPerHour * hoursMissed;
        var currentHeld   = (updates.available_tokens !== undefined)
                              ? updates.available_tokens : pl.available_tokens;
        var newTokens     = Math.min(currentHeld + tokensToAdd, budget);

        // Snap last_refill to start of the current IST hour (as real UTC ts)
        // so the next sync counts from the correct IST hour boundary.
        var refillHourTs = _istHourStartUTC(serverTime);

        updates.available_tokens = newTokens;
        updates.last_refill      = refillHourTs.toISOString();
        pl.available_tokens      = newTokens;
        changed = true;
        console.log('[ENGINE] Hourly refill: +' + tokensToAdd +
          ' (' + hoursMissed + ' IST hr missed) → ' + newTokens + ' tokens');
      }
    }

    // ── 3. Persist any changes to Supabase ────────────────────────────────────
    if (changed) {
      try {
        var patched = await _patchRow('id=eq.1', updates);
        if (patched && patched.available_tokens !== undefined) {
          pl = patched; // Use DB-returned row as ground truth
        } else {
          Object.assign(pl, updates);
        }
        console.log('[ENGINE] Sync saved — available:', pl.available_tokens,
          '| used_today:', pl.used_today);
      } catch (pe) {
        console.warn('[ENGINE] Sync PATCH failed (' + pe.status + '):', pe.message);
        if (pe.status === 403 || pe.status === 401) {
          console.error('[ENGINE] UPDATE permission denied — run supabase_play_tokens_setup.sql');
        }
        Object.assign(pl, updates);
      }
    }

    _notifyTokenUI(pl);
    return pl;

  } catch (e) {
    console.error('[ENGINE] fetchAndSyncTokens error:', e.message);
    return null;
  }
}

// Legacy alias
async function fetchPlayTokens() { return fetchAndSyncTokens(); }

// ── Pre-playback token check (NO deduction) ───────────────────────────────────
// Called BEFORE audio starts. Uses cache if < 2 minutes old; fetches if stale.
// Returns: 'ok' | 'hourly_limit' | 'daily_limit'
async function checkPlayAllowed() {
  if (!_sbUrl || !_sbKey) return 'ok';

  var cacheAgeMs = Date.now() - _cacheTimestamp;
  var pl = _lastKnownTokens;

  // Fetch fresh data if cache is missing or stale (> 2 minutes)
  if (!pl || cacheAgeMs > 120000) {
    pl = await fetchAndSyncTokens();
  }

  if (!pl) return 'ok'; // Can't reach DB — give benefit of doubt

  console.log('[ENGINE] pre-check — available:', pl.available_tokens,
    '| used_today:', pl.used_today, '/', pl.total_daily_limit);

  if (pl.used_today >= (pl.total_daily_limit || 4000)) return 'daily_limit';
  if (pl.available_tokens <= 0)                         return 'hourly_limit';
  return 'ok';
}

// ── Deduct 1 token at 50% playback ────────────────────────────────────────────
// Returns: 'ok' | 'hourly_limit' | 'daily_limit'
// NEVER silently allows play when limits are confirmed hit.
async function deductPlayToken() {
  if (!_sbUrl || !_sbKey) return 'ok';
  if (_tokenDeducting) {
    // Another deduction is in progress — use cached state to decide
    if (_lastKnownTokens) {
      if (_lastKnownTokens.used_today >= (_lastKnownTokens.total_daily_limit || 4000))
        return 'daily_limit';
      if (_lastKnownTokens.available_tokens <= 0)
        return 'hourly_limit';
    }
    return 'ok';
  }
  _tokenDeducting = true;

  try {
    // Use cache whenever it exists and is < 5 min old (the background engine
    // period). checkPlayAllowed() already refreshes at < 2 min staleness, so by
    // the time deductPlayToken fires at 50% the cache is virtually always hot.
    // Fetching again would duplicate the pre-play round-trip for no benefit —
    // the atomic PATCH (available_tokens=gte.1) enforces the limit server-side
    // regardless of what the cached row says.
    var cacheAgeMs = Date.now() - _cacheTimestamp;
    var pl = (_lastKnownTokens && cacheAgeMs < 300000)
      ? _lastKnownTokens
      : await fetchAndSyncTokens();

    if (!pl) {
      // DB unreachable — use cached state if available
      if (_lastKnownTokens) {
        pl = _lastKnownTokens;
      } else {
        // No cached state either — allow play (benefit of doubt)
        _tokenDeducting = false;
        return 'ok';
      }
    }

    console.log('[ENGINE] deduct check — available:', pl.available_tokens,
      '| used_today:', pl.used_today, '/', pl.total_daily_limit);

    // ── Check daily limit ──
    if (pl.used_today >= (pl.total_daily_limit || 4000)) {
      // ── Analytics: token_blocked ────────────────────────────────────────
      logAnalyticsEvent('token_blocked', { reason: 'daily_limit', used_today: pl.used_today });
      // ────────────────────────────────────────────────────────────────────
      _tokenDeducting = false;
      return 'daily_limit';
    }

    // ── Check hourly tokens ──
    if (pl.available_tokens <= 0) {
      // ── Analytics: token_blocked ────────────────────────────────────────
      logAnalyticsEvent('token_blocked', { reason: 'hourly_limit', available_tokens: pl.available_tokens });
      // ────────────────────────────────────────────────────────────────────
      _tokenDeducting = false;
      return 'hourly_limit';
    }

    // ── Deduct — PATCH only succeeds if DB still has available_tokens >= 1 ──
    var newAvail = pl.available_tokens - 1;
    var newUsed  = pl.used_today + 1;

    try {
      var patched = await _patchRow(
        'id=eq.1&available_tokens=gte.1',
        { available_tokens: newAvail, used_today: newUsed }
      );

      if (!patched) {
        // PATCH matched 0 rows — another user grabbed the last token simultaneously
        console.log('[ENGINE] PATCH matched 0 rows — concurrent deduction race');
        _tokenDeducting = false;
        return 'hourly_limit';
      }

      // Use DB-returned values as authoritative state
      var freshData = (patched.available_tokens !== undefined)
        ? patched
        : Object.assign({}, pl, { available_tokens: newAvail, used_today: newUsed });

      _notifyTokenUI(freshData);
      console.log('[ENGINE] Token deducted ✓ — available now:', freshData.available_tokens);
      // ── Analytics: token_deducted ─────────────────────────────────────────
      logAnalyticsEvent('token_deducted', {
        available_after: freshData.available_tokens,
        used_today:      freshData.used_today || 0
      });
      // ─────────────────────────────────────────────────────────────────────
      _tokenDeducting = false;
      return 'ok';

    } catch (pe) {
      console.warn('[ENGINE] Deduct PATCH failed (' + pe.status + '):', pe.message);
      _tokenDeducting = false;

      if (pe.status === 403 || pe.status === 401) {
        // No UPDATE permission — remind to run SQL; don't block play
        console.error('[ENGINE] No UPDATE permission — run supabase_play_tokens_setup.sql');
        return 'ok';
      }
      // Other errors: block play to be safe (better than phantom free plays)
      return 'hourly_limit';
    }

  } catch (e) {
    console.error('[ENGINE] deductPlayToken exception:', e.message);
    _tokenDeducting = false;
    // If we have cached state showing 0 tokens — still block
    if (_lastKnownTokens) {
      if (_lastKnownTokens.available_tokens <= 0) return 'hourly_limit';
      if (_lastKnownTokens.used_today >= (_lastKnownTokens.total_daily_limit || 4000))
        return 'daily_limit';
    }
    return 'ok';
  }
}

// ── Background Token Engine ────────────────────────────────────────────────────
// Started ONCE at app boot. Keeps token state always fresh.
//   • Syncs immediately on start
//   • Syncs every 5 minutes automatically
//   • Re-syncs when the app returns to foreground
//   • Starts the Realtime subscription
var _engineStarted = false;

function startTokenEngine() {
  if (_engineStarted) return;
  _engineStarted = true;

  console.log('[ENGINE] Starting token engine…');

  // 1. Initial sync (apply any pending refill/reset from overnight etc.)
  fetchAndSyncTokens().then(function(data) {
    if (data) console.log('[ENGINE] Boot sync complete — available:', data.available_tokens);
    else      console.warn('[ENGINE] Boot sync returned null — play_limits table may not exist');
  });

  // 2. Periodic background sync every 5 minutes
  if (_engineTimer) clearInterval(_engineTimer);
  _engineTimer = setInterval(function() {
    console.log('[ENGINE] Periodic sync…');
    fetchAndSyncTokens();
  }, 20 * 60 * 1000);

  // 3. Sync when app returns to foreground after being backgrounded
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      var staleMs = Date.now() - _cacheTimestamp;
      if (staleMs > 60000) { // Only re-fetch if cache is > 1 minute old
        console.log('[ENGINE] Foreground — cache stale ' + Math.round(staleMs/1000) + 's, syncing…');
        fetchAndSyncTokens();
      }
    }
  });

  // 4. Start Realtime subscription
  startTokenRealtimeGlobal();
}

// Kept for backward compat (called directly from app.js boot)
function startTokenRealtimeGlobal() {
  if (!_sb) {
    console.warn('[ENGINE] Supabase JS client not available — Realtime disabled');
    return;
  }
  if (_tokenChannel) {
    try { _sb.removeChannel(_tokenChannel); } catch (e) {}
    _tokenChannel = null;
  }

  _tokenChannel = _sb
    .channel('global-play-limits')
    .on('postgres_changes', {
      event:  'UPDATE',
      schema: 'public',
      table:  'play_limits'
    }, function(payload) {
      if (!payload.new) return;
      console.log('[ENGINE] Realtime UPDATE — available:', payload.new.available_tokens);
      _notifyTokenUI(payload.new);
    })
    .subscribe(function(status, err) {
      if (status === 'SUBSCRIBED') {
        console.log('[ENGINE] Realtime channel live ✓');
      } else if (err) {
        console.warn('[ENGINE] Realtime error:', err.message);
      } else {
        console.log('[ENGINE] Realtime status:', status);
      }
    });
}

// Legacy wrapper — no longer needed but kept so old call sites compile
function subscribePlayTokens(callback) {
  if (typeof callback === 'function' && _tokenUICallbacks.indexOf(callback) === -1) {
    _tokenUICallbacks.push(callback);
  }
}

// ── Policy Page lifecycle ──────────────────────────────────────────────────────

async function initPolicyPage() {
  // Show loading (or cached value) immediately — no blank flash
  if (_lastKnownTokens) {
    updatePolicyTokenDisplay(_lastKnownTokens);
  } else {
    updatePolicyTokenDisplay(null);
  }

  // Register display callback (de-duped)
  if (_tokenUICallbacks.indexOf(updatePolicyTokenDisplay) === -1) {
    _tokenUICallbacks.push(updatePolicyTokenDisplay);
  }

  // Fresh sync applies any pending refill/reset immediately
  var data = await fetchAndSyncTokens();
  if (data) updatePolicyTokenDisplay(data);

  // Polling fallback every 15 s while policy page is visible
  // Covers the edge case where Supabase Realtime isn't enabled yet
  cleanupPolicyPagePolling();
  _policyPollTimer = setInterval(async function() {
    if (window.currentPage !== 'policy') { cleanupPolicyPagePolling(); return; }
    var fresh = await fetchAndSyncTokens();
    if (fresh) updatePolicyTokenDisplay(fresh);
  }, 60000);
}

function cleanupPolicyPage() {
  _tokenUICallbacks = _tokenUICallbacks.filter(function(cb) {
    return cb !== updatePolicyTokenDisplay;
  });
  cleanupPolicyPagePolling();
}

function cleanupPolicyPagePolling() {
  if (_policyPollTimer) { clearInterval(_policyPollTimer); _policyPollTimer = null; }
}

// ── Token count display ────────────────────────────────────────────────────────

function updatePolicyTokenDisplay(data) {
  var numEl    = document.getElementById('policy-token-count');
  var statusEl = document.getElementById('policy-token-status');
  if (!numEl) return;

  if (!data) {
    numEl.textContent = '—';
    numEl.className   = 'policy-token-count';
    if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.className = 'policy-token-status'; }
    return;
  }

  var tokens    = (data.available_tokens  !== undefined) ? data.available_tokens  : 0;
  var usedToday = (data.used_today        !== undefined) ? data.used_today        : 0;
  var dailyMax  = (data.total_daily_limit !== undefined) ? data.total_daily_limit : 4000;

  // Flash animation when the number changes
  if (numEl.textContent !== String(tokens)) {
    numEl.classList.remove('token-flash');
    void numEl.offsetWidth; // Force reflow to restart animation
    numEl.classList.add('token-flash');
  }
  numEl.textContent = tokens;

  if (!statusEl) return;

  if (usedToday >= dailyMax) {
    statusEl.textContent = 'Daily server limit reached. Resets at 4 AM tomorrow.';
    statusEl.className   = 'policy-token-status status-empty';
    numEl.className      = 'policy-token-count count-empty';
  } else if (tokens <= 0) {
    statusEl.textContent = 'Hourly server limit reached. Please try again next hour.';
    statusEl.className   = 'policy-token-status status-empty';
    numEl.className      = 'policy-token-count count-empty';
  } else {
    statusEl.textContent = 'Live · Tokens available · +' + (data.hourly_refill || 222) +
      ' per hour (4 AM – 10 PM server time)';
    statusEl.className   = 'policy-token-status status-active';
    numEl.className      = 'policy-token-count count-active';
  }
}
