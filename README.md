<p align="center">
  <img src="icons/icon128.png" alt="Twitch Rewind" width="96" height="96">
</p>

<h1 align="center">Twitch Rewind</h1>

<p align="center">
  <strong>Rewind any live Twitch stream and unlock sub-only VODs.</strong><br>
  A lightweight extension for Chrome/Chromium and Firefox that adds a seekbar to live streams and plays subscriber-only VODs — no subscription needed.
</p>

## Installation

> Not on any store yet — install it manually:

Download the repository: **Code → Download ZIP** on [GitHub](https://github.com/Alban1911/TwitchRewind) (or `git clone`), then unzip it.

### Chrome / Chromium

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `TwitchRewind` folder

### Firefox

Requires Firefox 128 or later. Firefox only keeps signed add-ons installed, and Twitch Rewind isn't signed yet, so load it as a temporary add-on:

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…** and select the `manifest.json` file in the `TwitchRewind` folder

Temporary add-ons are removed when Firefox closes, so repeat these steps after a restart. Firefox Developer Edition, Nightly and ESR can keep it installed instead: set `xpinstall.signatures.required` to `false` in `about:config`, zip the *contents* of the `TwitchRewind` folder (`manifest.json` at the root of the archive), rename the zip to `.xpi` and open it in Firefox.

## Usage

1. Open any **live** Twitch channel (where you're not subscribed)
2. A seekbar and a **LIVE** button appear in the player controls
3. **Drag the seekbar backward** to rewind — the channel's VOD plays from that point
4. Click **LIVE** (or the red dot at the end of the seekbar) to jump back to the live edge

While rewinding:

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `←` / `→` | Seek 10s back / forward |
| `M` | Mute / Unmute |
| `,` / `.` | Slower / faster playback |

Volume, quality, and play/pause keep working through Twitch's native controls the whole time.

## Good to know

- The streamer must have VOD saving enabled — otherwise there's nothing to rewind
- You can seek up to ~15 seconds behind the live edge (recent VOD segments take a moment to become available)
- On channels you're subscribed to, the extension stays out of the way — you already have native VOD access
- No tracking, no analytics

## Credits

The sub-only VOD unlock is inspired by [TwitchNoSub](https://github.com/besuper/TwitchNoSub) by [@besuper](https://github.com/besuper).

## License

[MIT](LICENSE)
