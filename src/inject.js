// Twitch Rewind — Injected Page Script
// Injects rewind controls directly into Twitch's native player UI.
// Seekbar + LIVE appear in the native control bar.

(function () {
  'use strict';

  const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const VOD_CHECK_INTERVAL = 30000;
  const UI_TICK = 500;
  const FETCH_TIMEOUT = 10000;
  const SEEK_STEP = 10;
  const MIN_REWIND_SEC = 15;
  const HLS_RECOVERY_LIMIT = 3; // fatal-error recoveries allowed per minute
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const state = {
    enabled: true,
    channel: null,
    vodId: null,
    vodCreatedAt: null,
    vodUrl: null,        // pre-fetched VOD playback URL
    isRewinding: false,
    hlsInstance: null,
    hlsReady: false,     // manifest loaded, ready to seek instantly
    vodVideo: null,
    ui: {},
    uiTimer: null,         // watchdog tick: keeps the controls mounted and current
    vodCheckInterval: null,
    preloading: false,     // preload (URL fetch + HLS setup) in flight
    loadingRewind: false,  // rewind HLS setup in flight
    pendingSeek: null,     // seek requested while a load is in flight
    rewindSeq: 0,          // bumped by goLive so an in-flight rewind load knows it was cancelled
    subscribed: null,      // cached subscription check for the current channel
    vodMisses: 0,          // consecutive VOD checks that found no recording
  };

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function log(...args) {
    console.log('%c[TwitchRewind]', 'color: #9147ff; font-weight: bold', ...args);
  }

  function getAuthToken() {
    const match = document.cookie.match(/(?:^|;\s*)auth-token=([^;]+)/);
    return match ? match[1] : null;
  }

  // A hung request must not hold the in-flight guards (checkInFlight,
  // preloading, loadingRewind) forever
  function fetchWithTimeout(url, opts = {}) {
    const signal = AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT) : undefined;
    return fetch(url, { ...opts, signal });
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function elapsed() {
    if (!state.vodCreatedAt) return 0;
    return (Date.now() - new Date(state.vodCreatedAt).getTime()) / 1000;
  }

  // ─── GQL ────────────────────────────────────────────────────────────────────

  async function gql(body) {
    const headers = { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;
    const res = await fetchWithTimeout(GQL_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GQL ${res.status}`);
    return res.json();
  }

  function gqlError(data, what) {
    return new Error(`${what} failed${data?.errors?.length ? `: ${data.errors[0].message}` : ''}`);
  }

  // true/false, or null when the check itself failed (retried on the next poll)
  async function isSubscribed(login) {
    try {
      const data = await gql({
        query: `query($login:String!){user(login:$login){self{subscriptionBenefit{id}}}}`,
        variables: { login },
      });
      if (!data?.data?.user && data?.errors?.length) return null;
      return !!data?.data?.user?.self?.subscriptionBenefit?.id;
    } catch (_) { return null; }
  }

  // The VOD currently being recorded (= current live stream), or null when there
  // is none. Throws when Twitch answers with a partial failure (HTTP 200 +
  // errors, missing fields) — that must not count as "stream ended", or two
  // hiccups in a row would tear the controls down mid-stream
  async function fetchCurrentVod(login) {
    const data = await gql({
      query: `query($login:String!){user(login:$login){videos(first:5,sort:TIME,type:ARCHIVE){edges{node{id createdAt status}}}}}`,
      variables: { login },
    });
    const user = data?.data?.user;
    if (user === null && !data?.errors?.length) return null; // no such channel
    const edges = user?.videos?.edges;
    if (!Array.isArray(edges)) throw gqlError(data, 'VOD lookup');
    const recording = edges.find((e) => e?.node?.status === 'RECORDING');
    return recording ? recording.node : null;
  }

  async function fetchVodToken(vodId) {
    const data = await gql({
      operationName: 'PlaybackAccessToken_Template',
      query: `query PlaybackAccessToken_Template($login:String!,$isLive:Boolean!,$vodID:ID!,$isVod:Boolean!,$playerType:String!){streamPlaybackAccessToken(channelName:$login,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isLive){value signature __typename}videoPlaybackAccessToken(id:$vodID,params:{platform:"web",playerBackend:"mediaplayer",playerType:$playerType})@include(if:$isVod){value signature __typename}}`,
      variables: { login: '', isLive: false, vodID: vodId, isVod: true, playerType: 'site' },
    });
    return data?.data?.videoPlaybackAccessToken;
  }

  function vodPlaylistUrl(vodId, token, sig) {
    const p = new URLSearchParams({
      allow_source: 'true', allow_audio_only: 'true', allow_spectre: 'true',
      player: 'twitchweb', playlist_include_framerate: 'true',
      nauth: token, nauthsig: sig,
    });
    return `https://usher.ttvnw.net/vod/${vodId}.m3u8?${p}`;
  }

  // ─── Sub-only VOD fallback (direct CDN) ───────────────────────────────────

  async function fetchVodMetadata(vodId) {
    const data = await gql({
      query: `query{video(id:"${vodId}"){broadcastType createdAt seekPreviewsURL owner{login}}}`,
    });
    return data?.data?.video;
  }

  function buildDirectVodUrl(meta, vodId, quality) {
    if (!meta?.seekPreviewsURL) return null;
    const url = new URL(meta.seekPreviewsURL);
    const domain = url.host;
    const parts = url.pathname.split('/');
    const sbIdx = parts.findIndex((p) => p.includes('storyboards'));
    if (sbIdx < 1) return null;
    const vodSpecialId = parts[sbIdx - 1];
    const type = (meta.broadcastType || '').toLowerCase();
    if (type === 'highlight') {
      return `https://${domain}/${vodSpecialId}/${quality}/highlight-${vodId}.m3u8`;
    }
    return `https://${domain}/${vodSpecialId}/${quality}/index-dvr.m3u8`;
  }

  const VOD_QUALITIES = ['chunked', '1080p60', '720p60', '480p30', '360p30', '160p30'];

  async function findDirectVodUrl(vodId) {
    const meta = await fetchVodMetadata(vodId);
    if (!meta?.seekPreviewsURL) return null;
    for (const q of VOD_QUALITIES) {
      const url = buildDirectVodUrl(meta, vodId, q);
      if (!url) continue;
      try {
        const res = await fetchWithTimeout(url, { method: 'HEAD' });
        if (res.ok) { log('Direct CDN quality found:', q); return url; }
      } catch (_) {}
    }
    return null;
  }

  // Playable URL for a VOD: the usher playlist when the token grants access,
  // otherwise a direct CDN playlist (sub-only VODs). Touches no state, so
  // callers re-check staleness once after it resolves
  async function resolveVodUrl(vodId) {
    const tok = await fetchVodToken(vodId);
    if (tok) {
      const url = vodPlaylistUrl(vodId, tok.value, tok.signature);
      try {
        const check = await fetchWithTimeout(url);
        if (check.ok) return url;
      } catch (_) {}
    }
    return findDirectVodUrl(vodId);
  }

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  function playerContainer() {
    return (
      document.querySelector('.video-player__container') ||
      document.querySelector('[data-a-target="video-player"]')
    );
  }

  // Only ad markers that are rendered inside the player count: a leftover
  // (display:none) or page-level ad container must not hide the seekbar
  const AD_SELECTOR = '[data-a-target="video-ad-label"], [data-test-selector="ad-overlay-component"], .ad-banner-default-container';

  function isAdPlaying() {
    const c = playerContainer();
    const root = c && (c.closest('.persistent-player') || c.closest('[data-a-target="video-player"]') || c);
    if (!root) return false;
    for (const el of root.querySelectorAll(AD_SELECTOR)) {
      if (el.getClientRects().length) return true;
    }
    return false;
  }

  function twitchVideo() {
    const c = playerContainer();
    if (!c) return null;
    return c.querySelector('video:not(.tr-vod-video)') || null;
  }

  // Prefer the control bar of the main player over any other player on the page
  function nativeControls() {
    const c = playerContainer();
    return (
      c?.querySelector('[data-a-target="player-controls"]') ||
      document.querySelector('[data-a-target="player-controls"]') ||
      document.querySelector('.player-controls')
    );
  }

  // ─── Quality switching (intercept Twitch's native quality menu) ─────────

  function hookQualityMenu() {
    // Intercept clicks on quality options in Twitch's settings panel
    document.addEventListener('click', (e) => {
      if (!state.isRewinding || !state.hlsInstance) return;

      // Twitch quality items are inside the settings menu
      const item = e.target.closest('[data-a-target="player-settings-menu-item-quality"]') ||
                   e.target.closest('[data-a-target^="player-settings-submenu-quality-option"]');
      if (!item) return;

      const text = item.textContent.trim().toLowerCase();
      const hls = state.hlsInstance;
      const levels = hls.levels;
      if (!levels || !levels.length) return;

      // "auto" → automatic quality
      if (text.includes('auto')) {
        hls.currentLevel = -1;
        log('Quality → Auto');
        return;
      }

      // Parse resolution from text like "1080p60", "720p60 (Source)", "480p30"
      const match = text.match(/(\d{3,4})p/);
      if (!match) return;
      const targetHeight = parseInt(match[1], 10);

      // Find matching HLS level by height
      let bestIdx = -1;
      for (let i = 0; i < levels.length; i++) {
        if (levels[i].height === targetHeight) { bestIdx = i; break; }
      }

      // If "source" in text, pick highest quality
      if (bestIdx === -1 && text.includes('source')) {
        bestIdx = 0; // levels[0] is typically the highest quality
      }

      if (bestIdx !== -1) {
        hls.currentLevel = bestIdx;
        log('Quality →', levels[bestIdx].height + 'p @', Math.round(levels[bestIdx].bitrate / 1000) + 'kbps');
      }
    }, true);
  }

  // ─── Speed control (intercept native speed menu + keyboard) ────────────

  function hookSpeedMenu() {
    // Intercept clicks on speed options in Twitch's settings
    document.addEventListener('click', (e) => {
      if (!state.isRewinding || !state.vodVideo) return;

      // Speed submenu items
      const item = e.target.closest('[data-a-target^="player-settings-submenu-speed-option"]') ||
                   e.target.closest('[data-a-target="player-settings-menu-item-speed"]');
      if (!item) return;

      const text = item.textContent.trim().toLowerCase();
      const match = text.match(/([\d.]+)\s*x/);
      if (match) {
        const rate = parseFloat(match[1]);
        state.vodVideo.playbackRate = rate;
        log('Speed →', rate + 'x');
      }
    }, true);
  }

  // ─── Copy URL at timestamp ────────────────────────────────────────────────

  function hookCopyUrl() {
    document.addEventListener('click', (e) => {
      if (!state.isRewinding || !state.vodVideo || !state.vodId) return;

      // Look for "Copy URL at..." menu item
      const item = e.target.closest('[data-a-target="player-settings-menu-item-copy-url"]');
      if (!item) return;

      e.stopImmediatePropagation();
      e.preventDefault();

      const sec = Math.floor(state.vodVideo.currentTime);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const timestamp = `${h}h${m}m${s}s`;
      const url = `https://www.twitch.tv/videos/${state.vodId}?t=${timestamp}`;

      navigator.clipboard.writeText(url).then(() => {
        log('Copied URL:', url);
      }).catch(() => {});
    }, true);
  }

  // ─── Native play/pause button (shows the VOD's state during rewind) ───────

  const PLAY_PATH = 'M5 2.969V21.03a.5.5 0 0 0 .765.424L20.18 12.424a.5.5 0 0 0 0-.849L5.765 2.546A.5.5 0 0 0 5 2.97Z';
  const PAUSE_PATH = 'M10 4H5v16h5V4Zm9 0h-5v16h5V4Z';

  function playPauseButton() {
    return document.querySelector('[data-a-target="player-play-pause-button"]');
  }

  // Twitch swaps in a fresh <svg> whenever the native play state changes, so
  // the one we draw into keeps its original children (and the button its
  // label) for restorePlayPauseIcon() — otherwise the icon stays stuck on the
  // VOD's state after returning to live. Safe to call every tick: writes only
  // when something changed.
  function updatePlayPauseIcon() {
    if (!state.isRewinding || !state.vodVideo) return;
    const btn = playPauseButton();
    const svg = btn?.querySelector('svg');
    if (!svg) return;
    const paused = state.vodVideo.paused;
    const d = paused ? PLAY_PATH : PAUSE_PATH;
    if (svg._trPath !== d) {
      if (!svg._trNative) svg._trNative = [...svg.childNodes];
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.replaceChildren(path);
      svg._trPath = d;
    }
    const label = paused ? 'Play' : 'Pause';
    const current = btn.getAttribute('aria-label');
    if (current !== btn._trLabel) btn._trNativeLabel = current; // React re-rendered it since
    if (current !== label) btn.setAttribute('aria-label', label);
    btn._trLabel = label;
  }

  function restorePlayPauseIcon() {
    const btn = playPauseButton();
    const svg = btn?.querySelector('svg');
    if (svg?._trNative) {
      svg.replaceChildren(...svg._trNative);
      delete svg._trNative;
      delete svg._trPath;
    }
    if (btn && btn._trLabel !== undefined) {
      if (btn.getAttribute('aria-label') === btn._trLabel && btn._trNativeLabel != null) {
        btn.setAttribute('aria-label', btn._trNativeLabel);
      }
      delete btn._trLabel;
      delete btn._trNativeLabel;
    }
  }

  // ─── Seekbar drag (document-level so re-injection never leaks listeners) ───

  let seekDragging = false;

  // Pointer position as a fraction of the seekbar, or null when the bar isn't
  // laid out (hidden during an ad, or detached by a re-render) — a zero-width
  // rect would otherwise read as 0% and jump the rewind to 0:00
  function seekPctFromEvent(el, e) {
    if (!el.isConnected) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  function clampSeekSeconds(pct) {
    const total = elapsed();
    return Math.min(pct * total, Math.max(0, total - MIN_REWIND_SEC));
  }

  // Seek while dragging: directly once the VOD is ready, otherwise queue it
  // for the MANIFEST_PARSED handler of the load in flight
  function dragSeek(sec) {
    if (state.isRewinding && state.hlsReady && state.vodVideo) state.vodVideo.currentTime = sec;
    else if (state.loadingRewind || state.isRewinding) state.pendingSeek = sec;
  }

  function onDocMouseMove(e) {
    // Button no longer held: the mouseup happened somewhere we didn't see it
    if (seekDragging && !(e.buttons & 1)) onDocMouseUp();
    const sb = state.ui.seekbar;
    if (!sb) return;
    const pct = seekPctFromEvent(sb.el, e);
    if (pct === null) return;
    if (seekDragging) dragSeek(clampSeekSeconds(pct));
    if (seekDragging || sb.el.matches(':hover')) {
      sb.tooltip.textContent = formatTime(pct * elapsed());
      sb.tooltip.style.left = (pct * 100) + '%';
    }
  }

  function onDocMouseUp() {
    if (seekDragging) {
      seekDragging = false;
      state.ui.seekbar?.el.classList.remove('tr-seekbar--active');
    }
  }

  // ─── Inject controls into native Twitch UI ─────────────────────────────────

  // Only called by ensureUi(), which decides when the controls need (re)building
  function injectControls(controls) {
    document.getElementById('tr-seekbar-area')?.remove();

    // ── Seekbar area (above the button section) ──────────────────────────
    const seekArea = document.createElement('div');
    seekArea.id = 'tr-seekbar-area';
    seekArea.className = 'tr-seekbar-area';

    // Top row: [elapsed time] ... [LIVE button]
    const topRow = document.createElement('div');
    topRow.className = 'tr-seekbar-top';

    const curLabel = document.createElement('p');
    curLabel.className = 'tr-elapsed';
    curLabel.textContent = formatTime(elapsed());

    // Re-injection can happen mid-rewind, so start from the current state
    const liveLabel = document.createElement('div');
    liveLabel.id = 'tr-live-label';
    liveLabel.className = state.isRewinding ? 'tr-live-label' : 'tr-live-label tr-live-label--at-live';
    liveLabel.tabIndex = 0;
    liveLabel.setAttribute('role', 'button');
    liveLabel.setAttribute('aria-label', 'Skip to Live');

    const liveText = document.createElement('span');
    liveText.className = 'tr-live-text';
    liveText.textContent = 'LIVE';

    liveLabel.appendChild(liveText);

    // Skip-to-end icon (native Twitch glyph). The viewBox is cropped to the
    // glyph's bounds so styles.css can size it to the LIVE text
    const skipSvg = document.createElementNS(SVG_NS, 'svg');
    skipSvg.setAttribute('width', '9');
    skipSvg.setAttribute('height', '10');
    skipSvg.setAttribute('viewBox', '5 4 14 16');
    skipSvg.setAttribute('fill', 'currentColor');
    const skipPath = document.createElementNS(SVG_NS, 'path');
    skipPath.setAttribute('d', 'M5.794 4.578 16 12 5.794 19.422A.5.5 0 0 1 5 19.018V4.982a.5.5 0 0 1 .794-.404ZM17 4h2v16h-2V4Z');
    skipSvg.appendChild(skipPath);
    liveLabel.appendChild(skipSvg);

    liveLabel.addEventListener('click', goLive);

    topRow.append(curLabel, liveLabel);

    // Bottom row: [=== seekbar track ===] [red dot]
    const seekRow = document.createElement('div');
    seekRow.className = 'tr-seekbar-row';

    const seekbar = document.createElement('div');
    seekbar.className = 'tr-seekbar';

    const seekTrack = document.createElement('div');
    seekTrack.className = 'tr-seekbar-track';

    const seekPlayed = document.createElement('span');
    seekPlayed.className = 'tr-seekbar-played';
    seekPlayed.style.width = '100%';

    const seekThumb = document.createElement('span');
    seekThumb.className = 'tr-seekbar-thumb';
    seekThumb.style.left = '100%';

    const seekTooltip = document.createElement('span');
    seekTooltip.className = 'tr-seekbar-tooltip';

    seekTrack.appendChild(seekPlayed);
    seekbar.append(seekTrack, seekThumb, seekTooltip);

    // Red live dot at end of seekbar row
    const liveDot = document.createElement('button');
    liveDot.id = 'tr-live-dot';
    liveDot.className = 'tr-live-dot';
    liveDot.title = 'Jump to live';
    liveDot.setAttribute('aria-label', 'Jump to live');
    liveDot.innerHTML = '<span class="tr-live-dot-indicator"></span>';
    liveDot.addEventListener('click', goLive);

    seekRow.append(seekbar, liveDot);
    seekArea.append(topRow, seekRow);

    // Insert seekbar area before the section (button row)
    const buttonSection = controls.querySelector(':scope > section');
    if (buttonSection) {
      controls.insertBefore(seekArea, buttonSection);
    } else {
      const firstChild = controls.querySelector(':scope > div:last-of-type, :scope > section');
      if (firstChild) {
        controls.insertBefore(seekArea, firstChild);
      } else {
        controls.appendChild(seekArea);
      }
    }

    // ── Seekbar interaction (drag starts here; move/up are document-level) ──
    seekbar.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.vodId) return;
      const pct = seekPctFromEvent(seekbar, e);
      if (pct === null) return;
      e.preventDefault(); // avoid text selection while dragging
      seekDragging = true;
      seekbar.classList.add('tr-seekbar--active');
      startRewind(clampSeekSeconds(pct));
    });

    state.ui.seekArea = seekArea;
    state.ui.seekbar = { el: seekbar, played: seekPlayed, thumb: seekThumb, tooltip: seekTooltip };
    state.ui.curLabel = curLabel;
    state.ui.liveLabel = liveLabel;

    updateSeek();
    log('Controls injected');
  }

  function removeControls() {
    stopUi();
    document.getElementById('tr-seekbar-area')?.remove();
    state.ui = {};
    seekDragging = false;
  }

  // ─── UI lifecycle (self-healing) ─────────────────────────────────────────
  // Twitch re-renders or replaces parts of the player whenever it likes
  // (content-classification gate, ads, reconnects). Instead of trusting one
  // observer on one container, a watchdog tick checks that the controls are
  // mounted in the *current* control bar, and an observer on the current
  // player container repairs the common case (React re-rendering the
  // controls) within a frame. Both only call ensureUi(), which is idempotent.

  let uiObserver = null;
  let uiObservedContainer = null;
  let uiRepairFrame = 0;

  function startUi() {
    if (!state.uiTimer) state.uiTimer = setInterval(uiTick, UI_TICK);
    ensureUi();
  }

  function stopUi() {
    clearInterval(state.uiTimer);
    state.uiTimer = null;
    uiObserver?.disconnect();
    uiObserver = null;
    uiObservedContainer = null;
    cancelAnimationFrame(uiRepairFrame);
    uiRepairFrame = 0;
  }

  function uiTick() {
    ensureUi();
    updateSeek();
  }

  function scheduleUiRepair() {
    if (uiRepairFrame) return;
    uiRepairFrame = requestAnimationFrame(() => {
      uiRepairFrame = 0;
      ensureUi();
    });
  }

  function ensureUi() {
    if (!state.enabled || !state.vodId) return;

    const container = playerContainer();
    if (container && container !== uiObservedContainer) {
      uiObserver?.disconnect();
      uiObserver = new MutationObserver(scheduleUiRepair);
      uiObserver.observe(container, { childList: true, subtree: true });
      uiObservedContainer = container;
    }

    const controls = nativeControls();
    const area = state.ui.seekArea;
    if (controls && !(area?.isConnected && controls.contains(area))) injectControls(controls);

    if (state.isRewinding) {
      // muteNative()'s observer is bound to the container the rewind started
      // in; if Twitch replaced it, a new native <video> must still be muted
      const nv = twitchVideo();
      if (nv && nv !== mutedVideoRef) attachMuteListener(nv);
      if (state.vodVideo && !state.vodVideo.isConnected) reattachVodVideo();
      updatePlayPauseIcon(); // Twitch may have swapped the icon back
    }
  }

  // ─── VOD video element (sits above native video, below controls) ────────

  function reattachVodVideo() {
    const v = state.vodVideo;
    if (!v) return false;
    if (v.isConnected) return true;
    const container = playerContainer();
    if (!container) return false;
    const nv = twitchVideo();
    const videoRef = container.querySelector('.video-ref, [data-a-target="video-ref"]');
    if (nv && videoRef && videoRef.contains(nv)) nv.after(v);
    else if (videoRef) videoRef.prepend(v);
    else container.appendChild(v);
    log('Re-attached VOD video');
    return true;
  }

  function ensureVodVideo() {
    if (state.vodVideo) {
      // React can wipe the player subtree and leave our video detached —
      // a detached video plays audio with no picture, so reattach it
      if (state.vodVideo.isConnected || reattachVodVideo()) return state.vodVideo;
      return null;
    }
    const container = playerContainer();
    if (!container) return null;

    const video = document.createElement('video');
    video.className = 'tr-vod-video';
    video.playsInline = true;
    video.style.display = 'none';

    video.addEventListener('click', () => {
      video.paused ? video.play() : video.pause();
      updatePlayPauseIcon();
    });
    // Keep the native play/pause icon in sync no matter what toggles the video
    video.addEventListener('play', updatePlayPauseIcon);
    video.addEventListener('pause', updatePlayPauseIcon);

    const videoRef = container.querySelector('.video-ref, [data-a-target="video-ref"]');
    if (videoRef) {
      const nativeVid = videoRef.querySelector('video');
      if (nativeVid) nativeVid.after(video);
      else videoRef.prepend(video);
    } else {
      container.appendChild(video);
    }

    state.vodVideo = video;
    return video;
  }

  function showVodVideo() {
    if (state.vodVideo) state.vodVideo.style.display = '';
  }

  function hideVodVideo() {
    if (state.vodVideo) state.vodVideo.style.display = 'none';
  }

  // ─── Pre-load VOD (fetch URL + HLS manifest in background) ────────────────

  async function preloadVod() {
    // Never replace an existing instance: it may be serving the active rewind.
    // A broken one is cleared by dropHls(), and the next poll preloads again
    if (!state.vodId || state.hlsInstance || state.preloading || state.loadingRewind || state.isRewinding) return;
    const vodId = state.vodId;
    const epoch = navEpoch;
    state.preloading = true;
    log('Pre-loading VOD URL...');

    try {
      const url = await resolveVodUrl(vodId);
      // Channel changed, recording rotated, or a rewind took over meanwhile
      if (epoch !== navEpoch || state.vodId !== vodId || state.loadingRewind || state.isRewinding || state.hlsInstance) return;
      if (!url) { log('VOD URL not available'); return; }

      state.vodUrl = url;

      // Pre-create HLS instance and load manifest
      if (typeof Hls === 'undefined' || !Hls.isSupported()) return;

      const video = ensureVodVideo();
      if (!video) return;

      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: -1 });
      state.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (state.hlsInstance !== hls) return;
        state.hlsReady = true;
        log('VOD pre-loaded, ready for instant rewind');
      });
      watchHlsErrors(hls);

      hls.loadSource(url);
      hls.attachMedia(video);

      // Pause immediately — we just want the manifest, not buffering
      video.addEventListener('loadedmetadata', () => {
        if (!state.isRewinding) video.pause();
      }, { once: true });
    } catch (e) {
      log('Pre-load failed:', e);
    } finally {
      // cleanup() already reset the flag if the channel changed meanwhile
      if (epoch === navEpoch) state.preloading = false;
    }
  }

  // ─── Rewind (VOD playback) ─────────────────────────────────────────────────

  async function startRewind(seekTo) {
    // Ads only block *starting* a rewind; seeking within one keeps working
    if (!state.vodId || (!state.isRewinding && isAdPlaying())) return;

    const maxSeek = Math.max(0, elapsed() - MIN_REWIND_SEC);
    seekTo = Math.max(0, Math.min(seekTo, maxSeek));

    // Already rewinding — just seek, or queue it while the manifest loads
    if (state.isRewinding && state.vodVideo) {
      if (state.hlsReady) { state.vodVideo.currentTime = seekTo; return; }
      if (state.hlsInstance) { state.pendingSeek = seekTo; return; }
    }

    // A load is already in flight — remember the target and apply it on ready
    // instead of tearing down and restarting the load
    if (state.loadingRewind) {
      state.pendingSeek = seekTo;
      return;
    }

    log('Rewind → seek to', formatTime(seekTo));

    // If pre-loaded, instant rewind
    if (state.hlsReady && state.hlsInstance && state.vodVideo) {
      if (!state.vodVideo.isConnected && !reattachVodVideo()) return;
      syncVodVolume();
      state.vodVideo.currentTime = seekTo;
      showVodVideo();
      state.vodVideo.play().catch(() => {});
      state.isRewinding = true;
      muteNative();
      updateSeek();
      updatePlayPauseIcon();
      return;
    }

    // Not pre-loaded — load now
    const epoch = navEpoch;
    const seq = state.rewindSeq;
    const vodId = state.vodId;
    // LIVE clicked, channel left or recording rotated while the load was in flight
    const cancelled = () => epoch !== navEpoch || seq !== state.rewindSeq || state.vodId !== vodId;
    state.loadingRewind = true;
    state.pendingSeek = null;
    try {
      let url = state.vodUrl;
      if (!url) {
        url = await resolveVodUrl(vodId);
        if (cancelled()) return;
        if (!url) { log('Cannot access VOD'); return; }
        state.vodUrl = url;
      }

      const video = ensureVodVideo();
      if (!video) return;
      if (typeof Hls === 'undefined' || !Hls.isSupported()) return;

      if (state.hlsInstance) state.hlsInstance.destroy();
      state.hlsReady = false;

      // A seek made while the URL was resolving wins over the original target
      const start = state.pendingSeek ?? seekTo;
      state.pendingSeek = null;
      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: start });
      state.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (state.hlsInstance !== hls) return;
        state.hlsReady = true;
        log('VOD manifest loaded');
        if (!state.isRewinding) {
          // User returned to live while the load was in flight —
          // don't start hidden VOD playback on top of the live stream
          video.pause();
          return;
        }
        syncVodVolume();
        if (state.pendingSeek != null) video.currentTime = state.pendingSeek;
        state.pendingSeek = null;
        video.play().catch(() => {});
        updatePlayPauseIcon();
      });
      watchHlsErrors(hls);

      hls.loadSource(url);
      hls.attachMedia(video);

      showVodVideo();
      state.isRewinding = true;
      muteNative();
      updateSeek();
    } catch (err) {
      log('Rewind failed:', err);
      if (!cancelled()) goLive();
    } finally {
      // cleanup() already reset the flag if the channel changed meanwhile
      if (epoch === navEpoch) state.loadingRewind = false;
    }
  }

  // ─── HLS error recovery ──────────────────────────────────────────────────
  // hls.js reports an error as fatal once its own retries are exhausted.
  // Media errors (decode/append) usually recover with recoverMediaError(),
  // playlist/segment network errors with startLoad(). A few attempts per
  // minute, then give up cleanly — never loop forever, and never leave a
  // frozen or black VOD on screen.

  function watchHlsErrors(hls) {
    let attempts = 0;
    let windowStart = 0;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal || state.hlsInstance !== hls) return;
      const now = Date.now();
      if (now - windowStart > 60000) { windowStart = now; attempts = 0; }
      const isMedia = data.type === Hls.ErrorTypes.MEDIA_ERROR;
      // A failed master playlist can't be resumed with startLoad(): it needs a fresh URL
      const isNetwork = data.type === Hls.ErrorTypes.NETWORK_ERROR && !String(data.details).startsWith('manifest');
      const what = `HLS error (${data.details})${state.isRewinding ? ' during rewind' : ''}`;
      if ((isMedia || isNetwork) && attempts++ < HLS_RECOVERY_LIMIT) {
        log(`${what}, recovering`);
        if (isMedia) {
          // recoverMediaError() re-attaches the media element, which pauses it
          const media = hls.media;
          const resume = media && !media.paused;
          hls.recoverMediaError();
          if (resume) media.play().catch(() => {});
        } else {
          hls.startLoad();
        }
        return;
      }
      log(`${what}, giving up`);
      dropHls();
    });
  }

  // Tear down a broken HLS instance and forget its (possibly expired) URL, so
  // the next preload or rewind starts over with a fresh token
  function dropHls() {
    if (state.isRewinding) goLive();
    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
    state.hlsReady = false;
    state.vodUrl = null;
  }

  // ─── Volume sync (match VOD volume to native) ─────────────────────────────

  function syncVodVolume() {
    if (!state.vodVideo) return;
    const nv = twitchVideo();
    const vol = nv?._trSavedVolume ?? nv?.volume ?? 1;
    state.vodVideo.volume = vol;
    state.vodVideo.muted = nv?.muted ?? false;
  }

  function hookVolumeSlider() {
    // Intercept Twitch's volume slider to control VOD video during rewind
    document.addEventListener('input', (e) => {
      if (!state.isRewinding || !state.vodVideo) return;
      const slider = e.target.closest('[data-a-target="player-volume-slider"]');
      if (!slider) return;
      state.vodVideo.volume = parseFloat(slider.value);
    }, true);
  }

  // Intercept the native play/pause button via delegation so the hook
  // survives Twitch re-rendering the control bar
  function hookNativeButtons() {
    document.addEventListener('click', (e) => {
      if (!state.isRewinding || !state.vodVideo) return;
      if (!e.target.closest('[data-a-target="player-play-pause-button"]')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      const vod = state.vodVideo;
      vod.paused ? vod.play().catch(() => {}) : vod.pause();
      updatePlayPauseIcon();
    }, true);
  }

  // ─── Native audio mute (event-driven) ──────────────────────────────────────

  let mutedVideoRef = null;
  let videoObserver = null;

  function onNativeVolumeChange() {
    if (!state.isRewinding) return;
    if (this.volume > 0) {
      this._trSavedVolume = this.volume; // remember last non-zero for restore
      this.volume = 0;
    }
    // Mirror mute toggles (button or M key) onto the VOD video
    if (state.vodVideo) state.vodVideo.muted = this.muted;
  }

  function attachMuteListener(vid) {
    if (mutedVideoRef === vid) return;
    detachMuteListener();
    vid._trSavedVolume = vid.volume;
    vid.volume = 0;
    vid.addEventListener('volumechange', onNativeVolumeChange);
    mutedVideoRef = vid;
  }

  function detachMuteListener() {
    if (mutedVideoRef) {
      mutedVideoRef.removeEventListener('volumechange', onNativeVolumeChange);
      if (mutedVideoRef._trSavedVolume !== undefined) {
        mutedVideoRef.volume = mutedVideoRef._trSavedVolume;
        delete mutedVideoRef._trSavedVolume;
      }
      mutedVideoRef = null;
    }
  }

  function muteNative() {
    const vid = twitchVideo();
    if (vid) attachMuteListener(vid);

    // Watch for Twitch replacing the <video> element
    if (!videoObserver) {
      const container = playerContainer();
      if (container) {
        videoObserver = new MutationObserver(() => {
          if (!state.isRewinding) return;
          const vid = twitchVideo();
          if (vid && vid !== mutedVideoRef) attachMuteListener(vid);
          // Reattach our video if React wiped the player subtree mid-rewind
          if (state.vodVideo && !state.vodVideo.isConnected) reattachVodVideo();
        });
        videoObserver.observe(container, { childList: true, subtree: true });
      }
    }
  }

  function unmuteNative() {
    detachMuteListener();
    if (videoObserver) { videoObserver.disconnect(); videoObserver = null; }
  }

  function goLive() {
    log('Back to live');
    state.isRewinding = false;
    state.pendingSeek = null;
    state.rewindSeq++; // cancels a rewind load still in flight

    // Pause and hide VOD video (keep HLS alive for instant re-rewind)
    if (state.vodVideo) {
      state.vodVideo.pause();
      state.vodVideo.playbackRate = 1;
    }
    hideVodVideo();

    unmuteNative();
    restorePlayPauseIcon();

    // Always resume native playback
    requestAnimationFrame(() => {
      if (state.isRewinding) return; // user started rewinding again already
      const nv = twitchVideo();
      if (nv && nv.paused) nv.play().catch(() => {});
    });

    updateSeek(); // snap the seekbar and LIVE badge back to the live edge
  }

  // ─── Seek updates ──────────────────────────────────────────────────────────

  // Renders the controls from state; runs every UI tick, after injection and
  // on rewind/live transitions. state.ui refs are current: ensureUi() rebuilds
  // them whenever Twitch re-renders the control bar
  function updateSeek() {
    const { seekArea, seekbar, curLabel, liveLabel } = state.ui;
    if (!seekArea) return;
    // Hide during ads — but never mid-rewind: a midroll on the (muted, hidden)
    // live stream must not take away the rewind controls and the LIVE button
    seekArea.style.display = !state.isRewinding && isAdPlaying() ? 'none' : '';
    liveLabel?.classList.toggle('tr-live-label--at-live', !state.isRewinding);

    const total = elapsed();
    if (total <= 0) return;

    if (state.isRewinding && state.vodVideo) {
      const cur = state.vodVideo.currentTime;
      const pct = Math.min(100, (cur / total) * 100);

      if (seekbar) {
        seekbar.el?.classList.remove('tr-seekbar--live');
        seekbar.played.style.width = pct + '%';
        seekbar.thumb.style.left = pct + '%';
      }
      if (curLabel) curLabel.textContent = formatTime(cur);
    } else {
      if (seekbar) {
        seekbar.el?.classList.add('tr-seekbar--live');
        seekbar.played.style.width = '100%';
        seekbar.thumb.style.left = '100%';
      }
      if (curLabel) curLabel.textContent = formatTime(total);
    }
  }

  // ─── Channel detection ─────────────────────────────────────────────────────

  const KNOWN_ROUTES = new Set([
    'directory', 'settings', 'subscriptions', 'inventory', 'wallet',
    'drops', 'videos', 'p', 'search', 'downloads', 'turbo', 'prime',
    'products', 'jobs', 'about', 'legal', 'moderator', 'friends',
    'store', 'checkout', 'bits', 'subs', 'u', 'popout', 'embed',
    'broadcast', 'dashboard', 'messages',
  ]);

  function channelFromUrl() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    // Logins are case-insensitive: /XQC and /xqc are the same channel, so a
    // case-only URL rewrite must not look like a channel change
    const ch = parts[0].toLowerCase();
    return KNOWN_ROUTES.has(ch) ? null : ch;
  }

  // Navigation epoch: increments on every channel change so stale async
  // continuations (waitForPlayer, GQL calls) can detect they've been superseded
  let navEpoch = 0;

  async function onChannelChange(ch) {
    const epoch = ++navEpoch;
    cleanup();
    if (!ch || !state.enabled) return;
    state.channel = ch;
    log('Channel:', ch);
    await waitForPlayer();
    if (epoch !== navEpoch) return;
    await checkVod();
    if (epoch !== navEpoch) return;
    clearInterval(state.vodCheckInterval);
    state.vodCheckInterval = setInterval(checkVod, VOD_CHECK_INTERVAL);
  }

  // Epoch of the check in flight: a superseded check must neither block the
  // new channel's first check nor apply its result to the new channel
  let checkInFlight = null;

  async function checkVod() {
    const epoch = navEpoch;
    const channel = state.channel;
    if (!channel || !state.enabled || checkInFlight === epoch) return;
    checkInFlight = epoch;
    try {
      // Skip if user is subscribed — they have native VOD access
      if (state.subscribed === null) {
        const subscribed = await isSubscribed(channel);
        if (epoch !== navEpoch) return;
        state.subscribed = subscribed; // null (check failed) is retried on the next poll
      }
      if (state.subscribed) return;

      const vod = await fetchCurrentVod(channel);
      if (epoch !== navEpoch) return;
      if (vod) {
        const isNew = state.vodId !== vod.id;
        state.vodId = vod.id;
        state.vodCreatedAt = vod.createdAt;
        state.vodMisses = 0;
        if (isNew) {
          // New recording (e.g. stream restarted) — drop preloaded state for the old VOD
          log('VOD found:', vod.id);
          if (state.isRewinding || state.loadingRewind) goLive();
          state.vodUrl = null;
          state.hlsReady = false;
          if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
        }
        startUi(); // idempotent: never rebuilds controls that are already mounted
        preloadVod();
      } else {
        // Stream really ended (errors throw instead of landing here): tear
        // down after two consecutive misses, and never mid-rewind
        state.vodMisses++;
        if (state.vodMisses >= 2 && !state.isRewinding) {
          state.vodId = null;
          state.vodCreatedAt = null;
          removeControls();
        }
      }
    } catch (e) { log('VOD check error:', e); }
    finally { if (checkInFlight === epoch) checkInFlight = null; }
  }

  function waitForPlayer() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (nativeControls() || ++tries > 30) { resolve(); return; }
        setTimeout(check, 500);
      };
      check();
    });
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  // Always paired with a navEpoch bump, so in-flight async work bails out
  // instead of resurrecting what this tears down
  function cleanup() {
    state.isRewinding = false;
    state.pendingSeek = null;
    state.preloading = false;
    state.loadingRewind = false;
    state.vodMisses = 0;
    state.subscribed = null;
    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
    state.hlsReady = false;
    // Pause BEFORE removing — a detached <video> keeps playing audio
    if (state.vodVideo) { state.vodVideo.pause(); state.vodVideo.remove(); state.vodVideo = null; }
    unmuteNative();
    restorePlayPauseIcon();
    clearInterval(state.vodCheckInterval);
    state.vodCheckInterval = null;
    removeControls();
    state.channel = null;
    state.vodId = null;
    state.vodCreatedAt = null;
    state.vodUrl = null;
  }

  // ─── SPA navigation ───────────────────────────────────────────────────────

  function hookNavigation() {
    const wrap = (orig) => function (...args) { orig.apply(this, args); onNavigate(); };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener('popstate', onNavigate);
  }

  let navTimer;
  function onNavigate() {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      if (!state.enabled) return; // disabled from the popup: stay off across navigation
      const ch = channelFromUrl();
      if (ch !== state.channel) onChannelChange(ch);
    }, 500);
  }

  // ─── Message from content script ───────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'TWITCH_REWIND_TOGGLE') return;
    const enabled = e.data.enabled !== false;
    if (enabled === state.enabled) return;
    state.enabled = enabled;
    if (!enabled) {
      navEpoch++; // abandon in-flight channel setup and VOD checks
      cleanup();
    } else {
      onNavigate();
    }
  });

  // ─── Keyboard shortcuts (capture phase, when rewinding) ──────────────────

  const SPEED_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.vodId || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!state.isRewinding || !state.vodVideo) return;

    const vod = state.vodVideo;

    if (e.key === ' ' || (e.key || '').toLowerCase() === 'k') {
      vod.paused ? vod.play().catch(() => {}) : vod.pause();
    } else if (e.key === 'ArrowLeft') {
      vod.currentTime = Math.max(0, vod.currentTime - SEEK_STEP);
    } else if (e.key === 'ArrowRight') {
      const max = Math.max(0, elapsed() - MIN_REWIND_SEC);
      vod.currentTime = Math.min(max, vod.currentTime + SEEK_STEP);
    } else if (e.key === '>' || e.key === '.') {
      // Speed up
      const next = SPEED_STEPS.find((s) => s > vod.playbackRate);
      if (next) { vod.playbackRate = next; log('Speed →', next + 'x'); }
    } else if (e.key === '<' || e.key === ',') {
      // Slow down
      const prev = [...SPEED_STEPS].reverse().find((s) => s < vod.playbackRate);
      if (prev) { vod.playbackRate = prev; log('Speed →', prev + 'x'); }
    } else {
      return;
    }
    // Capture phase + stopImmediatePropagation keeps Twitch's own key
    // handler (which drives the native player) out of the way while rewinding
    e.preventDefault();
    e.stopImmediatePropagation();
    updatePlayPauseIcon();
  }, true);

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    log('Loaded');
    hookNavigation();
    hookQualityMenu();
    hookVolumeSlider();
    hookNativeButtons();
    hookSpeedMenu();
    hookCopyUrl();
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    const ch = channelFromUrl();
    if (ch) onChannelChange(ch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
