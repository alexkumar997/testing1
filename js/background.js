// Background Audio + Inactivity Shutdown
// - Audio continues playing when app is minimized (no pause on visibility change)
// - If user is inactive for 40 minutes, audio pauses and player resets

var _inactivityTimer = null;
var _INACTIVITY_LIMIT = 40 * 60 * 1000; // 40 minutes in ms

function resetInactivityTimer() {
  if (_inactivityTimer) clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(function() {
    _handleInactivityShutdown();
  }, _INACTIVITY_LIMIT);
}

function _handleInactivityShutdown() {
  console.log('[BG] Inactivity limit reached — pausing playback');
  try {
    var audioEl = document.getElementById('audio-element');
    if (audioEl && !audioEl.paused) {
      audioEl.pause();
    }
    var videoEl = document.getElementById('player-video');
    if (videoEl && !videoEl.paused) {
      videoEl.pause();
    }
  } catch (e) {
    console.log('[BG] Pause error:', e.message);
  }

  // Reset player UI
  var playIcon = document.getElementById('play-icon');
  var pauseIcon = document.getElementById('pause-icon');
  var miniPlayIcon = document.getElementById('mini-play-icon');
  var miniPauseIcon = document.getElementById('mini-pause-icon');
  if (playIcon) playIcon.classList.remove('hidden');
  if (pauseIcon) pauseIcon.classList.add('hidden');
  if (miniPlayIcon) miniPlayIcon.classList.remove('hidden');
  if (miniPauseIcon) miniPauseIcon.classList.add('hidden');

  // Show session message
  if (typeof showToast === 'function') {
    showToast('Playback paused after 40 min of inactivity');
  }
}

// Track all user activity — restarts the 40-min timer
function _onUserActivity() {
  resetInactivityTimer();
}

document.addEventListener('click',     _onUserActivity, { passive: true });
document.addEventListener('touchstart', _onUserActivity, { passive: true });
document.addEventListener('keydown',   _onUserActivity, { passive: true });
document.addEventListener('scroll',    _onUserActivity, { passive: true });

// Start timer on page load
window.addEventListener('DOMContentLoaded', function() {
  resetInactivityTimer();
});

// Background audio: do NOT pause when app is minimized
// (default browser behavior pauses Media Session on some browsers — override it)
document.addEventListener('visibilitychange', function() {
  if (document.hidden) {
    console.log('[BG] App minimized — keeping audio alive');
    // Do NOT pause. Audio element continues natively.
    // Just ensure inactivity timer stays running.
  } else {
    console.log('[BG] App resumed — resetting inactivity timer');
    resetInactivityTimer();
  }
});
