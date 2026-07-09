// Player Module — Audio + Video + HLS
var audio = null;
var playerVideo = null;
var hlsInstance = null;

var currentStory = null;
var currentEpisode = null;
var currentEpisodes = [];
var currentEpisodeIdx = 0;
var currentSpeed = 1;
var viewCounted = false;
var tokenDeducted = false; // Separate flag — resets only on new episode, never on pause/resume
var isVideoMode = false;

// ── Continue Watching: milestone-based saves ──────────────────────────────────
// Saves at 10 %, 50 %, and 90 % of episode duration (checked in onTimeUpdate).
// Replaces the old 15-second polling interval which sent up to 4× as many
// upsert requests per episode as needed. Full saves on pause/end/close are kept.
var _cwMilestonesHit = {}; // e.g. { 10: true, 50: true, 90: true }

function _resetCWMilestones() {
  _cwMilestonesHit = {};
}

function _saveCWNow(trigger) {
  if (!currentStory || !currentEpisode) return;
  var m = getActiveMedia();
  if (!m) return;
  var epNum = currentEpisode.episode_number || (currentEpisodeIdx + 1);
  var pos   = m.currentTime  || 0;
  var dur   = m.duration     || currentEpisode.duration || 0;
  console.log('[CW] Auto-save trigger:', trigger,
    '| story:', currentStory.id,
    '| ep:', epNum,
    '| pos:', Math.round(pos) + 's',
    '| dur:', Math.round(dur) + 's');
  saveProgress(currentStory.id, currentEpisode.id, epNum, pos, dur);
}

// Save on page close / APK background
function _onCWPageHide()       { _saveCWNow('pagehide');       }
function _onCWVisibility()     { if (document.hidden) _saveCWNow('visibilitychange-hidden'); }
function _onCWBeforeUnload()   { _saveCWNow('beforeunload');   }

window.addEventListener('pagehide',         _onCWPageHide,     { passive: true });
window.addEventListener('beforeunload',     _onCWBeforeUnload, { passive: true });
document.addEventListener('visibilitychange', _onCWVisibility, { passive: true });
// ─────────────────────────────────────────────────────────────────────────────

// Episode Batch state
var _epTotalCount    = 0;     // total episodes in the current story (from count query)
var EP_BATCH_SIZE    = 10;   // episodes per API request — must match EP_BATCH_LIMIT in db.js
var _epBatchOffset   = 0;    // row offset for the next API batch fetch
var _epFetchingBatch = false; // prevents concurrent API batch fetches
var _epAllFetched    = false; // true once all batches have been loaded from the API

// Episode List render state
var _epListAnchorIdx   = -1;   // currentEpisodeIdx when list was last rebuilt
var _epListLoadingMore = false; // guard against concurrent infinite-scroll triggers
var _epScrollObserver  = null;  // IntersectionObserver watching the bottom sentinel div

// Two-way scroll state
var _epStartOffset    = 0;     // row offset of currentEpisodes[0] in the story
var _epTopAllFetched  = true;  // true when currentEpisodes[0] is episode #1 (nothing above)
var _epTopObserver    = null;  // IntersectionObserver watching the top sentinel div
var _epTopLoadingMore = false; // guard against concurrent upward fetches
var _epListBuilt      = false; // true once the list DOM has been fully built for current session
// Pending setTimeout handles — cancelled when observers are destroyed so a queued
// timer can never fire after the observers have been disconnected (e.g. during jump).
var _epBottomLoadTimer = null;
var _epTopLoadTimer    = null;

// Browse-mode buffer — used ONLY by jumpToEpisode when the target batch does NOT
// contain the currently playing episode.  The main playback state (currentEpisodes,
// currentEpisodeIdx) is left completely untouched so Next/Prev/autoplay keep working.
var _epBrowseBatch  = null;  // non-null = list is showing this batch instead of currentEpisodes
var _epBrowseOffset = 0;     // row offset of _epBrowseBatch[0] in the story

// Expose to window so app.js can read them (guard against redefine on hot-reload)
function _defineProp(name, getter) {
  try {
    if (!Object.getOwnPropertyDescriptor(window, name)) {
      Object.defineProperty(window, name, { get: getter, configurable: true });
    }
  } catch (e) {}
}
_defineProp('currentStory', function() { return currentStory; });
_defineProp('isVideoMode',  function() { return isVideoMode; });
_defineProp('playerVideo',  function() { return playerVideo; });

// ── Media Type Detection ──────────────────────────────────────────────────────

function getMediaType(url) {
  if (!url) return 'audio';
  var u = url.toLowerCase().split('?')[0];
  if (u.endsWith('.m3u8')) return 'hls';
  if (u.endsWith('.mp4') || u.endsWith('.webm') || u.endsWith('.ogg') && u.indexOf('video') >= 0) return 'video';
  return 'audio';
}

// ── Initialize ────────────────────────────────────────────────────────────────

function initPlayer() {
  audio = document.getElementById('audio-element');
  playerVideo = document.getElementById('player-video');

  if (!audio) { console.error('Audio element not found'); return; }

  var savedSpeed = parseFloat(localStorage.getItem('playback_speed') || '1');
  setSpeed(savedSpeed, false);

  var seek = document.getElementById('player-seek');
  if (seek) {
    seek.addEventListener('input', function() {
      var dur = getCurrentMediaDuration();
      if (dur) {
        var newTime = (seek.value / 100) * dur;
        setCurrentMediaTime(newTime);
      }
    });
  }

  document.querySelectorAll('.speed-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      setSpeed(parseFloat(btn.dataset.speed));
    });
  });

  // Audio events
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('loadedmetadata', onMetadata);
  audio.addEventListener('error', function(e) {
    console.log('Audio error:', e.message || 'unknown');
  });

  // Video events
  if (playerVideo) {
    playerVideo.addEventListener('timeupdate', onTimeUpdate);
    playerVideo.addEventListener('ended', onEnded);
    playerVideo.addEventListener('play', onPlay);
    playerVideo.addEventListener('pause', onPause);
    playerVideo.addEventListener('loadedmetadata', onMetadata);
  }
}

// ── Media Helpers ─────────────────────────────────────────────────────────────

function getActiveMedia() {
  return isVideoMode ? playerVideo : audio;
}

function getCurrentMediaDuration() {
  var m = getActiveMedia();
  return (m && !isNaN(m.duration)) ? m.duration : 0;
}

function getCurrentMediaTime() {
  var m = getActiveMedia();
  return m ? m.currentTime : 0;
}

