// Twitch Rewind — Content Script
// Bridges the extension context and the page context.

(function () {
  'use strict';

  function injectScript(src) {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(src);
      script.onload = () => {
        script.remove();
        resolve();
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  async function init() {
    // Inject hls.js first, then our main script
    await injectScript('lib/hls.min.js');
    await injectScript('src/inject.js');

    // Get initial state and forward to page
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
      if (response) {
        window.postMessage({
          type: 'TWITCH_REWIND_TOGGLE',
          enabled: response.enabled,
        }, '*');
      }
    });
  }

  // Listen for state changes from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STATE_CHANGED') {
      window.postMessage({
        type: 'TWITCH_REWIND_TOGGLE',
        enabled: msg.enabled,
      }, '*');
    }
  });

  init();
})();
