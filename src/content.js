// Twitch Rewind — Content Script
// Runs at document_start. Injects vod-unlock.js immediately (before Twitch scripts),
// then injects hls.js + inject.js after DOM is ready.

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

  // Inject VOD unlock ASAP (before Twitch creates its player worker)
  injectScript('src/vod-unlock.js');

  // Inject rewind scripts after DOM is ready
  async function initRewind() {
    await injectScript('lib/hls.min.js');
    await injectScript('src/inject.js');

    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (response) {
        window.postMessage(
          { type: 'TWITCH_REWIND_TOGGLE', enabled: response.enabled },
          '*',
        );
      }
    });
  }

  // Listen for state changes from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_CHANGED') {
      window.postMessage(
        { type: 'TWITCH_REWIND_TOGGLE', enabled: msg.enabled },
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
