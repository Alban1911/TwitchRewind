// Twitch Rewind — Injected Page Script
// Injects rewind controls directly into Twitch's native player UI.
// Seekbar + LIVE appear in the native control bar.

(function () {
  'use strict';

  const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
  const GQL_URL = 'https://gql.twitch.tv/gql';
  const VOD_CHECK_INTERVAL = 30000;
  const UI_TICK = 500;
  const CONTROLS_KEEPALIVE = 2000; // re-arm Twitch's 5 s hide-controls timer while on the seekbar
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
    const pad = (n) => String(n).padStart(2, '0');
    // Always hh:mm:ss, like Twitch's own seekbar: 00:11:59, 01:59:11
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
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

  // Twitch's own rewind puts its seekbar in the control bar. It only exists on
  // Affiliate and Partner channels that save and publish their VODs, for Turbo
  // users — and for subscribers when the channel gives them ad-free viewing —
  // so it's checked on the page, not guessed from the viewer's subscription
  function nativeRewind() {
    return !!nativeControls()?.querySelector('[data-a-target="player-seekbar"]');
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
  let dragTarget = null; // last position a drag seeked to (snapped positions repeat)
  let hovered = null;    // { x, sec }: pointer x and time when the tooltip was last updated

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

  // Seekbar time -> where playback should start. Once previews work for this
  // VOD, that's the nearest keyframe — the frame the tooltip shows: what you
  // see is where you land. Without previews — or past a preview playlist the
  // recording has outgrown — the exact time.
  function seekTarget(sec) {
    return previewsWorking() && !beyondPreviewPlaylist(sec) ? anchorAt(sec).time : sec;
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
    const sec = clampSeekSeconds(pct);
    const target = seekTarget(sec);
    if (seekDragging && target !== dragTarget) {
      dragTarget = target;
      dragSeek(target);
    }
    if (seekDragging || sb.el.matches(':hover')) {
      hovered = { x: e.clientX, sec };
      // With previews: the time of the keyframe shown, where a click lands
      // (drawPreview refines it to the frame's own timestamp). Without: the
      // hovered time
      sb.time.textContent = formatTime(previewsWorking() ? target : pct * elapsed());
      showPreview(sec);
      // Keep the tooltip (160px wide with a preview) inside the bar
      const width = sb.el.clientWidth;
      const half = sb.tooltip.offsetWidth / 2;
      sb.tooltip.style.left = Math.min(Math.max(pct * width, half), Math.max(half, width - half)) + 'px';
    }
  }

  // ─── Seekbar previews (keyframe under the pointer while hovering) ────────
  // Twitch only publishes storyboards once a stream has ended, so previews are
  // decoded on the fly from the VOD's own keyframes. Twitch streams have one
  // every 2 s, and a keyframe's byte position inside a segment is roughly
  // proportional to its time — so each spot of the bar maps to its nearest
  // keyframe (an "anchor"), and range requests fetch just that frame (tens of
  // KB at 160p, a few hundred KB at source quality). It's cut out of the
  // MPEG-TS or fMP4 container and decoded with WebCodecs. The tooltip shows
  // the anchor's exact time and a click lands on it: what you see is where
  // you land.

  const PREVIEW_W = 160;
  const PREVIEW_H = 90;
  const PREVIEW_DEBOUNCE = 100;          // ms the pointer must rest before fetching
  const PREVIEW_CACHE_MAX = 200;
  const PREVIEW_RETRY = 60000;           // ms before trying again after a failure
  const PREVIEW_PLAYLIST_TTL = 15000;    // re-read the growing playlist at most this often
  const PREVIEW_READ_STEPS = [64, 256, 1024, 4096].map((kb) => kb * 1024); // growing byte ranges
  const KEYFRAME_INTERVAL = 2;           // s between keyframes in Twitch VODs
  const PTS_WRAP = 2 ** 33;              // MPEG-TS timestamps are 33-bit

  const preview = {
    gen: 0,            // bumped by resetPreview so stale async work bails out
    source: null,      // preview rendition: { url, segments, end, init, videoPid, origin, byteRate, layout, misses, gridless, fetchedAt }
    retryAt: 0,        // previews are off until then (no usable rendition, error)
    loading: false,    // a fetch is in flight
    cache: new Map(),  // anchor key -> { canvas, time }
    wantTime: 0,       // position under the pointer (s)
    debounce: 0,
  };

  // Channel change, disable or new recording: forget the rendition, the
  // frames and the hovered time
  function resetPreview() {
    preview.gen++;
    clearTimeout(preview.debounce);
    Object.assign(preview, { source: null, retryAt: 0, loading: false });
    preview.cache.clear();
    hovered = null;
  }

  function previewsAvailable() {
    return !!state.vodUrl && Date.now() >= preview.retryAt && typeof VideoDecoder === 'function';
  }

  // At least one frame decoded for this VOD: seeks snap to anchors
  function previewsWorking() {
    return !!preview.source && preview.cache.size > 0 && previewsAvailable();
  }

  // Index of the segment containing `sec` in the preview playlist
  function segmentAt(sec) {
    const segs = preview.source.segments;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= sec) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // The recording grew past the preview playlist since it was read: anchorAt()
  // would clamp `sec` to the old last keyframe (the time the playlist was read),
  // so it needs a re-read first. Within the TTL the playlist is fresh, and the
  // last keyframe really is the nearest one
  function beyondPreviewPlaylist(sec) {
    const src = preview.source;
    return !!src && sec >= src.end && Date.now() - src.fetchedAt > PREVIEW_PLAYLIST_TTL;
  }

  // Keyframe nearest to `sec` (k-th of its segment, on the 2 s grid, or the
  // segment start if the stream has no such grid). `time` is the frame's own
  // timestamp once decoded, the grid estimate before
  function anchorAt(sec) {
    const { segments, end, gridless } = preview.source;
    const segEnd = (i) => (i + 1 < segments.length ? segments[i + 1].start : end);
    let index = segmentAt(sec);
    const duration = Math.max(segEnd(index) - segments[index].start, 0.001);
    // Keyframes in the segment: one every 2 s (segments are cut on keyframes,
    // and 29.97/59.94 fps streams have 2.002 s between them, so a 10.01 s
    // segment holds 5), or just the first one on a stream without that grid
    const step = gridless ? duration : KEYFRAME_INTERVAL;
    const count = gridless ? 1 : Math.max(1, Math.ceil(duration / KEYFRAME_INTERVAL - 0.05));
    let k = Math.max(0, Math.round((sec - segments[index].start) / step));
    if (k >= count) {
      if (index + 1 < segments.length) { index++; k = 0; } // next segment's first frame is nearer
      else k = count - 1;
    }
    const start = segments[index].start;
    const key = `${index}:${k}`;
    const cached = preview.cache.get(key);
    return { key, index, k, start, time: cached ? cached.time : start + k * KEYFRAME_INTERVAL };
  }

  // Pointer over the seekbar at `sec`: show the cached frame for that spot
  // right away, and fetch it once the pointer rests there
  function showPreview(sec) {
    const sb = state.ui.seekbar;
    clearTimeout(preview.debounce);
    const on = previewsAvailable();
    sb.tooltip.classList.toggle('tr-seekbar-tooltip--preview', on);
    if (!on) return;
    preview.wantTime = sec;
    // Past a stale playlist the cached last frame isn't what's there: fetch
    // (which re-reads the playlist) instead of showing it
    const frame = preview.source && !beyondPreviewPlaylist(sec) && preview.cache.get(anchorAt(sec).key);
    if (frame) {
      drawPreview(frame);
    } else {
      sb.tooltip.classList.add('tr-seekbar-tooltip--loading');
      preview.debounce = setTimeout(fetchPreviewFrame, PREVIEW_DEBOUNCE);
    }
  }

  // A decoded anchor: its frame, and its exact time (= where a click lands)
  function drawPreview(frame) {
    const sb = state.ui.seekbar;
    if (!sb) return;
    sb.preview.getContext('2d').drawImage(frame.canvas, 0, 0, PREVIEW_W, PREVIEW_H);
    sb.time.textContent = formatTime(frame.time);
    sb.tooltip.classList.remove('tr-seekbar-tooltip--loading');
  }

  // One fetch at a time; when it lands, chase wherever the pointer is now
  async function fetchPreviewFrame() {
    if (preview.loading || !previewsAvailable()) return;
    const gen = preview.gen;
    const sec = preview.wantTime;
    preview.loading = true;
    try {
      const src = preview.source;
      if (!src || beyondPreviewPlaylist(sec)) {
        const source = src ? await refreshPreviewSource(src) : await loadPreviewSource(state.vodUrl);
        if (gen !== preview.gen) return;
        preview.source = source;
      }
      const anchor = anchorAt(sec);
      if (!preview.cache.has(anchor.key)) {
        const frame = await grabAnchor(anchor);
        if (gen !== preview.gen) return;
        preview.cache.set(anchor.key, frame);
        if (preview.cache.size > PREVIEW_CACHE_MAX) preview.cache.delete(preview.cache.keys().next().value);
      }
    } catch (e) {
      if (gen !== preview.gen) return;
      log('Seekbar previews unavailable for now:', e.message || e);
      preview.retryAt = Date.now() + PREVIEW_RETRY;
      return;
    } finally {
      if (gen === preview.gen) preview.loading = false;
    }
    // Past a stale playlist, fetch again (it re-reads the playlist) rather
    // than draw the cached last frame — but not for the spot just fetched, so
    // a fetch slower than the TTL can't loop
    const want = preview.wantTime;
    const frame = (want === sec || !beyondPreviewPlaylist(want)) && preview.cache.get(anchorAt(want).key);
    if (frame) drawPreview(frame);
    else fetchPreviewFrame();
  }

  // Playlist of the rendition used for previews: the smallest H.264 one
  // (keyframes of a few KB), falling back to larger ones — even source
  // quality works, since only single frames are downloaded
  async function loadPreviewSource(vodUrl) {
    for (const url of await previewPlaylistCandidates(vodUrl)) {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const source = parseMediaPlaylist(await res.text(), url);
      if (!source.segments.length) continue;
      if (source.init) { // fMP4: codec, decoder config and timescale come from the init segment
        const initRes = await fetchWithTimeout(source.init);
        const init = initRes.ok && mp4Init(new Uint8Array(await initRes.arrayBuffer()));
        if (!init || init.error) continue; // e.g. an HEVC rendition: try the next one
        source.init = init;
      }
      // Time origin: timestamp of the VOD's first frame, so a keyframe's own
      // timestamp tells where it sits in the VOD (and, for TS, the video pid).
      // Segment 0's size gives the rendition's byte rate, used to aim at
      // keyframes inside segments (segment sizes vary by only a few %)
      const first = await readRange(source.segments[0].url, 0, source.init
        ? (b) => mp4Keyframe(b, source.init, true)
        : (b) => tsKeyframe(b, null), true);
      if (!first) continue;
      const firstDuration = source.segments.length > 1 ? source.segments[1].start : source.end;
      source.url = url;
      source.videoPid = first.videoPid;
      source.origin = first.ticks;
      source.byteRate = first.size > 0 && firstDuration > 0 ? first.size / firstDuration : null;
      source.gridless = !source.byteRate; // can't aim inside segments: their first frames only
      source.fetchedAt = Date.now();
      return source;
    }
    throw new Error('no usable rendition');
  }

  // The recording grows: re-read the same rendition's playlist, keeping what
  // was learned about it (segment indexes don't change, so cached frames stay valid)
  async function refreshPreviewSource(src) {
    const res = await fetchWithTimeout(src.url);
    if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
    const { segments, end } = parseMediaPlaylist(await res.text(), src.url);
    return { ...src, segments, end, fetchedAt: Date.now() };
  }

  async function previewPlaylistCandidates(vodUrl) {
    if (vodUrl.includes('usher.ttvnw.net')) {
      const res = await fetchWithTimeout(vodUrl);
      if (!res.ok) throw new Error(`master playlist HTTP ${res.status}`);
      const lines = (await res.text()).split('\n');
      const variants = [];
      lines.forEach((line, i) => {
        const res = line.startsWith('#EXT-X-STREAM-INF:') && line.match(/RESOLUTION=\d+x(\d+)/); // skips audio_only
        const uri = (lines[i + 1] || '').trim();
        if (res && uri && !uri.startsWith('#')) {
          variants.push({ avc: /avc1/.test(line) ? 0 : 1, height: +res[1], url: new URL(uri, vodUrl).href });
        }
      });
      return variants.sort((a, b) => a.avc - b.avc || a.height - b.height).map((v) => v.url);
    }
    // Direct CDN playlist (sub-only VODs): .../<quality>/index-dvr.m3u8
    const QUALITY_PATH = /\/[^/]+\/index-dvr\.m3u8$/;
    if (!QUALITY_PATH.test(vodUrl)) return [vodUrl];
    return [...VOD_QUALITIES].reverse().map((q) => vodUrl.replace(QUALITY_PATH, `/${q}/index-dvr.m3u8`));
  }

  function parseMediaPlaylist(text, url) {
    const segments = [];
    let t = 0, duration = 0, init = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) {
        duration = parseFloat(line.slice(8));
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const m = line.match(/URI="([^"]+)"/);
        if (m) init = new URL(m[1], url).href;
      } else if (line && !line.startsWith('#')) {
        // DMCA-muted parts are listed as -unmuted but served as -muted (see vod-unlock.js)
        segments.push({ start: t, url: new URL(line.replace(/-unmuted/g, '-muted'), url).href });
        t += duration;
      }
    }
    return { segments, end: t, init };
  }

  // Decodes the keyframe of `anchor` -> { canvas, time }
  async function grabAnchor(anchor) {
    const { keyframe, time } = await findAnchorKeyframe(anchor);
    return { canvas: await decodeKeyframe(keyframe), time };
  }

  // Fetches the keyframe of `anchor` -> { keyframe, time (s into the VOD) }
  async function findAnchorKeyframe(anchor) {
    const src = preview.source;
    const url = src.segments[anchor.index].url;
    const timescale = src.init ? src.init.timescale : 90000;
    const secondsOf = (ticks) => {
      const delta = ticks - src.origin;
      return (src.init ? delta : ((delta % PTS_WRAP) + PTS_WRAP) % PTS_WRAP) / timescale;
    };
    const target = anchor.start + anchor.k * KEYFRAME_INTERVAL;
    if (anchor.k > 0 && src.byteRate) {
      // Jump close to the keyframe instead of reading the segment from its
      // start: segments are near-constant bitrate, so its byte position is
      // ~byte rate x its time into the segment. Renditions lay segments out
      // differently, so that ratio is learned (`layout`); until then the read
      // starts earlier. The first frame read tells where we landed (GOPs are
      // closed: frames before a keyframe are all earlier than it, frames
      // after all later): a little early, read on (frames before the
      // keyframe are skipped); far too early or past it, aim again
      let judged = false; // a frame was read in this attempt
      const aim = (ticks, key, first) => {
        judged = true;
        const offset = secondsOf(ticks) - target;
        if (offset <= -1) return first ? 'early' : 'skip';
        if (key && offset <= 1) return 'take';
        if (first && offset > 0.01) return 'past';
        return offset > 1 ? 'missing' : 'skip'; // no keyframe where the 2 s grid says
      };
      const parse = src.init ? (b) => mp4Keyframe(b, src.init, false, aim) : (b) => tsKeyframe(b, src.videoPid, aim);
      const expected = src.byteRate * (src.layout || 1) * anchor.k * KEYFRAME_INTERVAL;
      const packet = (x) => Math.max(0, Math.floor(x / 188) * 188); // TS packet boundary
      const into = target - anchor.start; // the keyframe's time into the segment
      const segEnd = anchor.index + 1 < src.segments.length ? src.segments[anchor.index + 1].start : src.end;
      let lo = { b: 0, t: 0 }, hi = null; // a byte position seen before the keyframe / after it, and its time
      let from = packet(expected - 16384 - expected * (src.layout ? 0.05 : 0.12));
      for (let attempt = 0; attempt < 4; attempt++) {
        judged = false;
        const found = await readRange(url, from, parse);
        if (found && !found.miss) {
          const layout = (from + found.byte) / (src.byteRate * anchor.k * KEYFRAME_INTERVAL);
          src.layout = src.layout ? (src.layout + layout) / 2 : layout;
          return { keyframe: found, time: secondsOf(found.ticks) };
        }
        // The segment ended after frames that were neither the keyframe nor
        // past it: it isn't in this segment
        if (found ? found.miss === 'missing' : judged) break;
        // Aim again from what this segment has shown: interpolate between the
        // positions seen before and after the keyframe (nothing read at all:
        // `from` is past the end of the file), a little early since the
        // keyframe itself is larger than other frames
        const seen = found ? { b: from + found.byte, t: secondsOf(found.ticks) - anchor.start } : { b: from, t: segEnd - anchor.start };
        if (found && found.miss === 'early') lo = seen; else hi = seen;
        const rate = hi ? (hi.b - lo.b) / (hi.t - lo.t) : lo.t > 1 ? lo.b / lo.t : src.byteRate * (src.layout || 1);
        from = Math.max(lo.b, packet(lo.b + (into - lo.t) * rate * 0.95 - 16384 - 0.3 * rate));
      }
      // A stream without a keyframe every 2 s: after two misses, anchor to
      // segment starts (always keyframes) instead of paying for more misses
      src.misses = (src.misses || 0) + 1;
      if (src.misses >= 2 && !src.gridless) {
        src.gridless = true;
        log('Preview keyframes are not every 2 s on this stream: previews snap to 10 s segments');
      }
    }
    const keyframe = await readRange(url, 0, src.init ? (b) => mp4Keyframe(b, src.init, true) : (b) => tsKeyframe(b, src.videoPid));
    if (!keyframe) throw new Error('no keyframe at the start of the segment');
    return { keyframe, time: secondsOf(keyframe.ticks) };
  }

  // Reads `url` from byte `from` in growing ranges until `parse` finds what
  // it's after (it returns null while it needs more bytes), then stops the
  // download right there. Null if the file ends first. `openEnded`: one
  // request to the end of the file, whose Content-Length reveals the file
  // size (result.size) — Twitch's CDN blocks HEAD and hides Content-Range
  // from cross-origin pages
  async function readRange(url, from, parse, openEnded = false) {
    let buf = new Uint8Array(0);
    for (const length of openEnded ? [Infinity] : PREVIEW_READ_STEPS) {
      const range = `bytes=${from + buf.length}-${openEnded ? '' : from + length - 1}`;
      const res = await fetchWithTimeout(url, { headers: { Range: range } });
      if (res.status === 416) break; // past the end of the segment
      if (res.status !== 206 && !(res.status === 200 && from === 0)) throw new Error(`segment HTTP ${res.status}`);
      if (res.status === 200) buf = new Uint8Array(0); // range ignored: this is the whole segment
      const size = (res.status === 206 ? from + buf.length : 0) + Number(res.headers.get('content-length'));
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          const grown = new Uint8Array(buf.length + value.length);
          grown.set(buf);
          grown.set(value, buf.length);
          buf = grown;
          const found = parse(buf);
          if (found) {
            reader.cancel().catch(() => {});
            if (found.error) throw new Error(found.error);
            if (openEnded) found.size = size;
            return found;
          }
        }
        if (done) break;
      }
      if (res.status === 200) break;
    }
    return null;
  }

  async function decodeKeyframe(keyframe) {
    const config = { codec: keyframe.codec, optimizeForLatency: true };
    if (keyframe.description) config.description = keyframe.description;
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`can't decode ${keyframe.codec}`);
    const canvas = document.createElement('canvas');
    canvas.width = PREVIEW_W;
    canvas.height = PREVIEW_H;
    let drawn = false;
    let failure = null;
    const decoder = new VideoDecoder({
      output: (frame) => {
        canvas.getContext('2d').drawImage(frame, 0, 0, PREVIEW_W, PREVIEW_H);
        frame.close();
        drawn = true;
      },
      error: (e) => { failure = e; },
    });
    try {
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: 0, data: keyframe.data }));
      await decoder.flush();
    } catch (e) {
      failure = failure || e;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    if (!drawn) throw failure || new Error('no frame decoded');
    return canvas;
  }

  // ── Keyframe extraction ──
  // Parsers return null while they need more bytes, { error } when the data
  // can't be used, else { codec, description?, data, ticks, rate, byte } for
  // WebCodecs (ticks / rate = the frame's timestamp in seconds, byte = where
  // it starts in `b`). `aim(ticks, key, first)`, if given, judges each frame
  // (see findAnchorKeyframe): 'take' a keyframe, 'skip' a frame, or stop
  // there with { miss: 'early' | 'past' | 'missing', ticks, byte }.

  const hexByte = (x) => x.toString(16).padStart(2, '0');
  const readU32 = (b, p) => b[p] * 0x1000000 + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];
  const readPts = (b, p) => ((b[p] >> 1) & 7) * 2 ** 30 + b[p + 1] * 2 ** 22 + (b[p + 2] >> 1) * 2 ** 15 + b[p + 3] * 2 ** 7 + (b[p + 4] >> 1);

  // H.264 access unit (Annex B): { codec } if it's a keyframe (IDR), null if
  // it isn't. SPS/PPS precede every IDR in Twitch streams
  function avcKeyframe(es) {
    let codec = null;
    for (let i = 0; i + 6 < es.length; i++) {
      if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
      const type = es[i + 3] & 0x1f;
      if (type === 7 && !codec) codec = `avc1.${hexByte(es[i + 4])}${hexByte(es[i + 5])}${hexByte(es[i + 6])}`;
      if (type === 1) return null; // first slice isn't IDR
      if (type === 5) return codec ? { codec } : { error: 'keyframe without SPS' };
    }
    return null;
  }

  // MPEG-TS: the first IDR access unit of the video pid in `b`, which starts
  // on a 188-byte packet boundary. Without a pid (start of segment 0), PAT/PMT
  // tell which pid is the H.264 video and the first video timestamp is
  // returned right away: that's the time origin
  function tsKeyframe(b, pid, aim) {
    let pmtPid = -1, videoPid = pid == null ? -1 : pid, parts = null, size = 0, ticks = 0, unitByte = 0, first = true;
    for (let off = 0; off + 188 <= b.length; off += 188) {
      if (b[off] !== 0x47) return { error: 'not an MPEG-TS segment' };
      const unitStart = b[off + 1] & 0x40;
      const packetPid = ((b[off + 1] & 0x1f) << 8) | b[off + 2];
      const adaptation = (b[off + 3] >> 4) & 3;
      if (!(adaptation & 1)) continue; // no payload
      let p = off + 4 + (adaptation === 3 ? 1 + b[off + 4] : 0);
      const end = off + 188;
      if (p >= end) continue;
      if (videoPid < 0) {
        if (packetPid === 0 && unitStart) { // PAT -> PMT pid
          p += 1 + b[p];
          const sectionEnd = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
          for (let q = p + 8; q + 4 <= sectionEnd; q += 4) {
            if (((b[q] << 8) | b[q + 1]) !== 0) { pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3]; break; }
          }
        } else if (packetPid === pmtPid && unitStart) { // PMT -> H.264 pid
          p += 1 + b[p];
          const sectionEnd = p + 3 + (((b[p + 1] & 0x0f) << 8) | b[p + 2]) - 4;
          for (let q = p + 12 + (((b[p + 10] & 0x0f) << 8) | b[p + 11]); q + 5 <= sectionEnd; q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4])) {
            if (b[q] === 0x1b) { videoPid = ((b[q + 1] & 0x1f) << 8) | b[q + 2]; break; }
          }
          if (videoPid < 0) return { error: 'no H.264 video in segment' };
        }
        continue;
      }
      if (packetPid !== videoPid) continue;
      if (unitStart) { // a PES starts: the previous one is a complete access unit
        const pesTicks = b[p + 7] & 0x80 ? readPts(b, p + 9) : 0;
        if (pid == null) return { videoPid, ticks: pesTicks, rate: 90000 };
        if (parts) {
          const unit = new Uint8Array(size);
          let o = 0;
          for (const part of parts) { unit.set(part, o); o += part.length; }
          const es = unit.subarray(9 + unit[8]); // skip the PES header
          const kf = avcKeyframe(es);
          if (kf && kf.error) return kf;
          const verdict = aim ? aim(ticks, !!kf, first) : kf ? 'take' : 'skip';
          if (verdict === 'take') return { codec: kf.codec, data: es.slice(), ticks, rate: 90000, byte: unitByte };
          if (verdict !== 'skip') return { miss: verdict, ticks, byte: unitByte };
          first = false;
        }
        parts = [];
        size = 0;
        ticks = pesTicks;
        unitByte = off;
      }
      if (parts) { parts.push(b.subarray(p, end)); size += end - p; }
    }
    return null;
  }

  function mp4Boxes(b, start, end) {
    const list = [];
    for (let p = start; p + 8 <= end;) {
      let size = readU32(b, p), header = 8;
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (size === 1) { size = readU32(b, p + 8) * 0x100000000 + readU32(b, p + 12); header = 16; } else if (size === 0) size = end - p;
      if (size < header) break;
      list.push({ type, start: p, body: p + header, end: p + size });
      p += size;
    }
    return list;
  }

  const mp4Child = (b, box, type) => box && mp4Boxes(b, box.body, Math.min(box.end, b.length)).find((x) => x.type === type);

  // fMP4 init segment: video track id, timescale and avcC decoder configuration
  function mp4Init(b) {
    const moov = mp4Boxes(b, 0, b.length).find((x) => x.type === 'moov');
    if (!moov || moov.end > b.length) return { error: 'incomplete init segment' };
    for (const trak of mp4Boxes(b, moov.body, moov.end).filter((x) => x.type === 'trak')) {
      const mdia = mp4Child(b, trak, 'mdia');
      const hdlr = mp4Child(b, mdia, 'hdlr');
      if (!hdlr || String.fromCharCode(...b.subarray(hdlr.body + 8, hdlr.body + 12)) !== 'vide') continue;
      const tkhd = mp4Child(b, trak, 'tkhd');
      const mdhd = mp4Child(b, mdia, 'mdhd');
      const stsd = mp4Child(b, mp4Child(b, mp4Child(b, mdia, 'minf'), 'stbl'), 'stsd');
      const entry = stsd && mp4Boxes(b, stsd.body + 8, stsd.end)[0];
      if (!tkhd || !mdhd || !entry || !/^avc[13]$/.test(entry.type)) return { error: `unsupported codec ${entry ? entry.type : '?'}` };
      const avcC = mp4Boxes(b, entry.body + 78, entry.end).find((x) => x.type === 'avcC'); // after the 78-byte VisualSampleEntry
      if (!avcC) return { error: 'no avcC' };
      const description = b.slice(avcC.body, avcC.end);
      return {
        trackId: readU32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12)),
        timescale: readU32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12)),
        codec: `avc1.${hexByte(description[1])}${hexByte(description[2])}${hexByte(description[3])}`,
        description,
      };
    }
    return { error: 'no video track' };
  }

  // fMP4 segments are many small fragments (moof + mdat); keyframes start a
  // fragment. Returns the first fragment in `b` whose video starts with a
  // keyframe. `atBox`: `b` begins on a box boundary; otherwise (a range
  // taken mid-segment) the first 'moof' box is looked for
  function mp4Keyframe(b, init, atBox, aim) {
    const from = atBox ? 0 : mp4FindMoof(b);
    if (from < 0) return null;
    let first = true;
    for (const box of mp4Boxes(b, from, b.length)) {
      if (box.type !== 'moof') continue;
      if (box.end > b.length) return null;
      const frag = mp4VideoFragment(b, box, init);
      if (!frag) continue;
      const verdict = aim ? aim(frag.dts, frag.sync, first) : frag.sync ? 'take' : 'skip';
      if (verdict === 'take') {
        if (frag.pos + frag.size > b.length) return null;
        return { codec: init.codec, description: init.description, data: b.slice(frag.pos, frag.pos + frag.size), ticks: frag.dts, rate: init.timescale, byte: box.start };
      }
      if (verdict !== 'skip') return { miss: verdict, ticks: frag.dts, byte: box.start };
      first = false;
    }
    return null;
  }

  // Start of the first 'moof' box: its fourcc, then an 'mfhd' child
  function mp4FindMoof(b) {
    for (let i = 4; i + 12 <= b.length; i++) {
      if (b[i] === 0x6d && b[i + 1] === 0x6f && b[i + 2] === 0x6f && b[i + 3] === 0x66 &&
          b[i + 8] === 0x6d && b[i + 9] === 0x66 && b[i + 10] === 0x68 && b[i + 11] === 0x64) return i - 4;
    }
    return -1;
  }

  // First video sample of a fragment: byte position, size, keyframe flag, decode time
  function mp4VideoFragment(b, moof, init) {
    for (const traf of mp4Boxes(b, moof.body, moof.end).filter((x) => x.type === 'traf')) {
      const tfhd = mp4Child(b, traf, 'tfhd');
      if (!tfhd || readU32(b, tfhd.body + 4) !== init.trackId) continue;
      const tfFlags = readU32(b, tfhd.body) & 0xffffff;
      let q = tfhd.body + 8, base = moof.start;
      if (tfFlags & 0x1) { base = readU32(b, q) * 0x100000000 + readU32(b, q + 4); q += 8; }
      if (tfFlags & 0x2) q += 4;
      if (tfFlags & 0x8) q += 4;
      let defaultSize = 0, flags = 0;
      if (tfFlags & 0x10) { defaultSize = readU32(b, q); q += 4; }
      if (tfFlags & 0x20) flags = readU32(b, q);
      const tfdt = mp4Child(b, traf, 'tfdt');
      const dts = !tfdt ? 0 : b[tfdt.body] === 1
        ? readU32(b, tfdt.body + 4) * 0x100000000 + readU32(b, tfdt.body + 8)
        : readU32(b, tfdt.body + 4);
      const trun = mp4Child(b, traf, 'trun');
      if (!trun) return null;
      const trFlags = readU32(b, trun.body) & 0xffffff;
      let r = trun.body + 8, dataOffset = 0;
      if (trFlags & 0x1) { dataOffset = readU32(b, r) | 0; r += 4; }
      if (trFlags & 0x4) { flags = readU32(b, r); r += 4; }
      if (trFlags & 0x100) r += 4;
      const size = trFlags & 0x200 ? readU32(b, r) : defaultSize;
      if (trFlags & 0x200) r += 4;
      if (trFlags & 0x400) flags = readU32(b, r);
      return { sync: !(flags & 0x10000), pos: base + dataOffset, size, dts };
    }
    return null;
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

    // Skip-to-end icon: Twitch's own glyph, in its 24-unit box shown at 18 px
    const skipSvg = document.createElementNS(SVG_NS, 'svg');
    skipSvg.setAttribute('width', '18');
    skipSvg.setAttribute('height', '18');
    skipSvg.setAttribute('viewBox', '0 0 24 24');
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

    // Hover tooltip: preview frame (when available) above the time
    const seekTooltip = document.createElement('span');
    seekTooltip.className = 'tr-seekbar-tooltip';
    const seekPreview = document.createElement('canvas');
    seekPreview.className = 'tr-seekbar-preview';
    seekPreview.width = PREVIEW_W;
    seekPreview.height = PREVIEW_H;
    const seekTime = document.createElement('span');
    seekTime.className = 'tr-seekbar-time';
    seekTooltip.append(seekPreview, seekTime);

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
      // The bar of a live stream grows under a resting pointer: if it hasn't
      // moved, land where the tooltip says rather than a few seconds later
      dragTarget = seekTarget(hovered && hovered.x === e.clientX ? hovered.sec : clampSeekSeconds(pct));
      startRewind(dragTarget);
    });

    state.ui.seekArea = seekArea;
    state.ui.seekbar = { el: seekbar, played: seekPlayed, thumb: seekThumb, tooltip: seekTooltip, preview: seekPreview, time: seekTime };
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

  // Twitch's own seekbar showed up: hand the player back. The watchdog keeps
  // running, so the controls come back if Twitch's seekbar goes away
  function stepAside() {
    if (state.isRewinding || state.loadingRewind) goLive();
    document.getElementById('tr-seekbar-area')?.remove();
    state.ui = {};
    seekDragging = false;
    log("Twitch's own rewind is available on this channel: stepping aside");
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
    keepControlsUp();
  }

  // Twitch hides its controls 5 s after they last appeared, and ignores
  // mouse moves until then — so with the pointer resting on the seekbar
  // (looking at previews) they faded out, and moving brought them back.
  // While the pointer is on the seekbar or dragging, re-arm that timer the
  // way entering the player does (video-ref's mouseenter handler)
  let controlsKeptAt = 0;
  function keepControlsUp() {
    const sb = state.ui.seekbar;
    if (!sb || !(seekDragging || sb.el.matches(':hover'))) return;
    if (Date.now() - controlsKeptAt < CONTROLS_KEEPALIVE) return;
    controlsKeptAt = Date.now();
    sb.el.closest('[data-a-target="video-ref"]')?.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: null }));
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

    // Twitch's own rewind is here: step aside rather than stack a second seekbar
    if (nativeRewind()) {
      if (state.ui.seekArea) stepAside();
      return;
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
    // Twitch's own rewind is on this channel: nothing to prepare (see stepAside)
    if (nativeRewind()) return;
    checkInFlight = epoch;
    try {
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
          resetPreview();
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
          // Free what was kept for this recording: the VOD player kept warm
          // for the next rewind (its buffer) and the preview frames
          if (state.loadingRewind) goLive(); // cancels a rewind load in flight
          state.vodUrl = null;
          state.hlsReady = false;
          if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
          resetPreview();
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
    if (state.hlsInstance) { state.hlsInstance.destroy(); state.hlsInstance = null; }
    state.hlsReady = false;
    resetPreview();
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
