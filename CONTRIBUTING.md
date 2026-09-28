# Contributing to Twitch Rewind

Contributions are welcome! Here's how to get started.

## Setting up the development environment

1. Fork and clone the repository
2. Load the extension as described in the [README](README.md#installation): **Chrome/Chromium** — `chrome://extensions` → Developer mode → Load unpacked; **Firefox** — `about:debugging#/runtime/this-firefox` → Load Temporary Add-on… → `manifest.json`
3. Make your changes, then reload: in Chrome click **reload** on the extension card; in Firefox click **Reload** next to the add-on in `about:debugging`
4. Test on a live Twitch channel

The extension is plain JavaScript with no build step and no framework — the same `manifest.json` and source files run in both Chrome/Chromium and Firefox.

## Project structure

```
manifest.json          WebExtension manifest (Manifest V3) — shared by Chrome/Chromium and Firefox
src/
  vod-unlock.js        Worker patch — intercepts fetch for sub-only VOD bypass
  content.js           Content script — injects page scripts; syncs state via chrome.storage
  inject.js            Page script — core logic (VOD detection, playback, native UI injection)
  popup.html / .js     Extension popup — toggle switch
  styles.css           Styles for injected controls (seekbar, LIVE)
lib/
  hls.min.js           HLS.js library for adaptive HLS playback
icons/
  icon16/48/128.png    Extension icons
```

The file you'll touch most is **`src/inject.js`** — all rewind logic, UI injection, and player integration lives there.

## How it works

1. **VOD unlock** — `vod-unlock.js` is a MAIN-world content script, so the browser runs it at `document_start` before any Twitch script. It patches the `Worker` constructor to intercept `self.fetch` inside Twitch's Amazon IVS worker. When a Usher VOD request returns 403 (subscriber-only), it builds a synthetic m3u8 playlist from direct CDN URLs, making sub-only VODs play natively.
2. **Channel detection** — `inject.js` parses the URL for the channel and hooks `history.pushState`/`replaceState` to track SPA navigation.
3. **Subscription check** — On a live channel, the extension checks via Twitch's GQL API whether you're subscribed; if so, it skips entirely (you already have native VOD access). Twitch's own Stream Rewind (subscribers, Turbo) puts a `[data-a-target="player-seekbar"]` in the control bar: whenever it's there, the extension removes its controls and steps aside, so Turbo users never get two seekbars.
4. **VOD pre-loading** — Otherwise it finds the currently recording VOD, fetches a playback token, and pre-loads the HLS manifest silently so the first rewind is nearly instant.
5. **Controls injection** — A seekbar and LIVE button are injected into Twitch's native player controls. Twitch re-renders or replaces the control bar at will (mature-content gate, ads, reconnects), so a watchdog — a 500 ms tick plus a MutationObserver re-bound to the current player container — re-injects them whenever they go missing. Transient Twitch API errors never count as "stream ended", so they can't make the controls disappear. Twitch hides its controls 5 s after they appear, even with the pointer resting on them; while the pointer is on the seekbar (or dragging it), the extension re-arms that timer so the controls and the preview stay up.
6. **Seekbar previews** — Twitch only publishes storyboards once a stream has ended, so previews are made on the fly from the VOD's own keyframes. Twitch streams have one every 2 s (2.002 s at 29.97/59.94 fps), so each spot of the seekbar maps to its nearest keyframe. Once the pointer rests on the bar (100 ms), the extension fetches just that frame with HTTP range requests: segments are near-constant bitrate, so a keyframe's byte position is roughly its time × the rendition's byte rate (measured on the first segment, since Twitch's CDN blocks `HEAD`), corrected by a factor learned from every frame found. Frames read before the target are skipped; if the first frame read is already past it, the read backs up. The frame is cut out of the MPEG-TS or fMP4 container, decoded with WebCodecs and cached. It uses the smallest H.264 rendition: tens of KB per preview at 160p, a few hundred KB at source quality on channels without transcodes. The tooltip shows the keyframe's exact time and clicks and drags land on it, so playback starts on exactly the frame you saw (renditions share keyframe times, so the 160p preview matches whatever quality plays). On a stream without a keyframe every 2 s, previews fall back to segment starts (~10 s).
7. **Rewind** — Dragging the seekbar backward shows a second video (the VOD) on top of the native one, mutes the native player (event-driven), and syncs volume and quality from Twitch's native controls.
8. **Return to live** — LIVE pauses and hides the VOD video (HLS stays warm for instant re-rewind), unmutes the native player, and resumes live playback.

State flow: the popup and the content script read and write `chrome.storage.local` directly, and the content script
reacts to `chrome.storage.onChanged`, so no background page is needed. If one ever is, declare both
`background.scripts` (used by Firefox) and `background.service_worker` (used by Chrome) — both browsers accept a
manifest with the two keys since version 121.

### Sub-only VOD bypass

For subscriber-only VODs the standard token request fails, so the extension queries GQL for the VOD's `seekPreviewsURL` (a storyboard thumbnail URL that's always public), extracts the internal VOD path identifier from it, probes direct CDN URLs for each quality level (`chunked`, `1080p60`, `720p60`, …), and returns a synthetic HLS master playlist as a 200 response.

## Guidelines

- Keep it simple — this extension is intentionally minimal with no build step and no framework
- Test in both Chrome/Chromium and Firefox — the code must stay identical across browsers
- Test with both regular and subscriber-only VOD channels
- Test SPA navigation (switching channels without a full page reload)
- Make sure the native Twitch player is fully restored when exiting rewind mode (volume, quality, play state)
- Don't attach listeners inside `injectControls()` — it runs repeatedly; use the delegated document-level handlers instead

## Reporting issues

If you find a bug or have a feature request, please [open an issue](https://github.com/Alban1911/TwitchRewind/issues). A browser console log (`F12` on the Twitch tab) helps a lot — extension logs are prefixed with `[TwitchRewind]`.