function setCurrentMediaTime(t) {
  var m = getActiveMedia();
  if (m) m.currentTime = t;
}

function isMediaPaused() {
  var m = getActiveMedia();
  return !m || m.paused;
}

// ── Play Control ──────────────────────────────────────────────────────────────

// totalCount: optional — total episodes in story (sets _epTotalCount and renders tabs)
async function playEpisode(story, episode, episodes, idx, totalCount) {
  // ── Token gate — must pass BEFORE any audio/video starts ─────────────────
  if (typeof checkPlayAllowed === 'function') {
    var preCheck = await checkPlayAllowed();
    if (preCheck === 'hourly_limit') {
      if (typeof showToast === 'function')
        showToast('Hourly server limit reached. Please try again next hour.');
      console.log('[TOKENS] playEpisode blocked — hourly limit');
      return;
    }
    if (preCheck === 'daily_limit') {
      if (typeof showToast === 'function')
        showToast('Daily server limit reached. Please try again next day.');
      console.log('[TOKENS] playEpisode blocked — daily limit');
      return;
    }
  }

  currentStory = story;
  currentEpisode = episode;
  currentEpisodes = episodes || [];
  currentEpisodeIdx = idx || 0;
  viewCounted    = false;
  tokenDeducted  = false; // Reset per new episode only
  _resetCWMilestones();   // Reset 10/50/90% save gates for the new episode

  // ── Analytics: episode_play ───────────────────────────────────────────────
  logAnalyticsEvent('episode_play', {
    story_id:       String(story ? (story.id || '') : ''),
    story_title:    String(story ? (story.title || '') : ''),
    episode_id:     String(episode ? (episode.id || '') : ''),
    episode_number: episode ? (episode.episode_number || (idx + 1)) : (idx + 1),
    episode_name:   String(episode ? (episode.episode_name || '') : '')
  });
  // ─────────────────────────────────────────────────────────────────────────

  // Update total count
  if (totalCount !== undefined && totalCount > 0) {
    _epTotalCount = totalCount;
  } else if (_epTotalCount === 0 && currentEpisodes.length > 0) {
    _epTotalCount = currentEpisodes.length;
  }

  // When a new batch set is provided (batchOffset defined), reset batch-fetch state.
  // When called from nextEpisode/prevEpisode/playEpisodeByIdx, batchOffset is undefined
  // so we preserve _epBatchOffset and _epAllFetched from the current session.
  if (arguments.length >= 6 && arguments[5] !== undefined) {
    var bo = Number(arguments[5]);
    _epBatchOffset    = bo + currentEpisodes.length;
    _epFetchingBatch  = false;
    _epAllFetched     = currentEpisodes.length < EP_BATCH_SIZE ||
                        (_epTotalCount > 0 && _epBatchOffset >= _epTotalCount);
    // Two-way scroll: reset upward-load state for this new batch session
    _epStartOffset    = bo;
    _epTopAllFetched  = (bo === 0);
    _epListBuilt      = false;
    _epTopLoadingMore = false;
    if (_epTopObserver) { _epTopObserver.disconnect(); _epTopObserver = null; }
  }

  var mediaUrl = (episode && (episode.audio_url || episode.video_url || episode.media_url)) || '';
  var mtype = getMediaType(mediaUrl);
  isVideoMode = (mtype === 'video' || mtype === 'hls');

  // Stop any existing HLS
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  // Stop both media elements first
  if (audio) { audio.pause(); audio.src = ''; }
  if (playerVideo) { playerVideo.pause(); playerVideo.src = ''; }

  if (isVideoMode) {
    switchToVideoMode();
    if (mtype === 'hls') {
      loadHLS(mediaUrl);
    } else {
      playerVideo.src = mediaUrl;
      playerVideo.playbackRate = currentSpeed;
      playerVideo.play().catch(function(e) { console.log('Video play:', e.message); });
    }
  } else {
    switchToAudioMode();
    if (audio) {
      audio.src = mediaUrl || '';
      audio.playbackRate = currentSpeed;
      audio.play().catch(function(e) { console.log('Audio play:', e.message); });
    }
  }

  updatePlayerUI();
  updateEpisodeList();
  showMiniPlayer();

  if (story && episode) {
    // Save minimal progress — no story/episode objects in localStorage
    var epNum = episode.episode_number || (idx + 1);
    saveProgress(story.id, episode.id, epNum, 0, episode.duration || 0);
    // Increment story play count immediately on play start
    recordPlayCount(story.id);
  }
}

function loadHLS(url) {
  if (!playerVideo) return;
  if (typeof Hls !== 'undefined' && Hls.isSupported()) {
    hlsInstance = new Hls({ enableWorker: false });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(playerVideo);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
      playerVideo.playbackRate = currentSpeed;
      playerVideo.play().catch(function(e) { console.log('HLS play:', e.message); });
    });
    hlsInstance.on(Hls.Events.ERROR, function(event, data) {
      console.log('HLS error:', data.type, data.details);
    });
  } else if (playerVideo.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    playerVideo.src = url;
    playerVideo.playbackRate = currentSpeed;
    playerVideo.play().catch(function(e) { console.log('Native HLS play:', e.message); });
  } else {
    console.log('HLS not supported in this browser');
  }
}

function switchToVideoMode() {
  var wrap = document.getElementById('player-thumb-wrap');
  var img = document.getElementById('player-thumb');
  var overlay = document.getElementById('video-tap-overlay');
  var fsBar = document.getElementById('video-fullscreen-bar');
  if (wrap) wrap.classList.add('video-mode');
  if (img) img.classList.add('hidden');
  if (playerVideo) playerVideo.classList.remove('hidden');
  if (overlay) overlay.classList.remove('hidden');
  if (fsBar) fsBar.classList.remove('hidden');
}

function switchToAudioMode() {
  var wrap = document.getElementById('player-thumb-wrap');
  var img = document.getElementById('player-thumb');
  var overlay = document.getElementById('video-tap-overlay');
  var fsBar = document.getElementById('video-fullscreen-bar');
  if (wrap) wrap.classList.remove('video-mode');
  if (img) img.classList.remove('hidden');
  if (playerVideo) playerVideo.classList.add('hidden');
  if (overlay) overlay.classList.add('hidden');
  if (fsBar) fsBar.classList.add('hidden');
}

var _tapFlashTimer = null;

function flashTapIcon(playing) {
  var icon = document.getElementById('video-tap-icon');
  if (!icon || !isVideoMode) return;
  icon.className = 'video-tap-icon ' + (playing ? 'pause-icon' : 'play-icon');
  icon.classList.add('flash');
  clearTimeout(_tapFlashTimer);
  _tapFlashTimer = setTimeout(function() {
    icon.classList.remove('flash');
  }, 500);
}

