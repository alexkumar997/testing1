// Library Module

async function initLibrary() {
  await renderLikedStories();
  await renderSavedStories();
}

async function renderLikedStories() {
  const grid = document.getElementById('liked-stories');
  if (!grid) return;

  grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Loading...</div>';

  const userId = getCurrentUserId();
  const likedIds = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('liked_' + userId + '_')) {
      const storyId = key.replace('liked_' + userId + '_', '');
      likedIds.push(storyId);
    }
  }

  if (!likedIds.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No liked stories yet</div>';
    return;
  }

  const stories = await fetchStoriesByIds(likedIds);

  if (!stories.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No liked stories yet</div>';
    return;
  }

  grid.innerHTML = stories.map(s => renderGridCard(s)).join('');
  // Patch with real counts from likes table (one batch query)
  fetchLikesCountMap(stories.map(s => s.id)).then(patchLikesBadges);
}

async function renderSavedStories() {
  const grid = document.getElementById('saved-stories');
  if (!grid) return;

  grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">Loading...</div>';

  const savedIds = getSavedStories();

  if (!savedIds.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No saved stories yet</div>';
    return;
  }

  const stories = await fetchStoriesByIds(savedIds);

  if (!stories.length) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">No saved stories yet</div>';
    return;
  }

  grid.innerHTML = stories.map(s => renderGridCard(s)).join('');
  // Patch with real counts from likes table (one batch query)
  fetchLikesCountMap(stories.map(s => s.id)).then(patchLikesBadges);
}

// storiesMap: pre-fetched { id: storyObject } from renderContinueWatching
function renderLibraryContinue(history, storiesMap) {
  const list = document.getElementById('library-continue-list');
  const section = document.getElementById('library-continue-section');
  if (!list || !section) return;

  if (!history || !history.length) {
    section.style.display = 'none';
    return;
  }

  storiesMap = storiesMap || {};

  const cards = history.slice(0, 10).map(h => {
    const story = storiesMap[String(h.story_id)];
    if (!story) return '';
    const pct = h.duration > 0 ? Math.min((h.current_time / h.duration) * 100, 100) : 0;
    const thumb = story.image_url || '';
    const remaining = h.duration > 0 ? Math.max(h.duration - h.current_time, 0) : 0;
    const remainingText = remaining > 60
      ? Math.round(remaining / 60) + ' min left'
      : Math.round(remaining) + ' sec left';

    return `<div class="continue-card" onclick="resumeStory('${h.story_id}', '${h.episode_id}')">
      <div class="continue-thumb-wrap">
        ${thumb ? `<img src="${thumb}" alt="${story.title || ''}" loading="lazy">` : '<div class="thumb-placeholder"></div>'}
      </div>
      <div class="continue-info">
        <div class="continue-story-name">${story.title || ''}</div>
        <div class="continue-ep">Ep ${h.episode_number || 1}</div>
        <div class="continue-time">${remainingText}</div>
        <div class="continue-progress">
          <div class="continue-progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    </div>`;
  }).filter(Boolean).join('');

  if (!cards) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  list.innerHTML = cards;
}

function renderGridCard(s) {
  if (!s) return '';
  const thumb = s.image_url || '';
  return `<div class="grid-card" onclick="openStoryDetail(${s.id})">
    <div class="grid-thumb-wrap">
      ${thumb
        ? `<img src="${thumb}" alt="${s.title || ''}" loading="lazy">`
        : '<div class="thumb-placeholder" style="width:100%;padding-top:100%;background:var(--surface)"></div>'}
      <div class="grid-overlay">
        <span class="grid-badge">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          ${formatCount(s.views_count || 0)}
        </span>
        <span class="grid-badge" data-likes-sid="${s.id}">
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          0
        </span>
      </div>
    </div>
    <div class="grid-info">
      <div class="grid-name">${s.title || 'Untitled'}</div>
    </div>
  </div>`;
}
