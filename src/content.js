// Twitch Rewind — Content Script
// Runs at document_start. Injects vod-unlock.js immediately (before Twitch scripts),
// then injects hls.js + inject.js after DOM is ready. The enable/disable state lives
// in chrome.storage, so no background page is required — the page script is kept in
// sync through chrome.storage.onChanged. This keeps a single manifest for both
// Chrome and Firefox (no background.service_worker conflict).

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

  // Inject VOD unlock ASAP (before Twitch creates its player worker)
  injectScript('src/vod-unlock.js');

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
