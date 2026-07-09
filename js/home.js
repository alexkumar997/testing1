// Home Page Module
var sliderInterval = null;
var currentSlide = 0;
var totalSlides = 0;
var currentCategory = 'all';
var sliderPaused = false;
var sliderResumeTimer = null;

// ── Slider (Supabase slides table ONLY — no fallback) ─────────────────────────

async function initSlider(opts) {
  opts = opts || {};
  var track = document.getElementById('slider-track');
  var dots = document.getElementById('slider-dots');
  if (!track) return;

  var slides = await fetchSlides(5, { bypass: opts.bypass });

  if (!slides.length) {
    // Slides table is empty — show clean empty state
    track.innerHTML =
      '<div class="slide">' +
        '<div class="slide-card-outer" style="max-width:100%">' +
          '<div class="slide-card-inner">' +
            '<div class="ad-slide-content">' +
              '<div style="font-size:36px;margin-bottom:10px">🎧</div>' +
              '<div style="font-size:18px;font-weight:800;margin-bottom:6px">Emperor FM</div>' +
              '<div style="font-size:14px;opacity:0.88">Stories coming soon</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    if (dots) dots.innerHTML = '';
    totalSlides = 1;
    startSlider();
    // No slider ad — load trending banner directly (no atOptions conflict)
    if (typeof initTrendingBannerAd === 'function') setTimeout(initTrendingBannerAd, 300);
    return;
  }

  totalSlides = slides.length;

  track.innerHTML = slides.map(function(sl) {
    var click = sl.story_id ? 'onclick="openStoryDetail(' + sl.story_id + ')"' : '';
    var thumb = sl.image_url || '';
    var title = sl.title || '';
    var subtitle = sl.subtitle || sl.description || '';
    return '<div class="slide" ' + click + '>' +
      '<div class="slide-card-outer" style="max-width:100%">' +
        '<div class="slide-card-inner">' +
          '<div class="slide-img-wrap">' +
            (thumb ? '<img src="' + thumb + '" alt="' + title + '" loading="lazy">' : '') +
            '<div class="slide-overlay">' +
              '<div class="slide-title">' + title + '</div>' +
              (subtitle ? '<div class="slide-subtitle">' + subtitle + '</div>' : '') +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  if (dots) {
    dots.innerHTML = slides.map(function(_, i) {
      return '<div class="dot ' + (i === 0 ? 'active' : '') + '" onclick="goToSlide(' + i + ')"></div>';
    }).join('');
  }

  // Insert ad at 3rd slide position
  if (typeof insertSliderAd === 'function') {
    totalSlides = insertSliderAd(track, dots, totalSlides);
  }

  initSliderSwipe(track);
  startSlider();
}

function startSlider() {
  if (sliderInterval) clearInterval(sliderInterval);
  sliderInterval = setInterval(function() {
    if (!sliderPaused) {
      currentSlide = (currentSlide + 1) % totalSlides;
      updateSlider();
    }
  }, 5000);
}

function pauseSlider() {
  sliderPaused = true;
  if (sliderResumeTimer) clearTimeout(sliderResumeTimer);
  sliderResumeTimer = setTimeout(function() { sliderPaused = false; }, 4000);
}

function goToSlide(idx) {
  currentSlide = idx;
  updateSlider();
  pauseSlider();
}

function updateSlider() {
  var track = document.getElementById('slider-track');
  if (track) track.style.transform = 'translateX(-' + (currentSlide * 100) + '%)';
  document.querySelectorAll('.dot').forEach(function(d, i) {
    d.classList.toggle('active', i === currentSlide);
  });
}

// ── Swipe Detection ───────────────────────────────────────────────────────────

function initSliderSwipe(track) {
  var wrapper = track.parentElement;
  if (!wrapper) return;

  var startX = 0, startY = 0, isDragging = false, isHorizontal = null;

  wrapper.addEventListener('touchstart', function(e) {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    isDragging = true;
    isHorizontal = null;
  }, { passive: true });

  wrapper.addEventListener('touchmove', function(e) {
    if (!isDragging) return;
    var dx = e.touches[0].clientX - startX;
    var dy = e.touches[0].clientY - startY;
    if (isHorizontal === null) isHorizontal = Math.abs(dx) > Math.abs(dy);
    if (isHorizontal) e.preventDefault();
  }, { passive: false });

  wrapper.addEventListener('touchend', function(e) {
    if (!isDragging) return;
    isDragging = false;
    if (!isHorizontal) return;
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) {
      pauseSlider();
      currentSlide = dx < 0
        ? (currentSlide + 1) % totalSlides
        : (currentSlide - 1 + totalSlides) % totalSlides;
      updateSlider();
    }
  }, { passive: true });

  var mouseStartX = 0, mouseDown = false;
  wrapper.addEventListener('mousedown', function(e) { mouseStartX = e.clientX; mouseDown = true; e.preventDefault(); });
  wrapper.addEventListener('mouseup', function(e) {
    if (!mouseDown) return;
    mouseDown = false;
    var dx = e.clientX - mouseStartX;
    if (Math.abs(dx) > 40) {
      pauseSlider();
      currentSlide = dx < 0
        ? (currentSlide + 1) % totalSlides
        : (currentSlide - 1 + totalSlides) % totalSlides;
      updateSlider();
    }
  });
  wrapper.addEventListener('mouseleave', function() { mouseDown = false; });
}

// ── Continue Watching (fetches story data from Supabase) ──────────────────────

async function renderContinueWatching() {
  var container = document.getElementById('continue-list');
  var section = document.getElementById('continue-section');
  if (!container || !section) return;

  // ── Sync from Supabase first (logged-in users) ─────────────────────────────
  // Merges remote progress into localStorage before rendering, so APK reinstall
  // and multi-device login both pick up the correct position automatically.
  if (typeof syncContinueWatchingFromSupabase === 'function') {
    await syncContinueWatchingFromSupabase();
  }
  // ─────────────────────────────────────────────────────────────────────────────

  var history = getContinueWatching();

  if (!history.length) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  container.innerHTML = '<div style="padding:8px;color:var(--text-secondary);font-size:13px">Loading...</div>';

  // Batch-fetch all stories from Supabase (no localStorage story objects)
  var storyIds = history.map(function(h) { return h.story_id; });
  var stories = await fetchStoriesByIds(storyIds);
  var storiesMap = {};
  stories.forEach(function(s) { storiesMap[String(s.id)] = s; });

  var cards = history.slice(0, 15).map(function(h) {
    var story = storiesMap[String(h.story_id)];
    if (!story) return ''; // Story deleted or not found — skip
    var pct = h.duration > 0 ? Math.min((h.current_time / h.duration) * 100, 100) : 0;
    var remaining = h.duration > 0 ? Math.max(h.duration - h.current_time, 0) : 0;
    var remainingText = remaining > 60
      ? Math.round(remaining / 60) + ' min left'
      : Math.round(remaining) + ' sec left';
    var thumb = story.image_url || '';

    return '<div class="continue-card" onclick="resumeStory(\'' + h.story_id + '\', \'' + h.episode_id + '\')">' +
      '<div class="continue-thumb-wrap">' +
        (thumb ? '<img src="' + thumb + '" alt="' + (story.title || '') + '" loading="lazy">' : '<div class="thumb-placeholder"></div>') +
      '</div>' +
      '<div class="continue-info">' +
        '<div class="continue-story-name">' + (story.title || '') + '</div>' +
        '<div class="continue-ep">Ep ' + (h.episode_number || 1) + '</div>' +
        '<div class="continue-time">' + remainingText + '</div>' +
        '<div class="continue-progress">' +
          '<div class="continue-progress-fill" style="width:' + pct + '%"></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).filter(Boolean).join('');

  container.innerHTML = cards || '<div style="padding:8px;color:var(--text-secondary);font-size:13px">Nothing yet</div>';

  renderLibraryContinue(history, storiesMap);
}

async function resumeStory(storyId, episodeId) {
  var history = getContinueWatching();
  var h = null;
  for (var i = 0; i < history.length; i++) {
    if (String(history[i].story_id) === String(storyId)) { h = history[i]; break; }
  }
  if (!h) return;

  // Always fetch story fresh from Supabase
  var story = await fetchStoryById(storyId);
  if (!story) { showToast('Story not found'); return; }

  // Get total episode count — router uses story_id directly, one request
  var total = await fetchEpisodeCount(storyId);
  if (total === null) { showToast('Episode temporarily unavailable.'); return; }
  _epTotalCount = total;

  // Find the batch that contains the saved episode.
  // batchOffset = floor((epNum-1)/10)*10 maps ep 1-10→0, 11-20→10, 45→40, etc.
  var epNum = h.episode_number || 1;
  var batchOffset = Math.floor((epNum - 1) / 10) * 10;

  // Fetch exactly 10 episodes — never the full story at once
  var episodes = await fetchEpisodeBatch(storyId, batchOffset);
  if (episodes === null) { showToast('Episode temporarily unavailable.'); return; }
  if (!episodes.length)  { showToast('No episodes available'); return; }

  var epIdx = 0;
  for (var j = 0; j < episodes.length; j++) {
    if (String(episodes[j].id) === String(h.episode_id)) { epIdx = j; break; }
  }

  var savedTime = h.current_time || 0;
  // Pass batchOffset so the player knows where to continue fetching
  playEpisode(story, episodes[epIdx], episodes, epIdx, total, batchOffset);
  showPage('player');

  if (savedTime > 0) {
    setTimeout(function() { resumeAt(savedTime); }, 400);
  }
}

// ── Trending ──────────────────────────────────────────────────────────────────

async function renderTrending(opts) {
  opts = opts || {};
  var stories = await fetchTrending(10, { bypass: opts.bypass });
  var list = document.getElementById('trending-list');
  if (!list) return;

  if (!stories.length) {
    list.innerHTML = '<div class="empty-state">No trending stories</div>';
    return;
  }

  list.innerHTML = stories.map(function(s) {
    var thumb = s.image_url || '';
    return '<div class="story-card-h" onclick="openStoryDetail(' + s.id + ')">' +
      '<div class="story-thumb-wrap">' +
        (thumb ? '<img src="' + thumb + '" alt="' + (s.title || '') + '" loading="lazy">' : '<div class="thumb-placeholder"></div>') +
        '<div class="thumb-meta">' +
          '<span class="thumb-badge">' +
            '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
            formatCount(s.views_count) +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="story-card-info">' +
        '<div class="story-card-name">' + (s.title || '') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Categories ────────────────────────────────────────────────────────────────

function initCategories() {
  document.querySelectorAll('.cat-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.cat-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentCategory = tab.dataset.cat;
      loadCategoryStories(currentCategory);
    });
  });
  loadCategoryStories('all');
}

async function loadCategoryStories(category, opts) {
  opts = opts || {};
  if (window.__debugHook) window.__debugHook('PERF_START', { label: 'home' });
  var grid = document.getElementById('category-stories');
  if (!grid) return;

  grid.innerHTML = '<div class="grid-card skeleton" style="min-height:140px"></div>'.repeat(4);

  var stories = await fetchStories(category, 20, { bypass: opts.bypass });
  if (window.__debugHook) window.__debugHook('PERF_END', { label: 'home' });

  if (!stories.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-secondary)">No stories found</div>';
    return;
  }

  grid.innerHTML = stories.map(function(s) {
    var thumb = s.image_url || '';
    return '<div class="grid-card" onclick="openStoryDetail(' + s.id + ')">' +
      '<div class="grid-thumb-wrap">' +
        (thumb ? '<img src="' + thumb + '" alt="' + (s.title || '') + '" loading="lazy">' : '<div class="thumb-placeholder" style="width:100%;padding-top:100%;background:var(--surface)"></div>') +
        '<div class="grid-overlay">' +
          '<span class="grid-badge">' +
            '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
            formatCount(s.views_count) +
          '</span>' +
        '</div>' +
      '</div>' +
      '<div class="grid-info">' +
        '<div class="grid-name">' + (s.title || 'Untitled') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}
