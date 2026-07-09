// Ads Manager — Safe JS Injection
// Uses correct atOptions + highperformanceformat.com invoke.js pattern
// Sequential loading prevents atOptions race conditions

// ── 1. SLIDER AD — 3rd slide (300x250) ────────────────────────────────────────

function buildSliderAdSlide() {
  var div = document.createElement('div');
  div.className = 'slide slide-ad';
  div.innerHTML =
    '<div class="slide-card-outer" style="max-width:100%">' +
      '<div class="slide-card-inner slide-ad-inner">' +
        '<div class="slider-ad-wrap" id="slider-ad-container">' +
        '</div>' +
      '</div>' +
    '</div>';
  return div;
}

function injectSliderAd(onDone) {
  if (window._sliderAdLoaded) { if (onDone) onDone(); return; }
  window._sliderAdLoaded = true;

  var container = document.getElementById('slider-ad-container');
  if (!container) { if (onDone) onDone(); return; }

  try {
    var sOpts = document.createElement('script');
    sOpts.textContent = [
      "window.atOptions = {",
      "  'key' : '52c522754c6a6577e2fcc877e53a368a',",
      "  'format' : 'iframe',",
      "  'height' : 250,",
      "  'width' : 300,",
      "  'params' : {}",
      "};"
    ].join('');
    container.appendChild(sOpts);

    var sInvoke = document.createElement('script');
    sInvoke.src = 'https://www.highperformanceformat.com/52c522754c6a6577e2fcc877e53a368a/invoke.js';
    sInvoke.onerror = function() {
      console.log('[ADS] Slider ad failed');
      if (onDone) onDone();
    };
    sInvoke.onload = function() {
      console.log('[ADS] Slider ad loaded ✓');
      if (onDone) onDone();
    };
    container.appendChild(sInvoke);
  } catch (e) {
    console.log('[ADS] Slider ad error:', e.message);
    if (onDone) onDone();
  }
}

// Called from home.js after slides are built
function insertSliderAd(track, dots, currentTotalSlides) {
  if (!track) return currentTotalSlides;
  try {
    var adSlide = buildSliderAdSlide();
    var existingSlides = track.children;

    if (existingSlides.length >= 2) {
      var refNode = existingSlides[2] || null;
      track.insertBefore(adSlide, refNode);
    } else {
      track.appendChild(adSlide);
    }

    if (dots) {
      var adDot = document.createElement('div');
      adDot.className = 'dot';
      var insertIdx = Math.min(2, dots.children.length);
      dots.insertBefore(adDot, dots.children[insertIdx] || null);
      Array.from(dots.children).forEach(function(d, i) {
        d.onclick = function() { goToSlide(i); };
      });
    }

    var newTotal = track.children.length;
    // Load slider ad, then trending banner sequentially to avoid atOptions clash
    setTimeout(function() {
      injectSliderAd(function() {
        initTrendingBannerAd();
      });
    }, 300);

    return newTotal;
  } catch (e) {
    console.log('[ADS] insertSliderAd error:', e.message);
    return currentTotalSlides;
  }
}

// ── 2. TRENDING BANNER AD (320x50) ───────────────────────────────────────────

function initTrendingBannerAd() {
  if (window._trendingAdLoaded) return;
  window._trendingAdLoaded = true;

  var container = document.getElementById('trending-banner-container');
  if (!container) return;

  try {
    var sOpts = document.createElement('script');
    sOpts.textContent = [
      "window.atOptions = {",
      "  'key' : '57938575000df9c4bb169d174f6e3705',",
      "  'format' : 'iframe',",
      "  'height' : 50,",
      "  'width' : 320,",
      "  'params' : {}",
      "};"
    ].join('');
    container.appendChild(sOpts);

    var sInvoke = document.createElement('script');
    sInvoke.src = 'https://www.highperformanceformat.com/57938575000df9c4bb169d174f6e3705/invoke.js';
    sInvoke.onerror = function() { console.log('[ADS] Trending banner failed'); };
    sInvoke.onload = function() { console.log('[ADS] Trending banner loaded ✓'); };
    container.appendChild(sInvoke);
  } catch (e) {
    console.log('[ADS] Trending banner error:', e.message);
  }
}

// ── 3. NATIVE AD — above comment box ─────────────────────────────────────────

function initNativeAd() {
  var container = document.getElementById('native-ad-container');
  if (!container) return;

  // Already injected — skip
  if (container.querySelector('script')) return;

  try {
    container.innerHTML = '';

    var inner = document.createElement('div');
    inner.id = 'container-9b1996e91321058bd0b73274ce0d78a2';
    container.appendChild(inner);

    var s = document.createElement('script');
    s.async = true;
    s.setAttribute('data-cfasync', 'false');
    s.src = 'https://pl29548231.effectivecpmnetwork.com/9b1996e91321058bd0b73274ce0d78a2/invoke.js';
    s.onerror = function() { console.log('[ADS] Native ad failed'); };
    s.onload = function() { console.log('[ADS] Native ad loaded ✓'); };
    container.appendChild(s);
    console.log('[ADS] Native ad injected');
  } catch (e) {
    console.log('[ADS] Native ad error:', e.message);
  }
}

// ── 4. POPUNDER AD — once per 24 hours, triggered on story click ──────────────

var _popunderInjected = false;

function triggerPopunderAd() {
  try {
    var STORAGE_KEY = 'emperor_popunder_last';
    var INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

    var last = parseInt(localStorage.getItem(STORAGE_KEY) || '0', 10);
    var now  = Date.now();

    // Still within 24-hour cooldown — skip
    if (last && (now - last) < INTERVAL_MS) {
      console.log('[ADS] Popunder skipped — cooldown active');
      return;
    }

    // Already injected this session — skip
    if (_popunderInjected) {
      console.log('[ADS] Popunder skipped — already injected');
      return;
    }

    _popunderInjected = true;
    localStorage.setItem(STORAGE_KEY, String(now));

    var s = document.createElement('script');
    s.setAttribute('data-cfasync', 'false');
    s.src = 'https://pl29548230.effectivecpmnetwork.com/d6/45/d1/d645d15f908b5a06fdd649ddf174643b.js';
    s.onerror = function() { console.log('[ADS] Popunder failed'); };
    s.onload  = function() { console.log('[ADS] Popunder loaded ✓'); };
    document.head.appendChild(s);
    console.log('[ADS] Popunder injected');
  } catch (e) {
    console.log('[ADS] Popunder error:', e.message);
  }
}

// ── 5. SOCIAL BAR AD — fixed bottom (Library + Profile pages) ─────────────────

function initSocialBarAd() {
  if (window._socialBarLoaded) return;
  window._socialBarLoaded = true;

  try {
    var s = document.createElement('script');
    s.setAttribute('data-cfasync', 'false');
    s.src = 'https://pl29548229.effectivecpmnetwork.com/7e/03/c9/7e03c9f2d9a8c3412aa43c78518c572f.js';
    s.onerror = function() { console.log('[ADS] Social bar failed'); };
    s.onload = function() { console.log('[ADS] Social bar loaded ✓'); };
    document.head.appendChild(s);
  } catch (e) {
    console.log('[ADS] Social bar error:', e.message);
  }
}
