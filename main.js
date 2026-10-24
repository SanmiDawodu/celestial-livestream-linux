// Celestial Worldwide Livestream for Linux (1.0.0, 2026-10-24).
// A window around the church's web player (https://cccworldwide.net/livestream-app/), the same player as the
// Samsung/LG TV apps and the computer web player. It starts with sound, F11 toggles full screen, links to
// other websites (chat, guide pages, social media) open in the normal browser.
const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');

const START = 'https://cccworldwide.net/livestream-app/';
const OWN = ['cccworldwide.net', 'ccc.cccworldwide.net'];

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName('Celestial Worldwide Livestream');

function ours(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && OWN.includes(u.hostname);
  } catch (e) {
    return false;
  }
}

function openWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: '#07101d',
    title: 'Celestial Worldwide Livestream',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!ours(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'Escape' && win.isFullScreen()) win.setFullScreen(false);
  });
  win.loadURL(START);
}

Menu.setApplicationMenu(null);
app.whenReady().then(openWindow);
app.on('window-all-closed', () => app.quit());
