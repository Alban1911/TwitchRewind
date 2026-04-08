const toggle = document.getElementById('toggle');

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
  toggle.checked = res?.enabled !== false;
});

toggle.addEventListener('change', () => {
  chrome.runtime.sendMessage({ type: 'SET_STATE', enabled: toggle.checked });
});