function togglePlay() {
  var m = getActiveMedia();
  if (!m) return;
  if (m.paused) {
    m.play().catch(function() {});
  } else {
    m.pause();
  }
}

function seekForward() {
  var m = getActiveMedia();
  if (!m) return;
  m.currentTime = Math.min(m.currentTime + 10, m.duration || 0);
}

function seekBackward() {
  var m = getActiveMedia();
  if (!m) return;
  m.currentTime = Math.max(m.currentTime - 10, 0);
}

async function nextEpisode() {
  if (currentEpisodeIdx < currentEpisodes.length - 1) {
    currentEpisodeIdx++;
    playEpisode(currentStory, currentEpisodes[currentEpisodeIdx], currentEpisodes, currentEpisodeIdx);
  } else if (!_epAllFetched && !_epFetchingBatch) {
    // End of currently loaded episodes — fetch next batch from API
    await _loadNextEpisodeBatch();
    if (currentEpisodeIdx < currentEpisodes.length - 1) {
      currentEpisodeIdx++;
      playEpisode(currentStory, currentEpisodes[currentEpisodeIdx], currentEpisodes, currentEpisodeIdx);
    }
  }
}

function prevEpisode() {
  if (currentEpisodeIdx > 0) {
    currentEpisodeIdx--;
    playEpisode(currentStory, currentEpisodes[currentEpisodeIdx], currentEpisodes, currentEpisodeIdx);
  }
}

function playEpisodeByIdx(idx) {
  if (idx >= 0 && idx < currentEpisodes.length) {
    currentEpisodeIdx = idx;
    playEpisode(currentStory, currentEpisodes[idx], currentEpisodes, idx);
    updateEpisodeList();
  }
}

// ── Speed ─────────────────────────────────────────────────────────────────────

function setSpeed(speed, save) {
  save = (save === undefined) ? true : save;
  currentSpeed = speed;
  if (audio) audio.playbackRate = speed;
  if (playerVideo) playerVideo.playbackRate = speed;
  if (save) localStorage.setItem('playback_speed', speed);
  document.querySelectorAll('.speed-btn').forEach(function(btn) {
    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed);
  });
}

// ── Media Events ──────────────────────────────────────────────────────────────

function onTimeUpdate() {
  var m = getActiveMedia();
  if (!m || !m.duration) return;

  var pct = (m.currentTime / m.duration) * 100;
  updateSeekBar(pct);
  updateTimes();
  updateMiniProgress(pct);

  // ── Milestone-based Continue Watching saves: 10 %, 50 %, 90 % ──
  if (currentStory && currentEpisode && m.duration > 0) {
    var cwRatio = m.currentTime / m.duration;
    var milestones = [10, 50, 90];
    for (var mi = 0; mi < milestones.length; mi++) {
      var ms = milestones[mi];
      if (!_cwMilestonesHit[ms] && cwRatio >= ms / 100) {
        _cwMilestonesHit[ms] = true;
        _saveCWNow('milestone-' + ms + '%');
      }
    }
  }

  // Token deduction + view count at 50% completion.
  // tokenDeducted — resets only on new episode (playEpisode), NOT on pause/resume.
  // This prevents duplicate token deductions from pause+resume on the same episode.
  if (!tokenDeducted && !viewCounted && currentStory && m.duration > 0) {
    var ratio = m.currentTime / m.duration;
    if (ratio >= 0.5) {
      tokenDeducted = true; // Lock immediately — prevents concurrent triggers
      viewCounted   = true;
      var _sid = currentStory.id;
      var _eid = currentEpisode ? (currentEpisode.id || currentEpisodeIdx) : currentEpisodeIdx;
      console.log('[VIEW] 50% reached — story:', _sid, '| episode:', _eid,
        '| time:', m.currentTime.toFixed(1), '/ ' + m.duration.toFixed(1));

      (async function() {
        // Deduct 1 server token — blocks play if limits are hit
        var result = typeof deductPlayToken === 'function'
          ? await deductPlayToken()
          : 'ok';

        if (result === 'hourly_limit') {
          var ma = getActiveMedia();
          if (ma) ma.pause();
          if (typeof showToast === 'function')
            showToast('Hourly server limit reached. Please try again next hour.');
          console.log('[TOKENS] Playback blocked — hourly limit');
          // ── Analytics: token_blocked ──────────────────────────────────────
          logAnalyticsEvent('token_blocked', { reason: 'hourly_limit', story_id: String(_sid) });
          // ──────────────────────────────────────────────────────────────────
          return;
        }
        if (result === 'daily_limit') {
          var ma = getActiveMedia();
          if (ma) ma.pause();
          if (typeof showToast === 'function')
            showToast('Daily server limit reached. Please try again next day.');
          console.log('[TOKENS] Playback blocked — daily limit');
          // ── Analytics: token_blocked ──────────────────────────────────────
          logAnalyticsEvent('token_blocked', { reason: 'daily_limit', story_id: String(_sid) });
          // ──────────────────────────────────────────────────────────────────
          return;
        }

        // Token deducted successfully — now count the view
        recordView(_sid);
        console.log('[TOKENS] Token deducted + view recorded ✓');
      })();
    }
  }
}

function onMetadata() {
  var m = getActiveMedia();
  if (!m) return;
  var el = document.getElementById('player-duration');
  if (el) el.textContent = formatTime(m.duration);
}

function onPlay() {
  setPlayPauseIcon(true);
  flashTapIcon(true);
  viewCounted = false;
}

function onPause() {
  setPlayPauseIcon(false);
  flashTapIcon(false);
  _saveCWNow('pause');     // Immediate save on pause
}

function onEnded() {
  _saveCWNow('ended');    // Save final position on episode end

  if (currentEpisodeIdx < currentEpisodes.length - 1) {
    // Next episode already in memory
    logAnalyticsEvent('autoplay_next_episode', {
      story_id:            String(currentStory ? (currentStory.id || '') : ''),
      completed_episode:   currentEpisode ? (currentEpisode.episode_number || (currentEpisodeIdx + 1)) : (currentEpisodeIdx + 1),
      next_episode_number: currentEpisodeIdx + 2
    });
    setTimeout(nextEpisode, 800);
  } else if (!_epAllFetched) {
    // At end of loaded episodes — fetch next batch then auto-play
    logAnalyticsEvent('autoplay_next_episode', {
      story_id:          String(currentStory ? (currentStory.id || '') : ''),
      completed_episode: currentEpisode ? (currentEpisode.episode_number || (currentEpisodeIdx + 1)) : (currentEpisodeIdx + 1),
      next_episode_number: _epBatchOffset + 1
    });
    setTimeout(function() {
      _loadNextEpisodeBatch().then(function() {
        if (currentEpisodeIdx < currentEpisodes.length - 1) nextEpisode();
      });
    }, 800);
  }
}

