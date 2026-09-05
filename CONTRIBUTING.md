# Contributing to Twitch Rewind

Contributions are welcome! Here's how to get started.

## Setting up the development environment

1. Fork and clone the repository
2. Load the extension in Chrome as described in the [README](README.md#installation)
3. Make your changes — after editing, go to `chrome://extensions` and click the **reload** button on the extension card
4. Test on a live Twitch channel

There is no build step and no dependencies to install — the extension is plain JavaScript loaded directly by Chrome.

## Project structure

```
manifest.json          Chrome Extension manifest (Manifest V3)
src/
  vod-unlock.js        Worker patch — intercepts fetch for sub-only VOD bypass
  content.js           Content script — injects scripts at document_start
  inject.js            Page script — core logic (VOD detection, playback, native UI injection)
  background.js        Service worker — manages enable/disable state
  popup.html / .js     Extension popup — toggle switch
  styles.css           Styles for injected controls (seekbar, LIVE)
lib/
  hls.min.js           HLS.js library for adaptive HLS playback
icons/
  icon16/48/128.png    Extension icons
```

The file you'll touch most is **`src/inject.js`** — all rewind logic, UI injection, and player integration lives there.

## How it works

1. **VOD unlock** — At `document_start`, `vod-unlock.js` patches the `Worker` constructor to intercept `self.fetch` inside Twitch's Amazon IVS worker. When a Usher VOD request returns 403 (subscriber-only), it builds a synthetic m3u8 playlist from direct CDN URLs, making sub-only VODs play natively.
2. **Channel detection** — `inject.js` parses the URL for the channel and hooks `history.pushState`/`replaceState` to track SPA navigation.
3. **Subscription check** — On a live channel, the extension checks via Twitch's GQL API whether you're subscribed; if so, it skips entirely (you already have native VOD access).
4. **VOD pre-loading** — Otherwise it finds the currently recording VOD, fetches a playback token, and pre-loads the HLS manifest in the background so the first rewind is nearly instant.
5. **Controls injection** — A seekbar and LIVE button are injected into Twitch's native player controls. A MutationObserver re-injects them when React re-renders the controls.
6. **Rewind** — Dragging the seekbar backward shows a second video (the VOD) on top of the native one, mutes the native player (event-driven), and syncs volume and quality from Twitch's native controls.
7. **Return to live** — LIVE pauses and hides the VOD video (HLS stays warm for instant re-rewind), unmutes the native player, and resumes live playback.

### Sub-only VOD bypass

For subscriber-only VODs the standard token request fails, so the extension queries GQL for the VOD's `seekPreviewsURL` (a storyboard thumbnail URL that's always public), extracts the internal VOD path identifier from it, probes direct CDN URLs for each quality level (`chunked`, `1080p60`, `720p60`, …), and returns a synthetic HLS master playlist as a 200 response.

## Guidelines

- Keep it simple — this extension is intentionally minimal with no build step and no framework
- Test with both regular and subscriber-only VOD channels
- Test SPA navigation (switching channels without a full page reload)
- Make sure the native Twitch player is fully restored when exiting rewind mode (volume, quality, play state)
- Don't attach listeners inside `injectControls()` — it runs repeatedly; use the delegated document-level handlers instead

## Reporting issues

If you find a bug or have a feature request, please [open an issue](https://github.com/Alban1911/TwitchRewind/issues). A browser console log (`F12` on the Twitch tab) helps a lot — extension logs are prefixed with `[TwitchRewind]`.
