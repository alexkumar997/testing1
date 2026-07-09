// Main App Controller
var pageHistory = [];
var currentPage = 'home';
window.currentPage = 'home';
var currentDetailStory = null;

// ── Boot ──────────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async function() {
  try {
    initSupabase();

    await new Promise(function(resolve) { setTimeout(resolve, 1800); });

    var splash = document.getElementById('splash-screen');
    if (splash) {
      splash.classList.add('fade-out');
      setTimeout(function() { splash.classList.add('hidden'); }, 450);
    }

    var appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('hidden');

    initPlayer();
    initAuth();

    // Start background token engine — syncs refill/reset, starts Realtime, runs every 5 min
    if (typeof startTokenEngine === 'function') startTokenEngine();

    initSlider();
    renderTrending();
    initCategories();
    renderContinueWatching();

    try {
      var notifs = await fetchNotifications();
      var unread = notifs.filter(function(n) { return !n.read; }).length;
      updateNotifBadge(unread);
    } catch (e) { console.error('Notif badge:', e); }

    // ── Pull-to-refresh (bypasses the local cache; UI/behavior unchanged) ──
    if (window.AppCache) {
      var homePage = document.getElementById('page-home');
      if (homePage) {
        AppCache.attachPullToRefresh(homePage, function() {
          return Promise.all([
            initSlider({ bypass: true }),
            renderTrending({ bypass: true }),
            loadCategoryStories(currentCategory, { bypass: true })
          ]);
        });
      }

      var notifPage = document.getElementById('page-notifications');
      if (notifPage) {
        AppCache.attachPullToRefresh(notifPage, function() {
          return loadNotifications({ bypass: true });
        });
      }

      var detailPage = document.getElementById('page-story-detail');
      if (detailPage) {
        AppCache.attachPullToRefresh(detailPage, function() {
          if (!currentDetailStory) return Promise.resolve();
          return loadComments(currentDetailStory.id, { bypass: true });
        });
      }
    }

  } catch (e) {
    console.error('App boot error:', e);
    var splash = document.getElementById('splash-screen');
    if (splash) splash.classList.add('hidden');
    var appEl = document.getElementById('app');
    if (appEl) appEl.classList.remove('hidden');
  }
});

// ── Navigation ────────────────────────────────────────────────────────────────

var ALL_PAGES = ['home', 'library', 'profile', 'story-detail', 'player', 'notifications', 'about', 'login', 'policy'];
var MAIN_PAGES = ['home', 'library', 'profile'];

function showPage(name) {
  if (name !== currentPage) {
    pageHistory.push(currentPage);
  }

  ALL_PAGES.forEach(function(p) {
    var el = document.getElementById('page-' + p);
    if (el) {
      el.classList.remove('active');
      el.classList.remove('slide-in-left');
    }
  });

  var target = document.getElementById('page-' + name);
  if (target) target.classList.add('active');

  // Lock body scroll when login overlay is open — prevents page behind from shifting
  if (name === 'login') {
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';
  } else {
    document.body.style.overflow = '';
    document.body.style.touchAction = '';
  }

  currentPage = name;
  window.currentPage = name;

  // Bottom nav active state
  document.querySelectorAll('.nav-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.page === name);
  });

  // Header visibility
  var header = document.getElementById('app-header');
  if (header) {
    header.style.display = MAIN_PAGES.includes(name) ? 'flex' : 'none';
  }

  // ── Mini Player Logic ──
  var mp = document.getElementById('mini-player');
  if (mp) {
    if (name === 'player') {
      // Always hide on full player page
      mp.classList.add('hidden');
    } else {
      // Show only if something is loaded/playing
      if (window.currentStory) {
        mp.classList.remove('hidden');
      }
    }
  }

  // ── Video behavior on page change ──
  // When leaving player page, keep audio playing but pause video visually
  if (name !== 'player' && window.isVideoMode && window.playerVideo) {
    // Video audio continues via audio track, video element itself may pause
    // We let it continue since page is still in DOM
  }

  // Page-specific init
  if (name === 'library') {
    initLibrary();
    renderContinueWatching();
    if (typeof initSocialBarAd === 'function') initSocialBarAd();
  } else if (name === 'profile') {
    if (typeof initSocialBarAd === 'function') initSocialBarAd();
  } else if (name === 'notifications') {
    updateNotifBadge(0); // Clear badge instantly — don't wait for network fetch
    loadNotifications();
  } else if (name === 'home') {
    renderContinueWatching();
  } else if (name === 'policy') {
    if (typeof initPolicyPage === 'function') initPolicyPage();
  }

  // Clean up policy page polling/callbacks when navigating away from it
  if (name !== 'policy' && typeof cleanupPolicyPage === 'function') {
    cleanupPolicyPage();
  }

  // Player page layout reset
  if (name === 'player') {
    var playerPage = document.getElementById('page-player');
    if (playerPage) void playerPage.offsetHeight;

    setTimeout(function() {
      window.dispatchEvent(new Event('resize'));
    }, 50);
  }
}