function setPlayPauseIcon(playing) {
  var pi  = document.getElementById('play-icon');
  var pai = document.getElementById('pause-icon');
  var mpi = document.getElementById('mini-play-icon');
  var mpai= document.getElementById('mini-pause-icon');
  if (pi)  pi.classList.toggle('hidden', playing);
  if (pai) pai.classList.toggle('hidden', !playing);
  if (mpi)  mpi.classList.toggle('hidden', playing);
  if (mpai) mpai.classList.toggle('hidden', !playing);
}

// ── UI Updates ────────────────────────────────────────────────────────────────

function updatePlayerUI() {
  if (!currentStory || !currentEpisode) return;

  // Thumbnail from Supabase only — no fallback
  var thumb = currentStory.image_url || '';
  var playerThumb = document.getElementById('player-thumb');
  var miniThumb   = document.getElementById('mini-thumb');
  if (playerThumb) { if (thumb) { playerThumb.src = thumb; playerThumb.style.display = ''; } else { playerThumb.style.display = 'none'; } }
  if (miniThumb)   { if (thumb) { miniThumb.src = thumb; } }

  var storyNameEl = document.getElementById('player-story-name');
  var miniStoryEl = document.getElementById('mini-story-name');
  if (storyNameEl) storyNameEl.textContent = currentStory.title || '';
  if (miniStoryEl) miniStoryEl.textContent = currentStory.title || '';

  // Episode label: "Ep N · Title from Supabase (episode_name column)"
  var epNum   = currentEpisode.episode_number || (currentEpisodeIdx + 1);
  var epTitle = currentEpisode.episode_name || '';
  var epLabel = 'Ep ' + epNum + (epTitle ? ' · ' + epTitle : '');
  var epNameEl  = document.getElementById('player-ep-name');
  var miniEpEl  = document.getElementById('mini-ep-name');
  if (epNameEl) epNameEl.textContent = epLabel;
  if (miniEpEl) miniEpEl.textContent = epLabel;

  var currTimeEl = document.getElementById('player-current-time');
  var durEl      = document.getElementById('player-duration');
  if (currTimeEl) currTimeEl.textContent = '0:00';
  if (durEl)      durEl.textContent = formatTime(currentEpisode.duration || 0);

  var seek = document.getElementById('player-seek');
  if (seek) { seek.value = 0; updateSeekGradient(0); }

  updateEpisodeList();
}

function updateSeekBar(pct) {
  var seek = document.getElementById('player-seek');
  if (seek) { seek.value = pct; updateSeekGradient(pct); }
}

function updateSeekGradient(pct) {
  var seek = document.getElementById('player-seek');
  if (seek) {
    seek.style.background = 'linear-gradient(to right, var(--primary) ' + pct + '%, #e0e0f0 ' + pct + '%)';
  }
}

function updateTimes() {
  var m = getActiveMedia();
  if (!m) return;
  var currEl = document.getElementById('player-current-time');
  var durEl  = document.getElementById('player-duration');
  if (currEl) currEl.textContent = formatTime(m.currentTime);
  if (durEl && m.duration) durEl.textContent = formatTime(m.duration);
}

function updateMiniProgress(pct) {
  var fill = document.getElementById('mini-progress-fill');
  if (fill) fill.style.width = pct + '%';
}

// ── Episode List — Real Lazy API Loading ──────────────────────────────────────
// Each scroll event triggers a live Supabase request for exactly 10 episodes.
// Cache key per batch: ep_{storyId}_{start}_{end} e.g. ep_3_1_10, ep_3_11_20.
// currentEpisodes grows in-place as batches arrive; DOM appended without rebuild.

// Returns true if `ep` is the episode currently playing.
// Accepts an episode object (not an index) so it works for both the main buffer
// and the browse buffer without any coupling to currentEpisodeIdx.
function _isEpisodePlaying(ep) {
  if (!ep || !currentEpisode) return false;
  if (ep.id !== undefined && currentEpisode.id !== undefined) return ep.id === currentEpisode.id;
  return ep.episode_number !== undefined &&
         ep.episode_number === currentEpisode.episode_number;
}

function _epItemHTML(i) {
  var ep    = currentEpisodes[i];
  var num   = ep.episode_number || (i + 1);
  var title = ep.episode_name || '';
  var mtype = getMediaType(ep.audio_url || ep.video_url || ep.media_url || '');
  var icon  = (mtype === 'video' || mtype === 'hls') ? '🎬 ' : '🎵 ';
  return '<div class="ep-item ' + (_isEpisodePlaying(ep) ? 'playing' : '') +
    '" data-ep-idx="' + i + '" onclick="playEpisodeByIdx(' + i + ')">' +
    '<div class="ep-num">Ep ' + num + '</div>' +
    '<div class="ep-details">' +
      '<div class="ep-name">' + icon + title + '</div>' +
      '<div class="ep-duration">' + formatTime(ep.duration || 0) + '</div>' +
    '</div></div>';
}

// Disconnect the bottom IntersectionObserver AND cancel its pending load timer.
// Cancelling the timer ensures a queued setTimeout cannot fire after disconnect
// (e.g. a sentinel intersection just before a jump would otherwise produce an
// extra API request after the jump has already replaced the episode buffer).
function _destroyScrollObserver() {
  if (_epScrollObserver) { _epScrollObserver.disconnect(); _epScrollObserver = null; }
  if (_epBottomLoadTimer) { clearTimeout(_epBottomLoadTimer); _epBottomLoadTimer = null; }
}

// Disconnect the top IntersectionObserver AND cancel its pending load timer.
function _destroyTopObserver() {
  if (_epTopObserver) { _epTopObserver.disconnect(); _epTopObserver = null; }
  if (_epTopLoadTimer) { clearTimeout(_epTopLoadTimer); _epTopLoadTimer = null; }
}

// Disconnect and discard both observers (top + bottom).
function _destroyAllObservers() {
  _destroyScrollObserver();
  _destroyTopObserver();
}

