// Twitch Rewind — Content Script
// Injects hls.js + inject.js into the page after DOM is ready. (vod-unlock.js is not
// injected here: it's a MAIN-world content script in the manifest, so the browser runs
// it before any Twitch script — a <script> tag added from here loads asynchronously and
// can lose the race against Twitch creating its player worker.) The enable/disable
// state lives in chrome.storage, so no background page is required — the page script
// is kept in sync through chrome.storage.onChanged.

(function () {
  'use strict';

  // Inject into the page's MAIN world via <script> tag
  function injectScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = chrome.runtime.getURL(src);
      s.onload = () => {
        s.remove();
        resolve();
      };
      (document.head || document.documentElement).appendChild(s);
    });
  }

  function pushToggle() {
    chrome.storage.local.get('enabled', (data) => {
      window.postMessage(
        { type: 'TWITCH_REWIND_TOGGLE', enabled: data.enabled !== false },
        '*',
      );
    });
  }

  // Inject rewind scripts after DOM is ready, then push the initial state
  async function initRewind() {
    await injectScript('lib/hls.min.js');
    await injectScript('src/inject.js');
    pushToggle();
  }

  // Push state changes (e.g. popup toggle) back to the page script
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      window.postMessage(
        { type: 'TWITCH_REWIND_TOGGLE', enabled: changes.enabled.newValue !== false },
        '*',
      );
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRewind);
  } else {
    initRewind();
  }
})();