function goBack() {
  if (pageHistory.length > 0) {
    var prev = pageHistory.pop();

    ALL_PAGES.forEach(function(p) {
      var el = document.getElementById('page-' + p);
      if (el) el.classList.remove('active');
    });

    var target = document.getElementById('page-' + prev);
    if (target) target.classList.add('active');

    currentPage = prev;
    window.currentPage = prev;

    var isMain = MAIN_PAGES.includes(prev);
    document.querySelectorAll('.nav-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.page === prev);
    });

    var header = document.getElementById('app-header');
    if (header) header.style.display = isMain ? 'flex' : 'none';

    // Mini player visibility on back
    var mp = document.getElementById('mini-player');
    if (mp) {
      if (prev === 'player') {
        mp.classList.add('hidden');
      } else if (window.currentStory) {
        mp.classList.remove('hidden');
      }
    }

    // Clean up policy page when navigating back away from it
    if (prev !== 'policy' && typeof cleanupPolicyPage === 'function') {
      cleanupPolicyPage();
    }

    // Page-specific init on back
    if (prev === 'library') {
      initLibrary();
      renderContinueWatching();
    } else if (prev === 'home') {
      renderContinueWatching();
    } else if (prev === 'policy') {
      if (typeof initPolicyPage === 'function') initPolicyPage();
    }
  } else {
    showPage('home');
  }
}

window.addEventListener('popstate', function() { goBack(); });

// ── Story Detail ──────────────────────────────────────────────────────────────

