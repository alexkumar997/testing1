// ── Emperor FM — Central Configuration ────────────────────────────────────────
// This is the SINGLE SOURCE OF TRUTH for all Supabase credentials.
//
// Works identically on Replit, Netlify, GitHub Pages, and any other host.
// No server-side injection. No environment variables. No build step.
// The browser loads this file directly before any application code runs.
//
// ── Main Supabase ─────────────────────────────────────────────────────────────
// Stores: stories, profiles, slides, likes, comments, notifications, library.
// Never used for episodes.
//
// ── Episode Supabases ─────────────────────────────────────────────────────────
// Each object covers a non-overlapping range of Story IDs.
// Routing: story_id determines which Supabase is queried (O(1), no fallback).
// The Main Supabase is NEVER queried for episodes.
//
// ── To add a new Episode Supabase ────────────────────────────────────────────
// Add ONE object to the __EPISODE_SUPABASES__ array below.
// No other file needs to change.
//
//   {
//     name:       'Episode Supabase 3',
//     storyStart: 41,
//     storyEnd:   60,
//     url:        'https://yourproject.supabase.co',
//     key:        'sb_publishable_your-anon-key-here'
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

// Main Supabase
window.__SUPABASE_URL__ = 'https://vlmdlhojjuogsnrxzmng.supabase.co';
window.__SUPABASE_KEY__ = 'sb_publishable__xQrpHqN02NSdYRadFuSJg_T3RpKxmc';

// Episode Supabases — Story ID routing
window.__EPISODE_SUPABASES__ = [
  {
    name:       'Episode Supabase 1',
    storyStart: 1,
    storyEnd:   10,
    url:        'https://kdsmutiifajcxfljwwgt.supabase.co',
    key:        'sb_publishable_FGkffF-jV67xtCWHZ5SUPA_Ado3OLAU'
  },
  {
    name:       'Episode Supabase 2',
    storyStart: 11,
    storyEnd:   20,
    url:        'https://xvtzmeisxwjidicyvucm.supabase.co',
    key:        'sb_publishable_POqvj6BVph4mQ0O42AQGug_Mbeo2IkZ'
  }
];
