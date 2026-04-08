// Twitch Rewind — Injected Page Script
// Click rewind button → VOD overlay with custom UI
// Click LIVE → back to native Twitch player

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
    isRewinding: false,
    hlsInstance: null,
    overlayVideo: null,
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
    const headers = {
      'Client-ID': TWITCH_CLIENT_ID,
      'Content-Type': 'application/json',
    };
    const token = getAuthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;
    const res = await fetch(GQL_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GQL ${res.status}`);
    return res.json();
  }

  async function fetchCurrentVod(login) {
    const data = await gql({
      query: `query($login:String!){user(login:$login){videos(first:1,sort:TIME,type:ARCHIVE){edges{node{id createdAt status}}}}}`,
      variables: { login },
    });
    const edges = data?.data?.user?.videos?.edges;
    if (!edges?.length) return null;
    const vod = edges[0].node;
    const ageMs = Date.now() - new Date(vod.createdAt).getTime();
    return ageMs < 48 * 3600 * 1000 ? vod : null;
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

  // ─── DOM ────────────────────────────────────────────────────────────────────

  function playerContainer() {
    return (
      document.querySelector('[data-a-target="video-player-layout"]') ||
      document.querySelector('.video-player__container') ||
      document.querySelector('[data-a-target="video-player"]')
    );
  }

  function twitchVideo() {
    const c = playerContainer();
    if (!c) return null;
    const videos = c.querySelectorAll('video:not(.tr-video)');
    return videos[0] || null;
  }

  function playerControls() {
    return (
      document.querySelector('.player-controls__right-control-group') ||
      document.querySelector('[data-a-target="player-controls"]')
    );
  }

  // ─── Rewind button (in native Twitch controls) ────────────────────────────

  function addRewindButton() {
    if (document.getElementById('tr-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'tr-btn';
    btn.className = 'tr-btn';
    btn.title = 'Rewind Stream';
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>`;
    btn.addEventListener('click', () => {
      const e = elapsed();
      startRewind(Math.max(0, e - MIN_REWIND_SEC));
    });

    const controls = playerControls();
    if (controls) {
      controls.insertBefore(btn, controls.firstChild);
    } else {
      const c = playerContainer();
      if (c) {
        btn.classList.add('tr-btn--float');
        c.appendChild(btn);
      }
    }
    state.ui.btn = btn;
  }

  function removeRewindButton() {
    document.getElementById('tr-btn')?.remove();
    state.ui.btn = null;
  }

  // ─── Rewind (VOD playback) ─────────────────────────────────────────────────

  async function startRewind(seekTo) {
    if (!state.vodId) {
      notify('Rewind unavailable — streamer may not save VODs');
      return;
    }

    const maxSeek = Math.max(0, elapsed() - MIN_REWIND_SEC);
    seekTo = Math.max(0, Math.min(seekTo, maxSeek));

    log('Rewind → seek to', formatTime(seekTo));

    try {
      const tok = await fetchVodToken(state.vodId);
      if (!tok) {
        notify('Cannot access VOD — may be subscriber-only');
        return;
      }

      const url = vodPlaylistUrl(state.vodId, tok.value, tok.signature);

      if (!state.ui.overlay) createOverlay();

      if (state.hlsInstance) {
        state.hlsInstance.destroy();
        state.hlsInstance = null;
      }

      if (typeof Hls === 'undefined' || !Hls.isSupported()) {
        notify('HLS playback not supported');
        return;
      }

      const hls = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        startPosition: seekTo,
      });
      state.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log('VOD manifest loaded');
        state.overlayVideo.play().catch(() => {});
      });

      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          log('Fatal HLS error:', data.details);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
          } else {
            goLive();
            notify('Playback error — try again');
          }
        }
      });

      hls.loadSource(url);
      hls.attachMedia(state.overlayVideo);

      state.isRewinding = true;

      // Show overlay, mute native
      state.ui.overlay.style.display = 'flex';
      const orig = twitchVideo();
      if (orig) {
        orig._trSavedVolume = orig.volume;
        orig.volume = 0;
      }

      startSeekUpdates();
    } catch (err) {
      log('Rewind failed:', err);
      notify('Failed to start rewind');
      goLive();
    }
  }

  function goLive() {
    log('Back to live');
    state.isRewinding = false;

    if (state.hlsInstance) {
      state.hlsInstance.destroy();
      state.hlsInstance = null;
    }

    // Hide overlay
    if (state.ui.overlay) {
      state.ui.overlay.style.display = 'none';
    }

    // Restore native player
    const orig = twitchVideo();
    if (orig && orig._trSavedVolume !== undefined) {
      orig.volume = orig._trSavedVolume;
      delete orig._trSavedVolume;
    }

    stopSeekUpdates();
  }

  // ─── Overlay (shown only when rewinding) ───────────────────────────────────

  function createOverlay() {
    document.getElementById('tr-overlay')?.remove();
    const container = playerContainer();
    if (!container) return;

    const overlay = document.createElement('div');
    overlay.id = 'tr-overlay';
    overlay.className = 'tr-overlay';
    overlay.tabIndex = 0;
    overlay.style.display = 'none';

    // Video
    const video = document.createElement('video');
    video.className = 'tr-video';
    video.playsInline = true;
    video.autoplay = true;
    overlay.appendChild(video);

    // Controls bar
    const bar = document.createElement('div');
    bar.className = 'tr-controls';

    // Seek bar
    const seekRow = document.createElement('div');
    seekRow.className = 'tr-seek-row';
    const seekBar = document.createElement('input');
    seekBar.type = 'range';
    seekBar.className = 'tr-seekbar';
    seekBar.min = '0';
    seekBar.max = '1000';
    seekBar.value = '1000';
    seekBar.addEventListener('input', () => {
      const total = elapsed();
      const maxSeek = Math.max(0, total - MIN_REWIND_SEC);
      const t = Math.min((seekBar.value / 1000) * total, maxSeek);
      if (state.overlayVideo) state.overlayVideo.currentTime = t;
    });
    seekRow.appendChild(seekBar);
    bar.appendChild(seekRow);

    // Buttons row
    const btnRow = document.createElement('div');
    btnRow.className = 'tr-btn-row';

    const playBtn = mkBtn(pauseSvg, () => {
      if (state.overlayVideo) {
        state.overlayVideo.paused ? state.overlayVideo.play() : state.overlayVideo.pause();
      }
    });

    const backBtn = mkBtn(
      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.5 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>`,
      () => {
        if (state.overlayVideo) {
          state.overlayVideo.currentTime = Math.max(0, state.overlayVideo.currentTime - SEEK_STEP);
        }
      },
    );

    const fwdBtn = mkBtn(
      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.5 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/></svg>`,
      () => {
        if (state.overlayVideo) {
          const max = elapsed() - MIN_REWIND_SEC;
          state.overlayVideo.currentTime = Math.min(max, state.overlayVideo.currentTime + SEEK_STEP);
        }
      },
    );

    const timeEl = document.createElement('span');
    timeEl.className = 'tr-time';

    const spacer = document.createElement('div');
    spacer.style.flex = '1';

    const behindEl = document.createElement('span');
    behindEl.className = 'tr-behind';

    // Volume
    const volBtn = mkBtn(
      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>`,
      () => { if (state.overlayVideo) state.overlayVideo.muted = !state.overlayVideo.muted; },
    );
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.className = 'tr-volume';
    volSlider.min = '0';
    volSlider.max = '1';
    volSlider.step = '0.05';
    volSlider.value = '1';
    volSlider.addEventListener('input', () => {
      if (state.overlayVideo) state.overlayVideo.volume = parseFloat(volSlider.value);
    });

    // LIVE button
    const liveBtn = document.createElement('button');
    liveBtn.className = 'tr-live-btn';
    liveBtn.textContent = 'LIVE';
    liveBtn.addEventListener('click', goLive);

    // Fullscreen
    const fsBtn = mkBtn(
      `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>`,
      () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else overlay.requestFullscreen();
      },
    );

    btnRow.append(playBtn, backBtn, fwdBtn, timeEl, spacer, behindEl, volBtn, volSlider, liveBtn, fsBtn);
    bar.appendChild(btnRow);
    overlay.appendChild(bar);

    // Keyboard shortcuts
    overlay.addEventListener('keydown', (e) => {
      const handlers = {
        ArrowLeft: () => {
          if (state.overlayVideo) state.overlayVideo.currentTime = Math.max(0, state.overlayVideo.currentTime - SEEK_STEP);
        },
        ArrowRight: () => {
          if (state.overlayVideo) {
            const max = elapsed() - MIN_REWIND_SEC;
            state.overlayVideo.currentTime = Math.min(max, state.overlayVideo.currentTime + SEEK_STEP);
          }
        },
        ' ': () => {
          if (state.overlayVideo) state.overlayVideo.paused ? state.overlayVideo.play() : state.overlayVideo.pause();
        },
        Escape: goLive,
        f: () => {
          if (document.fullscreenElement) document.exitFullscreen();
          else overlay.requestFullscreen();
        },
      };
      if (handlers[e.key]) { handlers[e.key](); e.preventDefault(); }
    });

    video.addEventListener('click', () => { video.paused ? video.play() : video.pause(); });

    // Show/hide controls on hover
    let hideTimer;
    overlay.addEventListener('mousemove', () => {
      bar.classList.add('tr-controls--visible');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => bar.classList.remove('tr-controls--visible'), 3000);
    });
    overlay.addEventListener('mouseleave', () => {
      clearTimeout(hideTimer);
      bar.classList.remove('tr-controls--visible');
    });

    container.appendChild(overlay);

    state.overlayVideo = video;
    state.ui.overlay = overlay;
    state.ui.seekBar = seekBar;
    state.ui.timeEl = timeEl;
    state.ui.behindEl = behindEl;
    state.ui.playBtn = playBtn;
  }

  const pauseSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  const playSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

  function mkBtn(svg, onClick) {
    const b = document.createElement('button');
    b.className = 'tr-ctrl-btn';
    b.innerHTML = svg;
    b.addEventListener('click', onClick);
    return b;
  }

  function notify(msg) {
    const c = playerContainer();
    if (!c) return;
    c.querySelector('.tr-notif')?.remove();
    const el = document.createElement('div');
    el.className = 'tr-notif';
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 4000);
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
    if (!state.isRewinding || !state.overlayVideo) return;
    const cur = state.overlayVideo.currentTime;
    const total = elapsed();
    const behind = Math.max(0, total - cur);

    if (state.ui.timeEl) {
      state.ui.timeEl.textContent = `${formatTime(cur)} / ${formatTime(total)}`;
    }
    if (state.ui.seekBar && !state.ui.seekBar.matches(':active')) {
      state.ui.seekBar.value = total > 0 ? (cur / total) * 1000 : 1000;
    }
    if (state.ui.behindEl) {
      state.ui.behindEl.textContent = behind > MIN_REWIND_SEC + 5 ? `-${formatTime(behind)}` : '';
    }
    if (state.ui.playBtn) {
      state.ui.playBtn.innerHTML = state.overlayVideo.paused ? playSvg : pauseSvg;
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
      const vod = await fetchCurrentVod(state.channel);
      if (vod) {
        state.vodId = vod.id;
        state.vodCreatedAt = vod.createdAt;
        log('VOD found:', vod.id);
        addRewindButton();
      } else {
        state.vodId = null;
        state.vodCreatedAt = null;
        removeRewindButton();
      }
    } catch (e) {
      log('VOD check error:', e);
    }
  }

  function waitForPlayer() {
    return new Promise((resolve) => {
      let tries = 0;
      const check = () => {
        if (playerContainer() || ++tries > 30) { resolve(); return; }
        setTimeout(check, 500);
      };
      check();
    });
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  function cleanup() {
    goLive();
    clearInterval(state.vodCheckInterval);
    state.vodCheckInterval = null;
    removeRewindButton();
    document.getElementById('tr-overlay')?.remove();
    state.channel = null;
    state.vodId = null;
    state.vodCreatedAt = null;
    state.overlayVideo = null;
    state.ui = {};
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

  // ─── Init ──────────────────────────────────────────────────────────────────

  function init() {
    log('Loaded');
    hookNavigation();
    const ch = channelFromUrl();
    if (ch) onChannelChange(ch);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
