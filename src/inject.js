// Twitch Rewind — Injected Page Script
// Injects rewind controls directly into Twitch's native player UI.
// Seekbar + skip buttons + LIVE appear in the native control bar.

(function () {
  'use strict';

  const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const VOD_CHECK_INTERVAL = 30000;
  const SEEK_STEP = 10;
  const MIN_REWIND_SEC = 15;

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
    seekInterval: null,
    vodCheckInterval: null,
  };

  // ─── Utilities ──────────────────────────────────────────────────────────────

  function log(...args) {
    console.log('%c[TwitchRewind]', 'color: #9147ff; font-weight: bold', ...args);
  }

  function getAuthToken() {
    const match = document.cookie.match(/auth-token=([^;]+)/);
    return match ? match[1] : null;
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
    const res = await fetch(GQL_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GQL ${res.status}`);
    return res.json();
  }

  async function isSubscribed(login) {
    try {
      const data = await gql({
        query: `query($login:String!){user(login:$login){self{subscriptionBenefit{id}}}}`,
        variables: { login },
      });
      return !!data?.data?.user?.self?.subscriptionBenefit?.id;
    } catch (_) { return false; }
  }

  async function fetchCurrentVod(login) {
    const data = await gql({
      query: `query($login:String!){user(login:$login){videos(first:5,sort:TIME,type:ARCHIVE){edges{node{id createdAt status}}}}}`,
      variables: { login },
    });
    const edges = data?.data?.user?.videos?.edges;
    if (!edges?.length) return null;
    // Prefer the VOD currently being recorded (= current live stream)
    const recording = edges.find((e) => e.node.status === 'RECORDING');
    if (recording) return recording.node;
    return null;
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
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) { log('Direct CDN quality found:', q); return url; }
      } catch (_) {}
    }
    return null;
  }

  // ─── DOM helpers ────────────────────────────────────────────────────────────

  function playerContainer() {
    return (
      document.querySelector('.video-player__container') ||
      document.querySelector('[data-a-target="video-player"]')
    );
  }

  function twitchVideo() {
    const c = playerContainer();
    if (!c) return null;
    return c.querySelector('video:not(.tr-vod-video)') || null;
  }

  function nativeControls() {
    return document.querySelector('[data-a-target="player-controls"]') || document.querySelector('.player-controls');
  }

  function nativeLeftGroup() {
    return document.querySelector('.player-controls__left-control-group');
  }

  function nativeRightGroup() {
    return document.querySelector('.player-controls__right-control-group');
  }

  // ─── SVG icons ──────────────────────────────────────────────────────────────

  const ICONS = {
    play: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 2.969V21.03a.5.5 0 0 0 .765.424L20.18 12.424a.5.5 0 0 0 0-.849L5.765 2.546A.5.5 0 0 0 5 2.97Z"/></svg>',
    pause: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H5v16h5V4Zm9 0h-5v16h5V4Z"/></svg>',
    skipBack: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
    skipFwd: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>',
  };

  function mkBtn(icon, onClick, title) {
    const b = document.createElement('button');
    b.className = 'tr-native-btn';
    b.innerHTML = icon;
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
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

  function updatePlayPauseIcon() {
    const btn = document.querySelector('[data-a-target="player-play-pause-button"]');
    if (!btn || !state.isRewinding || !state.vodVideo) return;
    const svg = btn.querySelector('svg');
    if (!svg) return;
    const paused = state.vodVideo.paused;
    svg.innerHTML = paused
      ? '<path d="M5 2.969V21.03a.5.5 0 0 0 .765.424L20.18 12.424a.5.5 0 0 0 0-.849L5.765 2.546A.5.5 0 0 0 5 2.97Z"></path>'
      : '<path d="M10 4H5v16h5V4Zm9 0h-5v16h5V4Z"></path>';
    btn.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  }

  // ─── Inject controls into native Twitch UI ─────────────────────────────────

  function injectControls() {
    // Remove any stale elements before re-injecting
    document.getElementById('tr-seekbar-area')?.remove();
    document.getElementById('tr-skip-back')?.remove();
    document.getElementById('tr-skip-fwd')?.remove();
    document.getElementById('tr-time')?.remove();
    document.getElementById('tr-behind')?.remove();
    document.getElementById('tr-live-btn')?.remove();

    const controls = nativeControls();
    if (!controls) return;

    // ── Seekbar (injected above the button row) ─────────────────────────────
    const seekArea = document.createElement('div');
    seekArea.id = 'tr-seekbar-area';
    seekArea.className = 'tr-seekbar-area';

    const timeLabels = document.createElement('div');
    timeLabels.className = 'tr-time-labels';
    const curLabel = document.createElement('span');
    curLabel.textContent = formatTime(elapsed());
    const durLabel = document.createElement('span');
    durLabel.textContent = formatTime(elapsed());
    timeLabels.append(curLabel, durLabel);

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
    seekArea.append(timeLabels, seekbar);

    // Insert seekbar at the top of controls
    const firstChild = controls.querySelector(':scope > div, :scope > section');
    if (firstChild) {
      controls.insertBefore(seekArea, firstChild);
    } else {
      controls.appendChild(seekArea);
    }

    // Seekbar drag interaction
    let seeking = false;

    function seekPctFromEvent(e) {
      const rect = seekbar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    }

    seekbar.addEventListener('mousedown', (e) => {
      seeking = true;
      seekbar.classList.add('tr-seekbar--active');
      const pct = seekPctFromEvent(e);
      const total = elapsed();
      const maxSec = Math.max(0, total - MIN_REWIND_SEC);
      const seekTo = Math.min(pct * total, maxSec);
      startRewind(seekTo);
    });

    document.addEventListener('mousemove', (e) => {
      if (seeking && state.vodVideo) {
        const pct = seekPctFromEvent(e);
        const total = elapsed();
        const maxSec = Math.max(0, total - MIN_REWIND_SEC);
        state.vodVideo.currentTime = Math.min(pct * total, maxSec);
      }
      if (seekbar.matches(':hover') || seeking) {
        const pct = seekPctFromEvent(e);
        seekTooltip.textContent = formatTime(pct * elapsed());
        seekTooltip.style.left = (pct * 100) + '%';
      }
    });

    document.addEventListener('mouseup', () => {
      if (seeking) { seeking = false; seekbar.classList.remove('tr-seekbar--active'); }
    });

    // ── Intercept native play/pause when rewinding ────────────────────────
    const playPauseBtn = document.querySelector('[data-a-target="player-play-pause-button"]');
    if (playPauseBtn) {
      playPauseBtn.addEventListener('click', (e) => {
        if (state.isRewinding && state.vodVideo) {
          e.stopImmediatePropagation();
          e.preventDefault();
          if (state.vodVideo.paused) {
            state.vodVideo.play();
          } else {
            state.vodVideo.pause();
          }
          updatePlayPauseIcon();
        }
      }, true);
    }

    // ── Buttons injected into native left/right groups ──────────────────────
    const leftGroup = nativeLeftGroup();
    const rightGroup = nativeRightGroup();

    // Skip back / forward (after play/pause in left group)
    if (leftGroup) {
      const backBtn = mkBtn(ICONS.skipBack, () => {
        if (state.isRewinding && state.vodVideo) {
          state.vodVideo.currentTime = Math.max(0, state.vodVideo.currentTime - SEEK_STEP);
        } else {
          startRewind(Math.max(0, elapsed() - MIN_REWIND_SEC - SEEK_STEP));
        }
      }, 'Back 10s');
      backBtn.id = 'tr-skip-back';

      const fwdBtn = mkBtn(ICONS.skipFwd, () => {
        if (state.isRewinding && state.vodVideo) {
          const max = elapsed() - MIN_REWIND_SEC;
          state.vodVideo.currentTime = Math.min(max, state.vodVideo.currentTime + SEEK_STEP);
        }
      }, 'Forward 10s');
      fwdBtn.id = 'tr-skip-fwd';

      // Insert after play/pause button
      const playPauseWrap = leftGroup.querySelector('[data-a-target="player-play-pause-button"]')?.closest('.InjectLayout-sc-1i43xsx-0');
      if (playPauseWrap) {
        playPauseWrap.after(backBtn, fwdBtn);
      } else {
        leftGroup.append(backBtn, fwdBtn);
      }

      state.ui.backBtn = backBtn;
      state.ui.fwdBtn = fwdBtn;
    }

    // Time display + behind indicator + LIVE button (in right group)
    if (rightGroup) {
      const timeEl = document.createElement('span');
      timeEl.id = 'tr-time';
      timeEl.className = 'tr-time-display';

      const behindEl = document.createElement('span');
      behindEl.id = 'tr-behind';
      behindEl.className = 'tr-behind';

      const liveBtn = document.createElement('button');
      liveBtn.id = 'tr-live-btn';
      liveBtn.className = state.isRewinding ? 'tr-live-btn' : 'tr-live-btn tr-live-btn--active';
      liveBtn.textContent = 'LIVE';
      liveBtn.addEventListener('click', goLive);

      // Insert at the beginning of the right group
      rightGroup.prepend(liveBtn, behindEl, timeEl);

      state.ui.timeEl = timeEl;
      state.ui.behindEl = behindEl;
      state.ui.liveBtn = liveBtn;
    }

    state.ui.seekArea = seekArea;
    state.ui.seekbar = { played: seekPlayed, thumb: seekThumb };
    state.ui.curLabel = curLabel;
    state.ui.durLabel = durLabel;

    startSeekUpdates();
    log('Controls injected');
  }

  function removeControls() {
    stopSeekUpdates();
    document.getElementById('tr-seekbar-area')?.remove();
    document.getElementById('tr-skip-back')?.remove();
    document.getElementById('tr-skip-fwd')?.remove();
    document.getElementById('tr-time')?.remove();
    document.getElementById('tr-behind')?.remove();
    document.getElementById('tr-live-btn')?.remove();
    state.ui = {};
  }

  // Re-inject controls if Twitch re-renders (React)
  let reinjectObserver;

  let reinjectPending = false;

  function watchForReinject() {
    reinjectObserver?.disconnect();
    const container = playerContainer();
    if (!container) return;
    reinjectObserver = new MutationObserver(() => {
      if (!state.vodId || reinjectPending) return;
      if (!document.getElementById('tr-seekbar-area') ||
          !document.getElementById('tr-behind') ||
          !document.getElementById('tr-skip-back')) {
        reinjectPending = true;
        requestAnimationFrame(() => {
          injectControls();
          reinjectPending = false;
        });
      }
    });
    reinjectObserver.observe(container, { childList: true, subtree: true });
  }

  // ─── VOD video element (sits above native video, below controls) ────────

  function ensureVodVideo() {
    if (state.vodVideo) return state.vodVideo;
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
    if (!state.vodId || state.hlsReady) return;
    log('Pre-loading VOD URL...');

    try {
      let url;
      const tok = await fetchVodToken(state.vodId);
      if (tok) {
        url = vodPlaylistUrl(state.vodId, tok.value, tok.signature);
        try {
          const check = await fetch(url);
          if (!check.ok) url = null;
        } catch (_) { url = null; }
      }
      if (!url) url = await findDirectVodUrl(state.vodId);
      if (!url) { log('VOD URL not available'); return; }

      state.vodUrl = url;

      // Pre-create HLS instance and load manifest
      if (typeof Hls === 'undefined' || !Hls.isSupported()) return;

      const video = ensureVodVideo();
      if (!video) return;

      if (state.hlsInstance) state.hlsInstance.destroy();

      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: -1 });
      state.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        state.hlsReady = true;
        log('VOD pre-loaded, ready for instant rewind');
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          log('Pre-load HLS error:', data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else { state.hlsReady = false; }
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);

      // Pause immediately — we just want the manifest, not buffering
      video.addEventListener('loadedmetadata', () => { video.pause(); }, { once: true });
    } catch (e) {
      log('Pre-load failed:', e);
    }
  }

  // ─── Rewind (VOD playback) ─────────────────────────────────────────────────

  async function startRewind(seekTo) {
    if (!state.vodId) return;

    const maxSeek = Math.max(0, elapsed() - MIN_REWIND_SEC);
    seekTo = Math.max(0, Math.min(seekTo, maxSeek));

    // Already rewinding — just seek
    if (state.isRewinding && state.vodVideo && state.hlsReady) {
      state.vodVideo.currentTime = seekTo;
      return;
    }

    log('Rewind → seek to', formatTime(seekTo));

    // If pre-loaded, instant rewind
    if (state.hlsReady && state.hlsInstance && state.vodVideo) {
      syncVodVolume();
      state.vodVideo.currentTime = seekTo;
      showVodVideo();
      state.vodVideo.play().catch(() => {});
      state.isRewinding = true;
      muteNative();
      const lb = document.getElementById('tr-live-btn');
      if (lb) lb.classList.remove('tr-live-btn--active');
      updatePlayPauseIcon();
      return;
    }

    // Not pre-loaded — load now
    try {
      let url = state.vodUrl;
      if (!url) {
        const tok = await fetchVodToken(state.vodId);
        if (tok) {
          url = vodPlaylistUrl(state.vodId, tok.value, tok.signature);
          try {
            const check = await fetch(url);
            if (!check.ok) url = null;
          } catch (_) { url = null; }
        }
        if (!url) url = await findDirectVodUrl(state.vodId);
        if (!url) { log('Cannot access VOD'); return; }
        state.vodUrl = url;
      }

      const video = ensureVodVideo();
      if (!video) return;
      if (typeof Hls === 'undefined' || !Hls.isSupported()) return;

      if (state.hlsInstance) state.hlsInstance.destroy();

      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, startPosition: seekTo });
      state.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        state.hlsReady = true;
        log('VOD manifest loaded');
        syncVodVolume();
        video.play().catch(() => {});
        updatePlayPauseIcon();
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          log('Fatal HLS error:', data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else goLive();
        }
      });

      hls.loadSource(url);
      hls.attachMedia(video);

      showVodVideo();
      state.isRewinding = true;
      muteNative();
      const lb = document.getElementById('tr-live-btn');
      if (lb) lb.classList.remove('tr-live-btn--active');
    } catch (err) {
      log('Rewind failed:', err);
      goLive();
    }
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

    // Intercept mute/unmute button
    const muteBtn = document.querySelector('[data-a-target="player-mute-unmute-button"]');
    if (muteBtn) {
      muteBtn.addEventListener('click', () => {
        if (!state.isRewinding || !state.vodVideo) return;
        // Toggle after Twitch processes it — use a microtask
        queueMicrotask(() => {
          state.vodVideo.muted = !state.vodVideo.muted;
        });
      }, true);
    }
  }

  // ─── Native audio mute (event-driven) ──────────────────────────────────────

  let mutedVideoRef = null;
  let videoObserver = null;

  function onNativeVolumeChange() {
    if (state.isRewinding && this.volume > 0) {
      this._trSavedVolume = this._trSavedVolume || this.volume;
      this.volume = 0;
    }
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

    // Pause and hide VOD video (keep HLS alive for instant re-rewind)
    if (state.vodVideo) state.vodVideo.pause();
    hideVodVideo();

    unmuteNative();

    // Always resume native playback
    requestAnimationFrame(() => {
      const nv = twitchVideo();
      if (nv && nv.paused) nv.play().catch(() => {});
    });

    // Reset seekbar to live edge
    if (state.ui.seekbar) {
      state.ui.seekbar.played.style.width = '100%';
      state.ui.seekbar.thumb.style.left = '100%';
    }
    const liveBtn = document.getElementById('tr-live-btn');
    if (liveBtn) liveBtn.classList.add('tr-live-btn--active');
    const behindEl = document.getElementById('tr-behind');
    if (behindEl) behindEl.textContent = '';
  }

  // ─── Seek updates ──────────────────────────────────────────────────────────

  function startSeekUpdates() {
    stopSeekUpdates();
    state.seekInterval = setInterval(updateSeek, 500);
  }

  function stopSeekUpdates() {
    clearInterval(state.seekInterval);
    state.seekInterval = null;
  }

  function updateSeek() {
    const total = elapsed();
    if (total <= 0) return;

    // Use getElementById for elements injected into Twitch's control groups
    // (React can re-render and replace them, making cached refs stale)
    const timeEl = document.getElementById('tr-time');
    const behindEl = document.getElementById('tr-behind');
    const seekbar = state.ui.seekbar;
    const curLabel = state.ui.curLabel;
    const durLabel = state.ui.durLabel;

    if (state.isRewinding && state.vodVideo) {
      const cur = state.vodVideo.currentTime;
      const pct = (cur / total) * 100;
      const behind = Math.max(0, total - cur);

      if (seekbar) {
        seekbar.played.style.width = pct + '%';
        seekbar.thumb.style.left = pct + '%';
      }
      if (curLabel) curLabel.textContent = formatTime(cur);
      if (durLabel) durLabel.textContent = formatTime(total);
      if (timeEl) timeEl.textContent = `${formatTime(cur)} / ${formatTime(total)}`;
      if (behindEl) {
        behindEl.textContent = behind > MIN_REWIND_SEC + 5 ? `-${formatTime(behind)}` : '';
      }
    } else {
      if (seekbar) {
        seekbar.played.style.width = '100%';
        seekbar.thumb.style.left = '100%';
      }
      if (curLabel) curLabel.textContent = formatTime(total);
      if (durLabel) durLabel.textContent = formatTime(total);
      if (timeEl) timeEl.textContent = formatTime(total);
      if (behindEl) behindEl.textContent = '';
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
    return KNOWN_ROUTES.has(parts[0].toLowerCase()) ? null : parts[0];
  }

  async function onChannelChange(ch) {
    cleanup();
    if (!ch) return;
    state.channel = ch;
    log('Channel:', ch);
    await waitForPlayer();
    await checkVod();
    state.vodCheckInterval = setInterval(checkVod, VOD_CHECK_INTERVAL);
  }

  async function checkVod() {
    if (!state.channel) return;
    try {
      // Skip if user is subscribed — they have native VOD access
      if (await isSubscribed(state.channel)) {
        log('Subscribed to channel, skipping rewind');
        return;
      }

      const vod = await fetchCurrentVod(state.channel);
      if (vod) {
        state.vodId = vod.id;
        state.vodCreatedAt = vod.createdAt;
        log('VOD found:', vod.id);
        injectControls();
        watchForReinject();
        preloadVod();
      } else {
        state.vodId = null;
        state.vodCreatedAt = null;
        removeControls();
      }
    } catch (e) { log('VOD check error:', e); }
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

  function cleanup() {
    state.isRewinding = false;
    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
    state.hlsReady = false;
    if (state.vodVideo) { state.vodVideo.remove(); state.vodVideo = null; }
    unmuteNative();
    clearInterval(state.vodCheckInterval);
    state.vodCheckInterval = null;
    reinjectObserver?.disconnect();
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
      const ch = channelFromUrl();
      if (ch !== state.channel) onChannelChange(ch);
    }, 500);
  }

  // ─── Message from content script ───────────────────────────────────────────

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.type !== 'TWITCH_REWIND_TOGGLE') return;
    state.enabled = e.data.enabled;
    if (!state.enabled) cleanup();
    else onNavigate();
  });

  // ─── Keyboard shortcuts (global, when on a channel page) ───────────────────

  document.addEventListener('keydown', (e) => {
    if (!state.vodId || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.key === 'ArrowLeft' && state.isRewinding && state.vodVideo) {
      state.vodVideo.currentTime = Math.max(0, state.vodVideo.currentTime - SEEK_STEP);
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && state.isRewinding && state.vodVideo) {
      const max = elapsed() - MIN_REWIND_SEC;
      state.vodVideo.currentTime = Math.min(max, state.vodVideo.currentTime + SEEK_STEP);
      e.preventDefault();
    }
  });

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    log('Loaded');
    hookNavigation();
    hookQualityMenu();
    hookVolumeSlider();
    const ch = channelFromUrl();
    if (ch) onChannelChange(ch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