// Arm an IntersectionObserver on the bottom sentinel div.
// When the sentinel enters the viewport a real Supabase batch fetch is triggered.
function _attachSentinelObserver(list) {
  _destroyScrollObserver();
  var sentinel = list.querySelector('.ep-scroll-sentinel');
  if (!sentinel) return;

  _epScrollObserver = new IntersectionObserver(function(entries) {
    if (!entries[0].isIntersecting || _epListLoadingMore || _epFetchingBatch || _epAllFetched) return;
    _epListLoadingMore = true;

    // Show spinner immediately
    var footer = list.querySelector('.ep-list-footer');
    if (footer) {
      footer.innerHTML =
        '<div class="ep-load-more-spinner"><span></span><span></span><span></span></div>';
    }

    // Track the timer so _destroyScrollObserver can cancel it if needed
    var delay = 1000 + Math.floor(Math.random() * 1000);
    _epBottomLoadTimer = setTimeout(function() {
      _epBottomLoadTimer = null;
      _loadNextEpisodeBatch();
    }, delay);

  }, { rootMargin: '0px 0px 120px 0px', threshold: 0 });

  _epScrollObserver.observe(sentinel);
}

// Arm an IntersectionObserver on the top sentinel div.
// When the sentinel enters the viewport a real Supabase batch fetch is triggered (upward).
function _attachTopSentinelObserver(list) {
  _destroyTopObserver();
  var sentinel = list.querySelector('.ep-top-sentinel');
  if (!sentinel) return;

  _epTopObserver = new IntersectionObserver(function(entries) {
    if (!entries[0].isIntersecting || _epTopLoadingMore || _epTopAllFetched || _epStartOffset <= 0) return;
    _epTopLoadingMore = true;

    // Show top spinner immediately
    var topWrap = list.querySelector('.ep-top-sentinel-wrap');
    if (topWrap) {
      topWrap.innerHTML =
        '<div class="ep-load-more-spinner"><span></span><span></span><span></span></div>';
    }

    // Track the timer so _destroyTopObserver can cancel it if needed
    var delay = 800 + Math.floor(Math.random() * 600);
    _epTopLoadTimer = setTimeout(function() {
      _epTopLoadTimer = null;
      _loadPrevEpisodeBatch();
    }, delay);

  }, { rootMargin: '120px 0px 0px 0px', threshold: 0 });

  _epTopObserver.observe(sentinel);
}

// Fetch the next batch of EP_BATCH_SIZE episodes from the Episode Supabase.
// Appends new episodes to currentEpisodes (in-place) and to the DOM.
// Never rebuilds the list or moves scroll position.
async function _loadNextEpisodeBatch() {
  if (_epFetchingBatch || _epAllFetched || !currentStory) {
    _epListLoadingMore = false;
    return;
  }
  _epFetchingBatch = true;

  var list = document.getElementById('player-episode-list');

  try {
    var batch = await fetchEpisodeBatch(currentStory.id, _epBatchOffset);

    if (batch === null) {
      // Supabase temporarily unavailable — remove spinner, stop trying
      _epFetchingBatch = false;
      _epListLoadingMore = false;
      if (list) {
        var footerErr = list.querySelector('.ep-list-footer');
        if (footerErr) footerErr.remove();
      }
      return;
    }

    // A batch shorter than EP_BATCH_SIZE means we've reached the end
    if (batch.length < EP_BATCH_SIZE) {
      _epAllFetched = true;
    }

    if (batch.length > 0) {
      var prevLen = currentEpisodes.length;
      for (var k = 0; k < batch.length; k++) {
        currentEpisodes.push(batch[k]);
      }
      _epBatchOffset += batch.length;

      if (list) {
        // Remove old footer (spinner or sentinel)
        var oldFooter = list.querySelector('.ep-list-footer');
        if (oldFooter) oldFooter.remove();

        // Append new episode rows
        var html = '';
        for (var m = prevLen; m < currentEpisodes.length; m++) {
          if (currentEpisodes[m] && currentEpisodes[m].story_id) html += _epItemHTML(m);
        }
        if (html) list.insertAdjacentHTML('beforeend', html);

        // Place sentinel or "all loaded" footer
        if (!_epAllFetched) {
          list.insertAdjacentHTML('beforeend',
            '<div class="ep-list-footer"><div class="ep-scroll-sentinel"></div></div>');
          _attachSentinelObserver(list);
        } else {
          _destroyScrollObserver();
          list.insertAdjacentHTML('beforeend',
            '<div class="ep-list-footer"><div class="ep-list-all-loaded">All episodes loaded</div></div>');
        }
      }
    } else {
      // Empty batch — no more episodes
      _epAllFetched = true;
      _destroyScrollObserver();
      if (list) {
        var emptyFooter = list.querySelector('.ep-list-footer');
        if (emptyFooter) emptyFooter.remove();
        list.insertAdjacentHTML('beforeend',
          '<div class="ep-list-footer"><div class="ep-list-all-loaded">All episodes loaded</div></div>');
      }
    }
  } catch (e) {
    console.error('[EP] _loadNextEpisodeBatch error:', e);
  }

  _epFetchingBatch = false;
  _epListLoadingMore = false;
}

// ── Two-Way Infinite Scroll helpers ──────────────────────────────────────────

// Refresh the data-ep-idx attribute and onclick handler on every rendered episode item.
// Called after items are prepended (upward load) so that all indices stay correct.
function _refreshAllEpIndices(list) {
  var items = list.querySelectorAll('.ep-item');
  for (var i = 0; i < items.length; i++) {
    items[i].setAttribute('data-ep-idx', i);
    (function(idx) {
      items[idx].onclick = function() { playEpisodeByIdx(idx); };
    })(i);
  }
}

// Refresh only the "playing" class on all items without rebuilding the DOM.
// Uses _isEpisodePlaying (ID/episode_number match) so the highlight is correct
// regardless of whether the list is in normal or browse mode.
function _refreshPlayingHighlight(list) {
  var batch = _epBrowseBatch || currentEpisodes;
  var items = list.querySelectorAll('.ep-item');
  for (var j = 0; j < items.length; j++) {
    var idx = parseInt(items[j].getAttribute('data-ep-idx'), 10);
    items[j].classList.toggle('playing', _isEpisodePlaying(batch[idx]));
  }
}

// Scroll the episode list so that the item at `idx` is centered in the viewport.
function _scrollToEpisodeInList(list, idx) {
  if (!list) return;
  var item = list.querySelector('[data-ep-idx="' + idx + '"]');
  if (!item) return;
  var target = item.offsetTop - (list.clientHeight / 2) + (item.clientHeight / 2);
  list.scrollTop = Math.max(0, target);
}

