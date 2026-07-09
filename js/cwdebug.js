// ── Continue Watching Debug Panel ─────────────────────────────────────────────
// Set CW_DEBUG = true to show the on-screen panel and all debug logs.
// Set CW_DEBUG = false to hide everything — CW save/sync still works normally.
// ─────────────────────────────────────────────────────────────────────────────

var CW_DEBUG = false;

(function() {
  'use strict';

  // If debug is off, do nothing — panel is never created, hooks never set.
  // db.js already guards every _cwDbgSP / _cwDbgSPS call with typeof checks,
  // so CW save/sync continues working without any changes.
  if (!CW_DEBUG) return;

  // ── Build panel CSS ──────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#cwdbg {',
    '  position: fixed;',
    '  bottom: 80px;',
    '  left: 8px;',
    '  z-index: 99999;',
    '  width: 320px;',
    '  max-height: 80vh;',
    '  overflow-y: auto;',
    '  background: rgba(10,10,20,0.97);',
    '  color: #e0e0e0;',
    '  font-family: monospace;',
    '  font-size: 11px;',
    '  border-radius: 10px;',
    '  box-shadow: 0 4px 24px rgba(0,0,0,0.7);',
    '  border: 1px solid #444;',
    '}',
    '#cwdbg-hdr {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  padding: 8px 10px;',
    '  background: #1a1a2e;',
    '  border-radius: 10px 10px 0 0;',
    '  font-size: 12px;',
    '  font-weight: bold;',
    '  letter-spacing: .5px;',
    '  cursor: pointer;',
    '  user-select: none;',
    '}',
    '#cwdbg-hdr .cwdbg-title { color: #a78bfa; }',
    '#cwdbg-hdr button {',
    '  background: transparent;',
    '  border: none;',
    '  color: #aaa;',
    '  font-size: 14px;',
    '  cursor: pointer;',
    '  padding: 0 4px;',
    '}',
    '#cwdbg-body { padding: 8px 10px; }',
    '.cwdbg-row {',
    '  display: flex;',
    '  justify-content: space-between;',
    '  padding: 3px 0;',
    '  border-bottom: 1px solid #222;',
    '}',
    '.cwdbg-label { color: #888; white-space: nowrap; margin-right: 6px; }',
    '.cwdbg-val { color: #fff; text-align: right; word-break: break-all; }',
    '.cwdbg-val.ok  { color: #4ade80; }',
    '.cwdbg-val.err { color: #f87171; }',
    '.cwdbg-val.dim { color: #888; }',
    '.cwdbg-section {',
    '  margin-top: 6px;',
    '  font-size: 10px;',
    '  color: #a78bfa;',
    '  text-transform: uppercase;',
    '  letter-spacing: .5px;',
    '}',
    '#cwdbg-payload, #cwdbg-response, #cwdbg-error {',
    '  white-space: pre-wrap;',
    '  word-break: break-all;',
    '  background: #111;',
    '  border-radius: 4px;',
    '  padding: 5px 6px;',
    '  margin: 3px 0 6px;',
    '  font-size: 10px;',
    '  max-height: 90px;',
    '  overflow-y: auto;',
    '  color: #d4d4d4;',
    '}',
    '#cwdbg-error { color: #f87171; }',
    '#cwdbg-test-btn {',
    '  width: 100%;',
    '  margin-top: 8px;',
    '  padding: 9px 0;',
    '  background: #7c3aed;',
    '  color: #fff;',
    '  border: none;',
    '  border-radius: 6px;',
    '  font-size: 12px;',
    '  font-weight: bold;',
    '  cursor: pointer;',
    '  letter-spacing: .5px;',
    '}',
    '#cwdbg-test-btn:active { background: #5b21b6; }',
    '#cwdbg-test-result {',
    '  margin-top: 6px;',
    '  padding: 6px 8px;',
    '  border-radius: 4px;',
    '  font-size: 11px;',
    '  display: none;',
    '  word-break: break-all;',
    '  white-space: pre-wrap;',
    '}',
    '#cwdbg-test-result.ok  { background:#052e16; color:#4ade80; display:block; }',
    '#cwdbg-test-result.err { background:#2d0000; color:#f87171; display:block; }',
    '#cwdbg.collapsed #cwdbg-body { display: none; }'
  ].join('\n');
  document.head.appendChild(style);

  // ── Build panel HTML ─────────────────────────────────────────────────────────
  var panel = document.createElement('div');
  panel.id = 'cwdbg';
  panel.innerHTML = [
    '<div id="cwdbg-hdr" onclick="cwDbgToggle()">',
    '  <span class="cwdbg-title">🔍 CW Debug Panel</span>',
    '  <button id="cwdbg-toggle-btn">▾</button>',
    '</div>',
    '<div id="cwdbg-body">',

    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">UUID</span>',
    '    <span class="cwdbg-val dim" id="cbd-uuid">— not logged in —</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">story_id</span>',
    '    <span class="cwdbg-val dim" id="cbd-story">—</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">episode_number</span>',
    '    <span class="cwdbg-val dim" id="cbd-ep">—</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">position (s)</span>',
    '    <span class="cwdbg-val dim" id="cbd-pos">—</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">progress %</span>',
    '    <span class="cwdbg-val dim" id="cbd-pct">—</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">saveProgress() called</span>',
    '    <span class="cwdbg-val dim" id="cbd-sp">not yet</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">saveToSupabase() called</span>',
    '    <span class="cwdbg-val dim" id="cbd-sps">not yet</span>',
    '  </div>',
    '  <div class="cwdbg-row">',
    '    <span class="cwdbg-label">Last result</span>',
    '    <span class="cwdbg-val dim" id="cbd-result">—</span>',
    '  </div>',

    '  <div class="cwdbg-section">Payload sent to Supabase</div>',
    '  <pre id="cwdbg-payload">—</pre>',

    '  <div class="cwdbg-section">Supabase response</div>',
    '  <pre id="cwdbg-response">—</pre>',

    '  <div class="cwdbg-section">Error</div>',
    '  <pre id="cwdbg-error">none</pre>',

    '  <button id="cwdbg-test-btn" onclick="cwTestSaveNow()">🧪 TEST SAVE NOW</button>',
    '  <div id="cwdbg-test-result"></div>',

    '</div>'
  ].join('');
  document.body.appendChild(panel);

  // ── Toggle collapse ──────────────────────────────────────────────────────────
  window.cwDbgToggle = function() {
    var p   = document.getElementById('cwdbg');
    var btn = document.getElementById('cwdbg-toggle-btn');
    if (p.classList.contains('collapsed')) {
      p.classList.remove('collapsed');
      btn.textContent = '▾';
    } else {
      p.classList.add('collapsed');
      btn.textContent = '▸';
    }
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _set(id, val, cls) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.className = 'cwdbg-val' + (cls ? ' ' + cls : '');
  }

  function _setPre(id, obj) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = (obj === null || obj === undefined) ? '—'
      : (typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  }

  // ── Poll UUID every 2s ───────────────────────────────────────────────────────
  function _pollUUID() {
    var uid = '—';
    if (typeof currentUser !== 'undefined' && currentUser && currentUser.id) {
      uid = currentUser.id;
    }
    _set('cbd-uuid', uid, uid === '—' ? 'err' : 'ok');
    setTimeout(_pollUUID, 2000);
  }
  _pollUUID();

  // ── Hook: saveProgress() called ──────────────────────────────────────────────
  window._cwDbgSP = function(storyId, episodeId, episodeNumber, currentTime, duration) {
    var pct = duration > 0 ? Math.min(Math.round((currentTime / duration) * 100), 100) : 0;
    var ts  = new Date().toLocaleTimeString();
    _set('cbd-story', String(storyId), 'ok');
    _set('cbd-ep',    String(episodeNumber || '—'), 'ok');
    _set('cbd-pos',   Math.round(currentTime) + 's', 'ok');
    _set('cbd-pct',   pct + '%', 'ok');
    _set('cbd-sp',    '✅ YES — ' + ts, 'ok');
  };

  // ── Hook: saveProgressToSupabase() phases ────────────────────────────────────
  window._cwDbgSPS = function(phase, data) {
    var ts = new Date().toLocaleTimeString();

    if (phase === 'skip') {
      _set('cbd-sps',    '⛔ SKIPPED — ' + ts, 'err');
      _set('cbd-result', '⛔ ' + (data.reason || 'skipped'), 'err');
      _setPre('cwdbg-error', data.reason || 'skipped');
      return;
    }
    if (phase === 'uuid') {
      _set('cbd-uuid', data.userId, 'ok');
    }
    if (phase === 'sending') {
      _set('cbd-sps', '📤 SENDING — ' + ts, 'ok');
      _setPre('cwdbg-payload', data.payload);
      _setPre('cwdbg-response', '⏳ waiting…');
      _setPre('cwdbg-error', 'none');
    }
    if (phase === 'success') {
      _set('cbd-sps',    '✅ SUCCESS — ' + ts, 'ok');
      _set('cbd-result', '✅ UPSERT OK', 'ok');
      _setPre('cwdbg-response', data.response || 'ok (no body)');
      _setPre('cwdbg-error', 'none');
    }
    if (phase === 'error') {
      _set('cbd-sps',    '❌ ERROR — ' + ts, 'err');
      _set('cbd-result', '❌ UPSERT FAILED', 'err');
      _setPre('cwdbg-response', data.response || null);
      _setPre('cwdbg-error', JSON.stringify(data.error, null, 2));
    }
    if (phase === 'exception') {
      _set('cbd-sps',    '💥 EXCEPTION — ' + ts, 'err');
      _set('cbd-result', '💥 EXCEPTION', 'err');
      _setPre('cwdbg-error', data.message || String(data));
    }
  };

  // ── TEST SAVE NOW ────────────────────────────────────────────────────────────
  window.cwTestSaveNow = async function() {
    var btn    = document.getElementById('cwdbg-test-btn');
    var result = document.getElementById('cwdbg-test-result');
    btn.textContent = '⏳ Testing…';
    btn.disabled = true;
    result.className = '';
    result.textContent = '';

    try {
      if (typeof _sb === 'undefined' || !_sb) {
        throw new Error('_sb Supabase client is undefined — db.js not loaded or initSupabase() not called');
      }

      var sessionRes = await _sb.auth.getSession();
      var session = sessionRes && sessionRes.data && sessionRes.data.session;
      if (!session || !session.user || !session.user.id) {
        throw new Error('No active session. User not logged in.\nSession data: ' + JSON.stringify(sessionRes && sessionRes.data));
      }
      var userId = session.user.id;

      var storyId = (typeof currentStory !== 'undefined' && currentStory && currentStory.id)
        ? currentStory.id : 'test-story-debug';
      var epId = (typeof currentEpisode !== 'undefined' && currentEpisode && currentEpisode.id)
        ? currentEpisode.id : 'test-ep-debug';
      var epNum = (typeof currentEpisode !== 'undefined' && currentEpisode && currentEpisode.episode_number)
        ? currentEpisode.episode_number : 1;
      var m   = (typeof getActiveMedia === 'function') ? getActiveMedia() : null;
      var pos = m ? Math.round(m.currentTime) : 0;
      var dur = m ? Math.round(m.duration || 0) : 0;
      var pct = dur > 0 ? Math.min(Math.round((pos / dur) * 100), 100) : 0;

      var row = {
        user_id:           userId,
        story_id:          String(storyId),
        episode_id:        String(epId),
        episode_number:    epNum,
        playback_position: pos,
        progress_percent:  pct,
        duration:          dur,
        updated_at:        new Date().toISOString()
      };

      _setPre('cwdbg-payload', row);
      _setPre('cwdbg-response', '⏳ waiting…');
      _setPre('cwdbg-error', 'none');

      var res = await _sb
        .from('continue_watching')
        .upsert(row, { onConflict: 'user_id,story_id' });

      if (res.error) {
        var errObj = {
          code:    res.error.code,
          message: res.error.message,
          details: res.error.details,
          hint:    res.error.hint,
          status:  res.status
        };
        _setPre('cwdbg-response', { status: res.status });
        _setPre('cwdbg-error', errObj);
        result.className = 'err';
        result.textContent = '❌ UPSERT FAILED\n' + JSON.stringify(errObj, null, 2);
      } else {
        _setPre('cwdbg-response', 'SUCCESS — no error (status 2xx)');
        _setPre('cwdbg-error', 'none');
        result.className = 'ok';
        result.textContent = '✅ UPSERT SUCCESS\n\nPayload written:\n' + JSON.stringify(row, null, 2);
      }
    } catch (e) {
      _setPre('cwdbg-error', e.message);
      result.className = 'err';
      result.textContent = '💥 EXCEPTION\n' + e.message;
    } finally {
      btn.textContent = '🧪 TEST SAVE NOW';
      btn.disabled = false;
    }
  };

})();
