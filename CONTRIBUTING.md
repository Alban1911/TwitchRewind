# Contributing to Twitch Rewind

Contributions are welcome! Here's how to get started.

## Setting up the development environment

1. Fork and clone the repository
2. Load the extension in Chrome as described in the [README](README.md#installation)
3. Make your changes — after editing, go to `chrome://extensions` and click the **reload** button on the extension card
4. Test on a live Twitch channel

There is no build step and no dependencies to install — the extension is plain JavaScript loaded directly by Chrome.

## Project structure

See the component overview in the [README](README.md#how-it-works). The file you'll touch most is **`src/inject.js`** — all rewind logic, UI injection, and player integration lives there.

## Guidelines

- Keep it simple — this extension is intentionally minimal with no build step and no framework
- Test with both regular and subscriber-only VOD channels
- Test SPA navigation (switching channels without a full page reload)
- Make sure the native Twitch player is fully restored when exiting rewind mode (volume, quality, play state)
- Don't attach listeners inside `injectControls()` — it runs repeatedly; use the delegated document-level handlers instead

## Reporting issues

If you find a bug or have a feature request, please [open an issue](https://github.com/Alban1911/TwitchRewind/issues). A browser console log (`F12` on the Twitch tab) helps a lot — extension logs are prefixed with `[TwitchRewind]`.