// Render the episode list. When _epBrowseBatch is set (browse mode), renders that
// batch as a static snapshot without sentinels — playback state is untouched.
// In normal mode, renders all of currentEpisodes with top+bottom sentinels.
function _renderFullEpisodeList(list) {
  if (!list) return;

  var inBrowse = !!_epBrowseBatch;

  if (inBrowse) {
    // ── Browse mode: show the jumped-to batch; no infinite-scroll sentinels ──
    var html = '';
    for (var b = 0; b < _epBrowseBatch.length; b++) {
      var bep = _epBrowseBatch[b];
      if (!bep || !bep.story_id) continue;
      var bnum   = bep.episode_number || (b + 1);
      var btitle = bep.episode_name || '';
      var bmtype = getMediaType(bep.audio_url || bep.video_url || bep.media_url || '');
      var bicon  = (bmtype === 'video' || bmtype === 'hls') ? '🎬 ' : '🎵 ';
      html += '<div class="ep-item ' + (_isEpisodePlaying(bep) ? 'playing' : '') +
        '" data-ep-idx="' + b + '" onclick="_browsePlayEpisode(' + b + ')">' +
        '<div class="ep-num">Ep ' + bnum + '</div>' +
        '<div class="ep-details">' +
          '<div class="ep-name">' + bicon + btitle + '</div>' +
          '<div class="ep-duration">' + formatTime(bep.duration || 0) + '</div>' +
        '</div></div>';
    }
    list.innerHTML = html +
      '<div class="ep-list-footer"><div class="ep-list-all-loaded">Showing batch · tap Current Episode to return</div></div>';
    return; // no sentinels in browse mode
  }

  // ── Normal mode: all loaded episodes with top + bottom sentinels ──────────

  // Top: sentinel for upward batch loading (hidden if already at episode #1)
  var topHtml = !_epTopAllFetched
    ? '<div class="ep-top-sentinel-wrap"><div class="ep-top-sentinel"></div></div>'
    : '';

  var epHtml = '';
  for (var i = 0; i < currentEpisodes.length; i++) {
    if (currentEpisodes[i] && currentEpisodes[i].story_id) epHtml += _epItemHTML(i);
  }

  // Bottom: sentinel or "all loaded" footer
  var bottomHtml = !_epAllFetched
    ? '<div class="ep-list-footer"><div class="ep-scroll-sentinel"></div></div>'
    : '<div class="ep-list-footer"><div class="ep-list-all-loaded">All episodes loaded</div></div>';

  list.innerHTML = topHtml + epHtml + bottomHtml;

  if (!_epTopAllFetched) _attachTopSentinelObserver(list);
  if (!_epAllFetched)    _attachSentinelObserver(list);
}

// Rebuild the episode list on first build; refresh highlights only on subsequent calls.
function updateEpisodeList() {
  var list = document.getElementById('player-episode-list');
  if (!list || !currentEpisodes.length) return;

  if (!_epListBuilt) {
    // First build for this story session — full render with both sentinels
    _destroyAllObservers();
    _epListBuilt       = true;
    _epListLoadingMore = false;
    _renderFullEpisodeList(list);
    _scrollToEpisodeInList(list, currentEpisodeIdx);
  } else {
    // List already exists — only update the playing highlight and scroll to current episode
    _refreshPlayingHighlight(list);
    _scrollToEpisodeInList(list, currentEpisodeIdx);
  }
  _epListAnchorIdx = currentEpisodeIdx;
}

// ── Upward Batch Loading ──────────────────────────────────────────────────────
// Fetches the batch of episodes that precedes currentEpisodes[0].
// Prepends items to the DOM and adjusts scroll position to keep the view stable.
async function _loadPrevEpisodeBatch() {
  if (_epTopAllFetched || !currentStory || _epStartOffset <= 0) {
    _epTopLoadingMore = false;
    return;
  }

  var list  = document.getElementById('player-episode-list');
  var newOffset = Math.max(0, _epStartOffset - EP_BATCH_SIZE);

  try {
    var batch = await fetchEpisodeBatch(currentStory.id, newOffset);

    // Remove the top sentinel/spinner regardless of outcome
    if (list) {
      var topWrapEl = list.querySelector('.ep-top-sentinel-wrap');
      if (topWrapEl) topWrapEl.remove();
    }

    if (batch === null) {
      // Transient backend failure — restore the sentinel so the user can retry by scrolling
      if (list) {
        var topWrapRestore = document.createElement('div');
        topWrapRestore.className = 'ep-top-sentinel-wrap';
        topWrapRestore.innerHTML = '<div class="ep-top-sentinel"></div>';
        list.insertBefore(topWrapRestore, list.firstChild);
        _attachTopSentinelObserver(list);
      }
      _epTopLoadingMore = false;
      return;
    }

    if (!batch.length) {
      // True boundary — nothing more above episode #1
      _epTopAllFetched = true;
      _epTopLoadingMore = false;
      return;
    }

    // Snapshot scroll metrics before any DOM mutation
    var prevScrollHeight = list ? list.scrollHeight : 0;
    var prevScrollTop    = list ? list.scrollTop    : 0;

    // Update in-memory state: prepend batch, shift current episode index
    _epStartOffset   = newOffset;
    currentEpisodeIdx += batch.length;  // existing episodes shifted down by batch.length
    currentEpisodes  = batch.concat(currentEpisodes);
    if (newOffset === 0) _epTopAllFetched = true;

    if (list) {
      // Build HTML for the newly prepended items (indices 0 … batch.length-1)
      var html = '';
      for (var i = 0; i < batch.length; i++) {
        if (batch[i] && batch[i].story_id) html += _epItemHTML(i);
      }

      if (html) {
        var tmp  = document.createElement('div');
        tmp.innerHTML = html;
        var frag = document.createDocumentFragment();
        while (tmp.firstChild) frag.appendChild(tmp.firstChild);
        var firstItem = list.querySelector('.ep-item');
        if (firstItem) list.insertBefore(frag, firstItem);
        else           list.insertBefore(frag, list.firstChild);
      }

      // Re-add top sentinel (or nothing if now at the very top)
      if (!_epTopAllFetched) {
        var newTop = document.createElement('div');
        newTop.className = 'ep-top-sentinel-wrap';
        newTop.innerHTML = '<div class="ep-top-sentinel"></div>';
        list.insertBefore(newTop, list.firstChild);
        _attachTopSentinelObserver(list);
      }

      // Fix all data-ep-idx values and onclick handlers (they shifted)
      _refreshAllEpIndices(list);
      _refreshPlayingHighlight(list);

      // Restore scroll position so the view doesn't jump
      var newScrollHeight = list.scrollHeight;
      list.scrollTop = prevScrollTop + (newScrollHeight - prevScrollHeight);
    }

  } catch (e) {
    console.error('[EP] _loadPrevEpisodeBatch error:', e);
  }

  _epTopLoadingMore = false;
}

