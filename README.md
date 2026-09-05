<p align="center">
  <img src="icons/icon128.png" alt="Twitch Rewind" width="96" height="96">
</p>

<h1 align="center">Twitch Rewind</h1>

<p align="center">
  <strong>Rewind any live Twitch stream and unlock sub-only VODs.</strong><br>
  A lightweight Chrome extension that adds a seekbar to live streams, lets you rewind using the channel's VOD, and automatically unlocks subscriber-only VODs — no subscription needed.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/version-1.0.0-9147ff" alt="Version 1.0.0">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

---

## Features

- **Native UI integration** — A seekbar and LIVE button are injected directly into Twitch's native player controls. No separate overlay — it looks and feels like part of Twitch.
- **Instant rewind** — The VOD is pre-loaded in the background so rewinding is nearly instant when you drag the seekbar backward.
- **Sub-only VOD unlock** — Automatically unlocks subscriber-only VODs so you can watch them without subscribing. Works on both live rewind and VOD pages.
- **Volume sync** — Volume and mute state are synced between the live stream and the rewind playback. Twitch's native volume slider and mute button control the rewind video.
- **Quality switching** — Twitch's native quality selector controls the rewind video quality.
- **Smart subscription detection** — Automatically disabled on channels you're subscribed to, since you already have native VOD access.
- **SPA-aware** — Detects channel changes as you navigate Twitch without full page reloads.
- **Minimal footprint** — No external dependencies beyond [hls.js](https://github.com/video-dev/hls.js) for HLS playback. No tracking, no analytics.

## Installation

> The extension is not yet on the Chrome Web Store. Install it manually:

1. **Download or clone** this repository:
   ```
   git clone https://github.com/Alban1911/TwitchRewind.git
   ```
2. Open **Chrome** and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `TwitchRewind` folder
5. The extension icon appears in your toolbar — you're ready to go

## Usage

### Rewinding a stream

1. Go to any **live** Twitch channel (where you're not subscribed)
2. A **seekbar** and **LIVE** button appear in the native player controls
3. **Drag the seekbar backward** to any point in the stream — the VOD loads and plays from that position
4. Use the native Twitch controls as usual:

| Control | Action |
|---|---|
| Seekbar | Drag to any point in the stream |
| Play / Pause | Toggle playback (native Twitch button) |
| Volume slider | Adjusts rewind volume (native Twitch slider) |
| Quality selector | Changes rewind video quality (native Twitch menu) |
| LIVE / red dot | Return to the live broadcast |

### Keyboard shortcuts

While rewinding, the shortcuts act on the rewind playback:

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Seek 10s back / forward |
| `M` | Mute / Unmute |
| `,` / `.` | Slower / faster playback |

### Enable / Disable

Click the extension icon in the toolbar to open the popup. Use the toggle to enable or disable Twitch Rewind globally.

## How It Works

Twitch Rewind works by playing back the channel's VOD (Video on Demand) alongside the live stream. Here's the architecture:

### Components

```
manifest.json          Chrome Extension manifest (Manifest V3)
src/
  vod-unlock.js        Worker patch — intercepts fetch for sub-only VOD bypass
  content.js           Content script — injects scripts at document_start
  inject.js            Page script — core logic (VOD detection, playback, native UI injection)
  background.js        Service worker — manages enable/disable state
  popup.html / .js     Extension popup — toggle switch
  styles.css           Styles for injected controls (seekbar, buttons, LIVE)
lib/
  hls.min.js           HLS.js library for adaptive HLS playback
icons/
  icon16/48/128.png    Extension icons
```

### Flow

1. **VOD unlock** — At `document_start`, `vod-unlock.js` is injected into the page. It patches the `Worker` constructor to intercept `self.fetch` inside Twitch's Amazon IVS worker. When a Usher VOD request returns 403 (subscriber-only), it constructs a synthetic m3u8 playlist from direct CDN URLs, making sub-only VODs play natively.

2. **Channel detection** — `inject.js` detects which channel you're watching by parsing the URL, and hooks into `history.pushState`/`replaceState` to track SPA navigation.

3. **Subscription check** — When a live channel is detected, the extension checks if you're subscribed via Twitch's GQL API. If subscribed, it skips entirely (you already have native VOD access).

4. **VOD pre-loading** — If not subscribed, the extension finds the currently recording VOD, fetches a playback token, and pre-loads the HLS manifest in the background. This makes the first rewind nearly instant.

5. **Controls injection** — A seekbar and LIVE button are injected directly into Twitch's native player controls. A MutationObserver re-injects them if React re-renders the controls.

6. **Rewind activation** — Dragging the seekbar backward:
   - Shows the pre-loaded VOD video on top of the native video (inside the same `video-ref` container, below the controls overlay)
   - Seeks to the selected position and starts playback
   - Mutes the native player (event-driven — a `volumechange` listener enforces muting, and a MutationObserver catches video element replacements)
   - Syncs volume level from the native player to the VOD video

7. **Return to live** — Clicking LIVE pauses and hides the VOD video (keeping HLS alive for instant re-rewind), unmutes the native player, and resumes live playback.

### Sub-only VOD bypass

When a streamer has subscriber-only VODs, the standard token request fails. The extension handles this transparently:

1. Queries Twitch GQL for the VOD's `seekPreviewsURL` (a storyboard thumbnail URL that's always public)
2. Extracts the internal VOD path identifier from that URL
3. Constructs direct CDN URLs for each quality level (`chunked`, `1080p60`, `720p60`, etc.)
4. Probes each URL to find available qualities and detect codec (H.264/H.265)
5. Builds a synthetic HLS master playlist and returns it as a 200 response

### Limitations

- **VODs must exist** — The streamer must have VOD saving enabled. If no active recording is found, the seekbar won't appear.
- **~15 second buffer** — There is a minimum gap of ~15 seconds between the live edge and the furthest point you can seek to, since VOD segments take time to become available.
- **Browser only** — This is a Chrome/Chromium extension. Firefox support is not currently implemented.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to set up your environment and the project guidelines. Bugs and feature requests go to the [issue tracker](https://github.com/Alban1911/TwitchRewind/issues).

## Credits

The sub-only VOD unlock feature is inspired by [TwitchNoSub](https://github.com/besuper/TwitchNoSub) by [@besuper](https://github.com/besuper). The Worker fetch interception approach and direct CDN URL construction technique are based on their work.

## License

[MIT](LICENSE)