async function openStoryDetail(storyId) {
  if (window.__debugHook) window.__debugHook('PERF_START', { label: 'storyOpen' });
  // Popunder — once per 24 hours, non-blocking
  if (typeof triggerPopunderAd === 'function') triggerPopunderAd();

  showPage('story-detail');

  document.getElementById('detail-banner').src = '';
  document.getElementById('detail-title').textContent = 'Loading…';
  document.getElementById('detail-views-count').textContent = '0';
  document.getElementById('detail-ep-count').textContent = '0';
  document.getElementById('detail-likes-count').textContent = '0';
  document.getElementById('comments-list').innerHTML = '';

  var story = await fetchStoryById(storyId);
  if (!story) { showToast('Story not found'); goBack(); return; }

  currentDetailStory = story;

  var thumb = story.image_url || '';
  var bannerEl = document.getElementById('detail-banner');
  if (bannerEl) { bannerEl.src = thumb; bannerEl.style.display = thumb ? '' : 'none'; }
  document.getElementById('detail-title').textContent = story.title || '';
  document.getElementById('detail-views-count').textContent = formatCount(story.views_count || 0);
  // Fetch real count from likes table — never use stale stories.likes_count
  fetchLikesCount(storyId).then(function(realCount) {
    currentDetailStory.likes_count = realCount;
    var el = document.getElementById('detail-likes-count');
    if (el) el.textContent = formatCount(realCount);
    console.log('[DETAIL] real likes count from DB:', realCount);
  });

  // Efficient count-only query — no episode rows needed just for the number
  if (window.__debugHook) window.__debugHook('PERF_START', { label: 'episode' });
  var epCount = await fetchEpisodeCount(storyId);
  _epTotalCount = epCount;
  document.getElementById('detail-ep-count').textContent = epCount;
  console.log('[DETAIL] Episode count from DB:', epCount);
  if (window.__debugHook) window.__debugHook('EPISODE_DEBUG', { storyId: storyId, episodeCount: epCount });

  subscribeToEpisodes(storyId);
  if (window.__debugHook) window.__debugHook('PERF_END', { label: 'episode' });

  var isLiked = await getLikeStatus(storyId);
  var likeBtn = document.getElementById('detail-like-btn');
  if (likeBtn) likeBtn.classList.toggle('liked', isLiked);

  var isSaved = getLibraryStatus(storyId);
  updateLibraryBtn(isSaved);

  var progress = getStoryProgress(storyId);
  var playBtn = document.getElementById('play-btn-label');
  if (progress && progress.current_time > 10) {
    var mins = Math.floor(progress.current_time / 60);
    var secs = Math.floor(progress.current_time % 60);
    if (playBtn) playBtn.textContent = 'Continue from ' + mins + ':' + (secs < 10 ? '0' : '') + secs;
  } else {
    if (playBtn) playBtn.textContent = 'Start Listening';
  }

  loadComments(storyId);

  if (typeof initNativeAd === 'function') setTimeout(initNativeAd, 400);
  if (window.__debugHook) window.__debugHook('PERF_END', { label: 'storyOpen' });
}

function updateLibraryBtn(isSaved) {
  var btn = document.getElementById('detail-library-btn');
  if (!btn) return;
  if (isSaved) {
    btn.classList.add('saved');
    btn.querySelector('span').textContent = 'Saved';
  } else {
    btn.classList.remove('saved');
    btn.querySelector('span').textContent = 'Add to Library';
  }
}

async function toggleLike() {
  if (!currentDetailStory) return;
  var newState = await toggleLikeDB(currentDetailStory.id);

  // null = user not logged in → redirect to login
  if (newState === null) {
    showToast('Please login to like');
    openLoginPage();
    return;
  }

  // 'error:...' string = real DB error — surface the actual message
  if (typeof newState === 'string' && newState.startsWith('error:')) {
    var errMsg = newState.replace('error:', '');
    console.error('[LIKE] DB error in toggleLike:', errMsg);
    if (errMsg.indexOf('does not exist') !== -1 || errMsg.indexOf('relation') !== -1) {
      showToast('Likes table missing in database');
    } else if (errMsg.indexOf('violates') !== -1 || errMsg.indexOf('policy') !== -1) {
      showToast('Like blocked by database policy — check RLS');
    } else {
      showToast('Like failed: ' + errMsg);
    }
    return;
  }

  // true/false = confirmed DB insert/delete succeeded — now update UI
  var likeBtn = document.getElementById('detail-like-btn');
  if (likeBtn) likeBtn.classList.toggle('liked', newState);

  // Fetch REAL count directly from likes table (not from stories.likes_count which
  // depends on an RPC that may not exist). This is the ground-truth row count.
  try {
    var countRes = await _sb
      .from('likes')
      .select('*', { count: 'exact', head: true })
      .eq('story_id', Number(currentDetailStory.id));
    console.log('[LIKE] real count response:', JSON.stringify(countRes));

    if (countRes.error) {
      console.error('[LIKE] count fetch error:', countRes.error);
      throw new Error(countRes.error.message);
    }

    var realCount = (countRes.count !== null && countRes.count !== undefined)
      ? countRes.count : null;

    if (realCount !== null) {
      currentDetailStory.likes_count = realCount;
      document.getElementById('detail-likes-count').textContent = formatCount(realCount);
      console.log('[LIKE] UI count updated from DB:', realCount);
    } else {
      throw new Error('count null');
    }
  } catch (e) {
    console.warn('[LIKE] Could not fetch real count, using local fallback:', e.message);
    var count = parseInt(currentDetailStory.likes_count || 0);
    count = newState ? count + 1 : Math.max(count - 1, 0);
    currentDetailStory.likes_count = count;
    document.getElementById('detail-likes-count').textContent = formatCount(count);
  }

  showToast(newState ? '❤️ Liked!' : 'Like removed');
}

