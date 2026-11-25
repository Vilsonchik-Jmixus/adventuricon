const { ipcRenderer } = require('electron');

// Chromium does not dispatch its Ctrl-wheel page zoom event on macOS.
if (process.isMainFrame) {
  let lastStep = -Infinity;
  window.addEventListener('wheel', event => {
    if (!event.isTrusted || !(event.ctrlKey || event.metaKey) || !event.deltaY) return;
    event.preventDefault();
    if (event.timeStamp - lastStep < 75) return;
    lastStep = event.timeStamp;
    ipcRenderer.send('remote-wheel-zoom', event.deltaY < 0 ? 'in' : 'out');
  }, { capture: true, passive: false });
}