// ── Browse Mode helpers ───────────────────────────────────────────────────────

// Enter browse mode: show `batch` (at story row `offset`) in the episode list
// WITHOUT touching currentEpisodes / currentEpisodeIdx / playback state at all.
// Next/Prev/autoplay continue to work on the real playback buffer.
function _enterBrowseMode(batch, offset) {
  _epBrowseBatch  = batch;
  _epBrowseOffset = offset;
  _epListBuilt    = false; // force re-render via _renderFullEpisodeList
}

// Exit browse mode: the next updateEpisodeList / _renderFullEpisodeList call will
// go back to rendering currentEpisodes with full two-way scroll.
function _exitBrowseMode() {
  _epBrowseBatch  = null;
  _epBrowseOffset = 0;
  _epListBuilt    = false;
}

// Play an episode from the browse batch.  This exits browse mode first, then
// calls playEpisode with the full batchOffset so it correctly re-initialises
// all batch-state variables (currentEpisodes, _epBatchOffset, _epStartOffset …).
function _browsePlayEpisode(i) {
  if (!_epBrowseBatch || i < 0 || i >= _epBrowseBatch.length) return;
  var batch  = _epBrowseBatch.slice(); // snapshot before clearing
  var offset = _epBrowseOffset;
  _exitBrowseMode();
  playEpisode(currentStory, batch[i], batch, i, _epTotalCount, offset);
}

// ── Episode Shortcut ─────────────────────────────────────────────────────────
// jumpToEpisode: calculate the correct batch, fetch it (ONE request), scroll to episode.
async function jumpToEpisode() {
  var input  = document.getElementById('ep-jump-input');
  if (!input) return;
  var epNum = parseInt(input.value, 10);
  if (!epNum || epNum < 1 || !currentStory) {
    if (typeof showToast === 'function') showToast('Enter a valid episode number');
    return;
  }

  var list = document.getElementById('player-episode-list');

  // ── Check if episode is already in the loaded buffer ─────────────────────
  var foundIdx = -1;
  for (var i = 0; i < currentEpisodes.length; i++) {
    if (currentEpisodes[i].episode_number === epNum) { foundIdx = i; break; }
  }

  if (foundIdx !== -1) {
    // Already loaded — scroll and highlight; NO API request
    _scrollToEpisodeInList(list, foundIdx);
    _setJumpHighlight(foundIdx);
    return;
  }

  // ── Episode not loaded — fetch exactly the one batch that contains it ─────
  // batchOffset = floor((epNum-1)/10)*10  →  ep1-10→0, ep11-20→10, ep45→40, etc.
  var batchOffset = Math.floor((epNum - 1) / EP_BATCH_SIZE) * EP_BATCH_SIZE;
  var batch = await fetchEpisodeBatch(currentStory.id, batchOffset);

  if (!batch || !batch.length) {
    if (typeof showToast === 'function') showToast('Episode not found');
    return;
  }

  // Find target within the fetched batch
  var targetIdx = -1;
  for (var j = 0; j < batch.length; j++) {
    if (batch[j].episode_number === epNum) { targetIdx = j; break; }
  }
  if (targetIdx === -1) {
    if (typeof showToast === 'function') showToast('Episode #' + epNum + ' not found');
    return;
  }

  // ── Decide: update main buffer OR enter browse mode ─────────────────────
  // If the currently playing episode IS in the target batch, replace the main
  // buffer (correct currentEpisodeIdx, next/prev work naturally from the new batch).
  // If it is NOT in the target batch, enter browse mode — currentEpisodes and
  // currentEpisodeIdx are left completely untouched so next/prev/autoplay keep working.
  var playingInBatch = -1;
  if (currentEpisode) {
    for (var k = 0; k < batch.length; k++) {
      if (batch[k].id === currentEpisode.id) { playingInBatch = k; break; }
    }
  }

  if (playingInBatch !== -1) {
    // Playing episode is in this batch — make it the active playback buffer
    currentEpisodes    = batch;
    currentEpisodeIdx  = playingInBatch;
    _epStartOffset     = batchOffset;
    _epBatchOffset     = batchOffset + batch.length;
    _epTopAllFetched   = (batchOffset === 0);
    _epAllFetched      = (batch.length < EP_BATCH_SIZE) ||
                         (_epTotalCount > 0 && _epBatchOffset >= _epTotalCount);
    _epFetchingBatch   = false;
    _epListLoadingMore = false;
    _epListBuilt       = false;
    _epBrowseBatch     = null; // ensure not in browse mode

    // Render WITHOUT re-arming observers yet (single-request guarantee)
    _destroyAllObservers();
    list.innerHTML = '';
    _renderFullEpisodeList(list);
    _destroyAllObservers();

    setTimeout(function() {
      _scrollToEpisodeInList(list, targetIdx);
      _setJumpHighlight(targetIdx);
      if (!_epTopAllFetched) _attachTopSentinelObserver(list);
      if (!_epAllFetched)    _attachSentinelObserver(list);
    }, 250);

  } else {
    // Playing episode is NOT in this batch — browse mode: list shows the batch
    // but playback state (currentEpisodes, currentEpisodeIdx) is untouched.
    _destroyAllObservers();
    _enterBrowseMode(batch, batchOffset); // sets _epListBuilt = false
    list.innerHTML = '';
    _renderFullEpisodeList(list); // renders browse snapshot, no sentinels

    setTimeout(function() {
      _scrollToEpisodeInList(list, targetIdx);
      _setJumpHighlight(targetIdx);
      // No observers to re-arm — browse mode renders a static snapshot
    }, 250);
  }
}

// Highlight the jumped-to episode briefly (2 s) without affecting the playing state.
// Uses _isEpisodePlaying (ID-based) for the "playing" class so it stays correct
// whether the list is in normal mode or browse mode.
function _setJumpHighlight(idx) {
  var list = document.getElementById('player-episode-list');
  if (!list) return;
  var batch = _epBrowseBatch || currentEpisodes;
  list.querySelectorAll('.ep-item').forEach(function(item) {
    var itemIdx = parseInt(item.getAttribute('data-ep-idx'), 10);
    item.classList.toggle('ep-jump-target', itemIdx === idx);
    item.classList.toggle('playing', _isEpisodePlaying(batch[itemIdx]));
  });
  setTimeout(function() {
    if (list) list.querySelectorAll('.ep-jump-target').forEach(function(item) {
      item.classList.remove('ep-jump-target');
    });
  }, 2000);
}