async function toggleLibrary() {
  if (!currentDetailStory) return;
  var newState = await toggleLibraryDB(currentDetailStory);
  updateLibraryBtn(newState);
  showToast(newState ? 'Added to library!' : 'Removed from library');
}

async function playFromDetail() {
  if (!currentDetailStory) return;

  // ── Pre-playback token check — blocks BEFORE audio starts ────────────────
  if (typeof checkPlayAllowed === 'function') {
    var allowed = await checkPlayAllowed();
    if (allowed === 'daily_limit') {
      showToast('Daily server limit reached. Please try again next day.');
      return;
    }
    if (allowed === 'hourly_limit') {
      showToast('Hourly server limit reached. Please try again next hour.');
      return;
    }
  }

  // Use already-fetched total count, or re-fetch if needed
  var total = (_epTotalCount > 0) ? _epTotalCount : await fetchEpisodeCount(currentDetailStory.id);
  _epTotalCount = total;

  // Determine which batch to load based on saved progress episode_number.
  // batchOffset = floor((epNum-1)/10)*10 maps ep 1-10→0, 11-20→10, 45→40, etc.
  var progress = getStoryProgress(currentDetailStory.id);
  var batchOffset = 0;
  if (progress && progress.episode_number) {
    batchOffset = Math.floor((progress.episode_number - 1) / 10) * 10;
  }

  // Fetch exactly 10 episodes — never the full story at once
  var episodes = await fetchEpisodeBatch(currentDetailStory.id, batchOffset);

  if (!episodes || !episodes.length) {
    showToast('No episodes available');
    return;
  }

  var startIdx = 0;
  if (progress) {
    for (var i = 0; i < episodes.length; i++) {
      if (String(episodes[i].id) === String(progress.episode_id)) { startIdx = i; break; }
    }
  }

  var startTime = (progress && progress.current_time > 10) ? progress.current_time : 0;

  // Show player page FIRST so it is in the DOM before playEpisode runs
  showPage('player');

  // Yield one frame so the CSS transition has committed the page into view
  await new Promise(function(resolve) { requestAnimationFrame(resolve); });

  var ep = episodes[startIdx];
  // Pass batchOffset so the player knows where to continue fetching
  playEpisode(currentDetailStory, ep, episodes, startIdx, total, batchOffset);
  if (startTime > 0) {
    setTimeout(function() { resumeAt(startTime); }, 300);
  }
}

// ── Comments ──────────────────────────────────────────────────────────────────

async function loadComments(storyId, opts) {
  opts = opts || {};
  if (window.__debugHook) window.__debugHook('PERF_START', { label: 'comments' });
  var list = document.getElementById('comments-list');
  if (!list) return;

  var comments = await fetchComments(storyId, { bypass: opts.bypass });
  if (window.__debugHook) window.__debugHook('PERF_END', { label: 'comments' });
  if (!comments.length) {
    list.innerHTML = '<div class="empty-state">No comments yet. Be the first!</div>';
    return;
  }

  list.innerHTML = comments.map(function(c) {
    // Use user_name column — never show raw UUID
    var author = c.user_name || 'User';
    var time = formatRelativeTime(c.created_at);
    return '<div class="comment-item">' +
      '<div class="comment-meta">' +
        '<span class="comment-author">' + escapeHtml(author) + '</span>' +
        '<span class="comment-time">' + time + '</span>' +
      '</div>' +
      '<div class="comment-text">' + escapeHtml(c.comment || '') + '</div>' +
    '</div>';
  }).join('');
}

