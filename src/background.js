// Twitch Rewind — Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ enabled: true });
});

// Relay enable/disable state to content scripts
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get('enabled', (data) => {
      sendResponse({ enabled: data.enabled !== false });
    });
    return true; // async response
  }

  if (msg.type === 'SET_STATE') {
    chrome.storage.local.set({ enabled: msg.enabled });
    // Broadcast to all Twitch tabs
    chrome.tabs.query({ url: '*://*.twitch.tv/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'STATE_CHANGED',
          enabled: msg.enabled,
        }).catch(() => {});
      }
    });
  }
});