// ── Current Episode Button ────────────────────────────────────────────────────
// Scroll back to the currently playing episode.
// If the list is in browse mode, exits it first (restoring two-way scroll).
// If the playing episode is already in the main buffer, just scrolls — no API call.
// If it is not (e.g. after a jump that replaced the buffer), fetches its home batch
// from the AppCache (cache-first, no network if already loaded).
function scrollToCurrentEpisode() {
  var list = document.getElementById('player-episode-list');
  if (!list || !currentStory || !currentEpisode) return;

  // ── Exit browse mode first (if active) ───────────────────────────────────
  if (_epBrowseBatch) {
    _exitBrowseMode(); // clears _epBrowseBatch, sets _epListBuilt = false
    // currentEpisodes / currentEpisodeIdx were never changed in browse mode,
    // so they are still valid — fall through to search below
  }

  var playingId    = currentEpisode.id;
  var playingEpNum = currentEpisode.episode_number;

  // ── Search the main buffer (zero cost) ───────────────────────────────────
  var realIdx = -1;
  for (var i = 0; i < currentEpisodes.length; i++) {
    if (currentEpisodes[i].id === playingId ||
        currentEpisodes[i].episode_number === playingEpNum) {
      realIdx = i; break;
    }
  }

  if (realIdx !== -1) {
    // Episode is in the main buffer — rebuild (in case we just exited browse),
    // sync index, refresh highlight, and scroll.
    currentEpisodeIdx = realIdx;
    if (!_epListBuilt) {
      _destroyAllObservers();
      _renderFullEpisodeList(list);
      _destroyAllObservers();
      setTimeout(function() {
        _scrollToEpisodeInList(list, realIdx);
        if (!_epTopAllFetched) _attachTopSentinelObserver(list);
        if (!_epAllFetched)    _attachSentinelObserver(list);
      }, 250);
    } else {
      _refreshPlayingHighlight(list);
      _scrollToEpisodeInList(list, realIdx);
    }
    return;
  }

  // ── Episode not in main buffer (buffer was replaced by a previous jump) ───
  // fetchEpisodeBatch is cache-first: if this batch was fetched earlier the
  // result comes from AppCache with no network round-trip.
  var epNum     = playingEpNum || 1;
  var homeBatch = Math.floor((epNum - 1) / EP_BATCH_SIZE) * EP_BATCH_SIZE;

  fetchEpisodeBatch(currentStory.id, homeBatch).then(function(batch) {
    if (!batch || !batch.length) return;

    var backIdx = -1;
    for (var j = 0; j < batch.length; j++) {
      if (batch[j].id === playingId ||
          batch[j].episode_number === playingEpNum) {
        backIdx = j; break;
      }
    }
    if (backIdx === -1) return;

    // Restore main buffer to the playing episode's home batch
    currentEpisodes    = batch;
    currentEpisodeIdx  = backIdx;
    _epStartOffset     = homeBatch;
    _epBatchOffset     = homeBatch + batch.length;
    _epTopAllFetched   = (homeBatch === 0);
    _epAllFetched      = (batch.length < EP_BATCH_SIZE) ||
                         (_epTotalCount > 0 && _epBatchOffset >= _epTotalCount);
    _epFetchingBatch   = false;
    _epListLoadingMore = false;
    _epListBuilt       = false;

    _destroyAllObservers();
    list.innerHTML = '';
    _renderFullEpisodeList(list);
    _destroyAllObservers();

    setTimeout(function() {
      _scrollToEpisodeInList(list, backIdx);
      if (!_epTopAllFetched) _attachTopSentinelObserver(list);
      if (!_epAllFetched)    _attachSentinelObserver(list);
    }, 250);
  });
}

// ── Mini Player ───────────────────────────────────────────────────────────────

function showMiniPlayer() {
  if (window.currentPage === 'player') return; // Don't show on full player page
  var mp = document.getElementById('mini-player');
  if (mp && currentStory) {
    mp.classList.remove('hidden');
    mp.classList.add('mini-slide-in');
    setTimeout(function() { mp.classList.remove('mini-slide-in'); }, 350);
  }
}

function hideMiniPlayer() {
  var mp = document.getElementById('mini-player');
  if (mp) mp.classList.add('hidden');
}

function openFullPlayer() {
  if (!currentStory) return;
  showPage('player');
}

function minimizePlayer() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
  }
  goBack();
}

// ── Fullscreen ────────────────────────────────────────────────────────────────

function toggleFullscreen() {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
  } else {
    enterFullscreen();
  }
}

function enterFullscreen() {
  var el = playerVideo || document.getElementById('player-thumb-wrap');
  if (!el) return;
  var req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  if (req) req.call(el);
  updateFullscreenUI(true);
}

function exitFullscreen() {
  var exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
  if (exit) exit.call(document);
  updateFullscreenUI(false);
}

function updateFullscreenUI(isFullscreen) {
  var expandIcon = document.getElementById('fs-expand-icon');
  var compressIcon = document.getElementById('fs-compress-icon');
  var label = document.getElementById('fs-label');
  if (expandIcon) expandIcon.classList.toggle('hidden', isFullscreen);
  if (compressIcon) compressIcon.classList.toggle('hidden', !isFullscreen);
  if (label) label.textContent = isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
}

document.addEventListener('fullscreenchange', function() {
  var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  updateFullscreenUI(isFs);
});
document.addEventListener('webkitfullscreenchange', function() {
  var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  updateFullscreenUI(isFs);
});

// ── Resume Helper (called from Continue Watching) ─────────────────────────────

function resumeAt(time) {
  if (time > 0) {
    var m = getActiveMedia();
    if (m) {
      var doSeek = function() {
        m.currentTime = time;
        m.removeEventListener('canplay', doSeek);
        m.removeEventListener('loadedmetadata', doSeek);
      };
      if (m.readyState >= 2) {
        doSeek();
      } else {
        m.addEventListener('loadedmetadata', doSeek, { once: true });
        m.addEventListener('canplay', doSeek, { once: true });
      }
    }
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatTime(secs) {
  if (!secs || isNaN(secs)) return '0:00';
  secs = Math.floor(secs);
  var m = Math.floor(secs / 60);
  var s = secs % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function formatCount(n) {
  if (!n) return '0';
  n = Number(n);
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
  return String(n);
}