async function submitComment() {
  if (!currentDetailStory) return;
  var input = document.getElementById('comment-input');
  var text = input.value.trim();
  if (!text) return;

  // Check auth before even trying — gives instant feedback
  var user = await getAuthUser();
  console.log('[COMMENT] submitComment — user:', user ? user.id : 'not logged in');
  if (!user) {
    showToast('Please login to comment');
    openLoginPage();
    return;
  }

  var comment = await postComment(currentDetailStory.id, text);

  // null = blocked before reaching DB
  if (!comment) {
    showToast('Comment failed — not logged in or Supabase offline');
    return;
  }

  // { _error: '...' } = DB returned an error — show the real reason
  if (comment._error) {
    console.error('[COMMENT] DB error:', comment._error);
    showToast('Comment error: ' + comment._error);
    return;
  }

  // Success — only update UI after confirmed DB insert
  input.value = '';
  var list = document.getElementById('comments-list');
  // Use user_name saved in DB — never show raw UUID
  var author = comment.user_name || 'User';
  var newItem = document.createElement('div');
  newItem.className = 'comment-item';
  newItem.innerHTML = '<div class="comment-meta">' +
    '<span class="comment-author">' + escapeHtml(author) + '</span>' +
    '<span class="comment-time">Just now</span>' +
  '</div><div class="comment-text">' + escapeHtml(text) + '</div>';
  if (list.firstChild && list.firstChild.className === 'empty-state') list.innerHTML = '';
  list.insertBefore(newItem, list.firstChild);
  showToast('Comment posted!');
}

// ── Realtime Episodes ─────────────────────────────────────────────────────────

var _episodeChannel = null;

function subscribeToEpisodes(storyId) {
  if (!_sb) return;
  if (_episodeChannel) { _sb.removeChannel(_episodeChannel); _episodeChannel = null; }
  _episodeChannel = _sb.channel('episodes:' + storyId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'episodes', filter: 'story_id=eq.' + storyId }, function(payload) {
      var countEl = document.getElementById('detail-ep-count');
      if (countEl && currentDetailStory && String(currentDetailStory.id) === String(storyId)) {
        var current = parseInt(countEl.textContent || '0');
        countEl.textContent = current + 1;
        console.log('[REALTIME] New episode added — count now:', current + 1);
      }
    })
    .subscribe();
}

// ── Realtime Comments ─────────────────────────────────────────────────────────

function subscribeToComments(storyId) {
  if (!_sb) return;
  _sb.channel('comments:' + storyId)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: 'story_id=eq.' + storyId }, function(payload) {
      if (!currentDetailStory || currentDetailStory.id != storyId) return;
      var c = payload.new;
      var list = document.getElementById('comments-list');
      if (!list) return;
      var newItem = document.createElement('div');
      newItem.className = 'comment-item';
      newItem.innerHTML = '<div class="comment-meta">' +
        '<span class="comment-author">' + escapeHtml(c.user_name || 'User') + '</span>' +
        '<span class="comment-time">Just now</span>' +
      '</div><div class="comment-text">' + escapeHtml(c.comment || '') + '</div>';
      if (list.firstChild && list.firstChild.className === 'empty-state') list.innerHTML = '';
      list.insertBefore(newItem, list.firstChild);
    })
    .subscribe();
}

// ── Toast ─────────────────────────────────────────────────────────────────────

var toastEl = null;
var toastTimer = null;

function showToast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { toastEl.classList.remove('show'); }, 2500);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

function updateNotifBadge(count) {
  var badge = document.getElementById('notif-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}
