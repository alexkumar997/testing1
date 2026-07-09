// Notifications Module

async function loadNotifications(opts) {
  opts = opts || {};
  if (window.__debugHook) window.__debugHook('PERF_START', { label: 'notifications' });
  var list = document.getElementById('notifications-list');
  if (!list) return;

  var notifs = await fetchNotifications({ bypass: opts.bypass });
  if (window.__debugHook) window.__debugHook('PERF_END', { label: 'notifications' });

  if (!notifs.length) {
    list.innerHTML = '<div class="empty-state">No notifications yet</div>';
    updateNotifBadge(0);
    return;
  }

  // Render all notifications immediately
  list.innerHTML = notifs.map(function(n) {
    var icon = getNotifIcon(n.type);
    var time = formatRelativeTime(n.created_at);
    return '<div class="notif-item ' + (n.read ? '' : 'unread') + '" ' +
      'onclick="handleNotifClick(\'' + n.id + '\', \'' + (n.story_id || '') + '\', \'' + (n.type || '') + '\')">' +
      '<div class="notif-icon">' + icon + '</div>' +
      '<div class="notif-body">' +
        '<div class="notif-title">' + (n.title || '') + '</div>' +
        '<div class="notif-msg">' + (n.message || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\\n/g,'<br>').replace(/\n/g,'<br>') + '</div>' +
        '<div class="notif-time">' + time + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Auto-mark ALL unread notifications as read when the page is opened
  var unread = notifs.filter(function(n) { return !n.read; });
  if (unread.length > 0) {
    // Update badge to 0 immediately — don't wait for DB
    updateNotifBadge(0);
    // Remove unread highlight from all items visually
    document.querySelectorAll('.notif-item.unread').forEach(function(el) {
      el.classList.remove('unread');
    });
    // Persist read state in DB for each unread notification
    unread.forEach(function(n) {
      markNotifRead(n.id);
    });
  } else {
    updateNotifBadge(0);
  }
}

function getNotifIcon(type) {
  var icons = {
    new_episode: '🔥',
    continue: '🎧',
    trending: '📈',
    new_story: '✨',
    milestone: '❤️'
  };
  return icons[type] || '🔔';
}

async function handleNotifClick(notifId, storyId, type) {
  // ── Analytics: notification_click ──────────────────────────────────────────
  logAnalyticsEvent('notification_click', {
    notif_id: String(notifId || ''),
    story_id: String(storyId || ''),
    type:     String(type    || '')
  });
  // ───────────────────────────────────────────────────────────────────────────

  // Mark as read in DB and visually
  markNotifRead(notifId);
  document.querySelectorAll('.notif-item').forEach(function(el) {
    if (el.getAttribute('onclick') && el.getAttribute('onclick').includes(notifId)) {
      el.classList.remove('unread');
    }
  });

  if (storyId) {
    openStoryDetail(storyId);
  }
}

// formatRelativeTime is defined in db.js — do not duplicate here

