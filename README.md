<p align="center">
  <img src="icons/icon128.png" alt="Twitch Rewind" width="96" height="96">
</p>

<h1 align="center">Twitch Rewind</h1>

<p align="center">
  <strong>Rewind any live Twitch stream and unlock sub-only VODs.</strong><br>
  A lightweight Chrome extension that lets you seek backward on live streams using the channel's VOD, and automatically unlocks subscriber-only VODs — no subscription needed.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/manifest-v3-blue" alt="Manifest V3">
  <img src="https://img.shields.io/badge/version-1.0.0-9147ff" alt="Version 1.0.0">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License">
</p>

---

## Features

- **One-click rewind** — A rewind button appears in the native Twitch player controls. Click it to jump back in the stream.
- **Full playback controls** — Seek bar, play/pause, skip forward/back (10s), volume, fullscreen, and keyboard shortcuts.
- **Return to live** — Press the LIVE button or hit `Escape` to instantly return to the live broadcast.
- **Sub-only VOD unlock** — Automatically unlocks subscriber-only VODs so you can watch them without subscribing. Works on both live rewind and VOD pages.
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

1. Go to any **live** Twitch channel
2. A **rewind button** (circular arrow icon) appears in the player's bottom-right control bar
3. **Click the rewind button** — the extension loads the channel's VOD and seeks to where the stream currently is (minus a small buffer)
4. Use the **custom controls** to navigate:

| Control | Action |
|---|---|
| Seek bar | Drag to any point in the stream |
| Play / Pause | Toggle playback (or click the video) |
| Skip back | Jump 10 seconds backward |
| Skip forward | Jump 10 seconds forward |
| Volume | Adjust with slider or mute toggle |
| LIVE | Return to the live broadcast |
| Fullscreen | Enter/exit fullscreen |

### Keyboard shortcuts (while in rewind mode)

| Key | Action |
|---|---|
| `Space` | Play / Pause |
| `Left Arrow` | Seek back 10s |
| `Right Arrow` | Seek forward 10s |
| `F` | Toggle fullscreen |
| `Escape` | Return to live |

### Enable / Disable

Click the extension icon in the toolbar to open the popup. Use the toggle to enable or disable Twitch Rewind globally.

## How It Works

Twitch Rewind works by playing back the channel's VOD (Video on Demand) alongside the live stream. Here's the architecture:

### Components

```
manifest.json          Chrome Extension manifest (Manifest V3)
src/
  vod-unlock.js        MAIN world script — patches fetch/Worker for sub-only VOD bypass
  background.js        Service worker — manages enable/disable state
  content.js           Content script — injects hls.js and the main script into the page
  inject.js            Page script — all core logic (VOD detection, playback, UI)
  popup.html / .js     Extension popup — toggle switch
  styles.css           All custom styles for the overlay and controls
lib/
  hls.min.js           HLS.js library for adaptive HLS playback
icons/
  icon16/48/128.png    Extension icons
```

### Flow

1. **VOD unlock** — At `document_start`, `vod-unlock.js` runs in the MAIN world (before Twitch's own scripts). It patches `window.fetch` and the `Worker` constructor so that any Usher VOD request returning 403 (subscriber-only) is transparently replaced with a synthetic m3u8 playlist built from direct CDN URLs. This makes sub-only VODs play natively in Twitch's player.

2. **Channel detection** — The content script injects `inject.js` into the Twitch page. The script detects which channel you're watching by parsing the URL, and hooks into `history.pushState`/`replaceState` to track SPA navigation.

3. **VOD lookup** — When a channel is detected, the script queries Twitch's GQL API for the most recent archive VOD (within the last 48 hours). If found, the rewind button is added to the native player controls.

4. **Rewind activation** — Clicking the rewind button:
   - Fetches a VOD playback token via Twitch's `PlaybackAccessToken_Template` GQL query
   - Constructs an HLS playlist URL through Twitch's Usher service
   - If the token is rejected (subscriber-only), falls back to **direct CDN access** by extracting the internal VOD path from the `seekPreviewsURL` metadata field
   - Creates a video overlay on top of the native player
   - Loads the VOD into hls.js and seeks to the appropriate position
   - Mutes the native live player underneath

5. **Return to live** — Clicking LIVE (or pressing Escape) destroys the HLS instance, hides the overlay, and restores the native player's volume.

### Sub-only VOD bypass

When a streamer has subscriber-only VODs, the standard token request fails. The extension handles this transparently:

1. Queries Twitch GQL for the VOD's `seekPreviewsURL` (a storyboard thumbnail URL that's always public)
2. Extracts the internal VOD path identifier from that URL
3. Constructs direct CDN URLs for each quality level (`chunked`, `1080p60`, `720p60`, etc.)
4. Probes each URL and uses the first one that responds successfully
5. Feeds the direct m3u8 URL to hls.js — no token needed

### Limitations

- **VODs must exist** — The streamer must have VOD saving enabled (either "Store past broadcasts" or automatic archiving). If no recent VOD is found, the rewind button won't appear.
- **~15 second buffer** — There is a minimum gap of ~15 seconds between the live edge and the furthest point you can seek to, since VOD segments take time to become available.
- **Browser only** — This is a Chrome/Chromium extension. Firefox support is not currently implemented (Manifest V3 differences).

## Contributing

Contributions are welcome! Here's how to get started:

### Setting up the development environment

1. Fork and clone the repository
2. Load the extension in Chrome as described in [Installation](#installation)
3. Make your changes — after editing, go to `chrome://extensions` and click the **reload** button on the extension card
4. Test on a live Twitch channel

### Project structure

- **`src/vod-unlock.js`** — Runs at `document_start` in the MAIN world. Patches `fetch` and `Worker` to intercept and bypass sub-only VOD restrictions before Twitch's player loads.
- **`src/inject.js`** — Core rewind logic. Runs in the page context (not the extension context) so it can access Twitch's cookies and DOM directly.
- **`src/content.js`** — Thin bridge that injects scripts and relays messages between the extension and the page.
- **`src/styles.css`** — All styling for the rewind button, overlay, controls, and notifications.
- **`src/background.js`** — Minimal service worker for persisting the enable/disable toggle.

### Guidelines

- Keep it simple — this extension is intentionally minimal with no build step and no framework
- Test with both regular and subscriber-only VOD channels
- Test SPA navigation (switching channels without full page reload)
- Make sure the native Twitch player is fully restored when exiting rewind mode

### Reporting issues

If you find a bug or have a feature request, please [open an issue](https://github.com/Alban1911/TwitchRewind/issues).

## Credits

The sub-only VOD unlock feature is inspired by [TwitchNoSub](https://github.com/besuper/TwitchNoSub) by [@besuper](https://github.com/besuper). The Worker fetch interception approach and direct CDN URL construction technique are based on their work.

## License

MIT
