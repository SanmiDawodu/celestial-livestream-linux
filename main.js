// Celestial Worldwide Livestream for Linux (1.1.0, 2026-10-24).
// A window around the church's web player (https://cccworldwide.net/livestream-app/), plus desktop features:
//  - a tray icon showing what is on air, with the channels, settings and Quit;
//  - a notification when a live service starts (it keeps running in the tray after the window closes);
//  - sound only: plays the audio of a channel or CCC Radio without video;
//  - the sound menu / media keys show the channel and can pause it (MPRIS, through Chromium's media session);
//  - launcher actions: watch the live service, the 24/7 channel, listen to CCC Radio, sound only, quit;
//  - optional start with the computer (quietly, in the tray);
//  - remembers the window size and position, full screen and the last channel.
// Links to other websites (chat, guide pages, social media) open in the normal browser. F11 toggles full screen.
const { app, BrowserWindow, shell, Menu, Tray, Notification, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const NAME = 'Celestial Worldwide Livestream';
const START = 'https://cccworldwide.net/livestream-app/';
const CONFIG_URL = 'https://cccworldwide.net/wp-json/ccc-app/v1/config';
const RADIO = 'https://cccworldwide.net/radio/live.mp3';
const OME = 'https://ccc.cccworldwide.net/app/';
const OWN = ['cccworldwide.net', 'ccc.cccworldwide.net'];
const VIDEO = ['service', 'studio2', 'playout'];
const TITLES = { service: 'Live service', studio2: 'Studio 2', playout: 'CCC Worldwide 24/7', radio: 'CCC Radio' };
const ICON = path.join(__dirname, 'icon.png');

let cfg = {
  service: [OME + 'ccc-worldwide-livestreams-wc/llhls.m3u8', OME + 'ccc-worldwide-livestreams/llhls.m3u8', OME + 'ccc-worldwide-livestreams_cbr8m/llhls.m3u8'],
  studio2: OME + 'ccc-livekit-studio/llhls.m3u8',
  playout: OME + 'playout/llhls.m3u8',
  audio: OME + 'ccc-audio/llhls.m3u8',
};
let onAir = {};          // channel -> stream address on air now
let checkedOnce = false;
let win = null;          // the video window
let audioWin = null;     // hidden window that plays sound only
let listening = null;    // channel playing as sound only
let tray = null;
let quitting = false;
let toldAboutTray = false;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setName(NAME);

// ---- settings -------------------------------------------------------------------------------
const SETTINGS = path.join(app.getPath('userData'), 'settings.json');
let settings = { channel: null, soundOnly: false, alerts: true, keepInTray: true, autostart: false, bounds: null, maximized: false, fullScreen: false };
try { Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))); } catch (e) {}
function save() {
  try { fs.mkdirSync(path.dirname(SETTINGS), { recursive: true }); fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 1)); } catch (e) {}
}

// ---- start with the computer ----------------------------------------------------------------
// Snap: snapd starts the app when this file exists (snap.autoStart in package.json). Others: XDG autostart.
function autostartFile() {
  if (process.env.SNAP_USER_DATA) return path.join(process.env.SNAP_USER_DATA, '.config', 'autostart', 'celestial-worldwide-livestream.desktop');
  return path.join(app.getPath('home'), '.config', 'autostart', 'net.cccworldwide.Livestream.desktop');
}
function setAutostart(on) {
  settings.autostart = on;
  save();
  const file = autostartFile();
  try {
    if (!on) { fs.rmSync(file, { force: true }); return; }
    let exec;
    if (process.env.SNAP) exec = 'celestial-worldwide-livestream';
    else if (process.env.APPIMAGE) exec = '"' + process.env.APPIMAGE + '"';
    else exec = '"' + process.execPath + '"';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['[Desktop Entry]', 'Type=Application', 'Name=' + NAME, 'Exec=' + exec + ' --hidden',
      'Icon=net.cccworldwide.Livestream', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
  } catch (e) {}
}

// ---- what is on air -------------------------------------------------------------------------
async function getText(url) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
async function isUp(url) {
  try { return (await getText(url)).startsWith('#EXTM3U'); } catch (e) { return false; }
}
async function loadConfig() {
  try {
    const c = JSON.parse(await getText(CONFIG_URL));
    for (const k of ['service', 'studio2', 'playout', 'audio']) if (c[k] && c[k].length) cfg[k] = c[k];
  } catch (e) {}
}
async function checkOnAir() {
  const found = {};
  for (const u of [].concat(cfg.service)) if (await isUp(u)) { found.service = u; break; }
  if (await isUp(cfg.studio2)) found.studio2 = cfg.studio2;
  if (await isUp(cfg.playout)) found.playout = cfg.playout;
  const wasLive = !!onAir.service;
  onAir = found;
  if (checkedOnce && !wasLive && found.service) liveAlert();
  if (checkedOnce && wasLive && !found.service && listening === 'service') listen('radio');
  checkedOnce = true;
  updateTray();
}
function liveAlert() {
  if (!settings.alerts || !Notification.isSupported()) return;
  if (win && win.isVisible() && win.isFocused()) return;
  const n = new Notification({ title: 'Live now', body: 'The Celestial Church of Christ Worldwide service is live. Click to watch.', icon: ICON });
  n.on('click', () => watch('service'));
  n.show();
}

// ---- video window ---------------------------------------------------------------------------
function ours(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && OWN.includes(u.hostname);
  } catch (e) {
    return false;
  }
}
function startUrl(channel) {
  return VIDEO.includes(channel) ? START + '?channel=' + channel : START;
}
function visibleBounds(b) {
  if (!b) return null;
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y >= a.y - 20 && b.y < a.y + a.height - 50;
  });
  return ok ? b : null;
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  settings.maximized = win.isMaximized();
  settings.fullScreen = win.isFullScreen();
  if (!settings.maximized && !settings.fullScreen) settings.bounds = win.getBounds();
  save();
}
// Sets the sound-menu entry (MPRIS) to the channel shown on the page.
const MEDIA_SESSION = `(function () {
  if (window.__cccMediaSession) return; window.__cccMediaSession = 1;
  function update() {
    try {
      var t = (document.getElementById('title') || {}).textContent || '${NAME}';
      navigator.mediaSession.metadata = new MediaMetadata({ title: t, artist: 'Celestial Church of Christ Worldwide',
        artwork: [{ src: 'https://cccworldwide.net/livestream-app/icon-192.png', sizes: '192x192', type: 'image/png' }] });
    } catch (e) {}
  }
  update(); setInterval(update, 5000);
})();`;

function openWindow(channel) {
  if (win && !win.isDestroyed()) {
    if (channel !== undefined) win.loadURL(startUrl(channel));
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  const b = visibleBounds(settings.bounds) || { width: 1280, height: 760 };
  win = new BrowserWindow({
    ...b,
    minWidth: 480,
    minHeight: 300,
    backgroundColor: '#07101d',
    title: NAME,
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  if (settings.maximized) win.maximize();
  if (settings.fullScreen) win.setFullScreen(true);
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
  win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript(MEDIA_SESSION).catch(() => {}));
  // Right-click shows the same menu as the tray, for desktops without a tray.
  win.webContents.on('context-menu', () => buildMenu().popup({ window: win }));
  win.on('resize', saveWindowState);
  win.on('move', saveWindowState);
  win.on('close', () => {
    saveWindowState();
    if (!quitting && settings.keepInTray && !toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: NAME, body: 'Still running in the tray, to tell you when a service goes live. Quit from the tray menu.', icon: ICON }).show();
    }
  });
  win.on('closed', () => { win = null; });
  win.loadURL(startUrl(channel === undefined ? settings.channel : channel));
}

// Opens (or switches) the video window; without a channel an open window is just brought forward.
function watch(channel) {
  if (channel) settings.channel = channel;
  settings.soundOnly = false;
  save();
  openWindow(channel);
  stopSound();
}

// ---- sound only -----------------------------------------------------------------------------
// The 24/7 channel and Studio 2 are video: play only their audio rendition when there is one.
async function audioOnly(master) {
  try {
    const text = await getText(master);
    const m = /#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"/.exec(text);
    if (m) return new URL(m[1], master).href;
  } catch (e) {}
  return master;
}
async function listen(channel) {
  await ready;
  // Without a choice, CCC Radio: it follows whatever is on air.
  if (!channel || (channel !== 'radio' && !onAir[channel])) channel = 'radio';
  let src = RADIO;
  if (channel === 'service') src = (await isUp(cfg.audio)) ? cfg.audio : await audioOnly(onAir.service);
  else if (channel !== 'radio') src = await audioOnly(onAir[channel]);
  if (!audioWin || audioWin.isDestroyed()) {
    audioWin = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    audioWin.on('page-title-updated', (e, title) => { if (title === 'error' && listening !== 'radio') listen('radio'); });
    audioWin.on('closed', () => { audioWin = null; listening = null; updateTray(); });
  }
  if (win && !win.isDestroyed()) { saveWindowState(); win.destroy(); }
  listening = channel;
  settings.soundOnly = true;
  if (channel !== 'radio') settings.channel = channel;
  save();
  audioWin.loadFile(path.join(__dirname, 'audio.html'), { query: { src, title: TITLES[channel] } });
  updateTray();
}
function stopSound() {
  if (audioWin && !audioWin.isDestroyed()) audioWin.destroy();
  audioWin = null;
  listening = null;
  updateTray();
}

// ---- tray and menu --------------------------------------------------------------------------
function onAirText() {
  const on = VIDEO.filter((k) => onAir[k]).map((k) => TITLES[k]);
  if (!checkedOnce) return 'Checking what is on air...';
  return on.length ? 'On air: ' + on.join(', ') : 'Nothing on air right now';
}
function buildMenu() {
  const items = [
    { label: onAirText(), enabled: false },
    { label: 'Open the player', click: () => watch() },
    { type: 'separator' },
    { label: 'Watch the live service', enabled: !!onAir.service, click: () => watch('service') },
    { label: 'Watch Studio 2', enabled: !!onAir.studio2, click: () => watch('studio2') },
    { label: 'Watch CCC Worldwide 24/7', enabled: !!onAir.playout, click: () => watch('playout') },
    { label: 'Listen to CCC Radio', click: () => listen('radio') },
    { type: 'separator' },
    { label: 'Sound only (no video)', type: 'checkbox', checked: !!listening, click: (i) => (i.checked ? listen(settings.channel) : watch()) },
  ];
  if (listening) items.push({ label: 'Stop the sound (' + TITLES[listening] + ')', click: stopSound });
  items.push(
    { type: 'separator' },
    { label: 'Tell me when a service goes live', type: 'checkbox', checked: settings.alerts, click: (i) => { settings.alerts = i.checked; save(); } },
    { label: 'Start when the computer starts', type: 'checkbox', checked: settings.autostart, click: (i) => setAutostart(i.checked) },
    { label: 'Keep running in the tray when the window closes', type: 'checkbox', checked: settings.keepInTray, click: (i) => { settings.keepInTray = i.checked; save(); } },
    { type: 'separator' },
    { label: 'Quit', click: quit },
  );
  return Menu.buildFromTemplate(items);
}
function updateTray() {
  if (!tray) return;
  const tip = listening ? NAME + ' - ' + TITLES[listening] : NAME + ' - ' + onAirText();
  tray.setToolTip(tip);
  tray.setContextMenu(buildMenu());
}
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 24, height: 24 }));
    tray.on('click', () => watch());
    updateTray();
  } catch (e) {
    tray = null;
  }
}
function quit() {
  quitting = true;
  saveWindowState();
  app.quit();
}

// ---- command line and launcher actions -------------------------------------------------------
// --channel=service|studio2|playout|radio, --sound-only, --hidden (start in the tray), --quit
function handleArgs(argv, firstRun) {
  const arg = (name) => argv.find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (arg('quit')) return quit();
  const ch = (arg('channel') || '').split('=')[1];
  const channel = Object.keys(TITLES).includes(ch) ? ch : undefined;
  if (channel === 'radio') return listen('radio');
  if (arg('sound-only')) return listen(channel || settings.channel);
  if (firstRun && arg('hidden')) return;   // started with the computer: wait quietly in the tray
  if (firstRun && settings.soundOnly && !channel) return listen(settings.channel);
  watch(channel);
}

let ready = null;   // the first check of what is on air

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (e, argv) => handleArgs(argv, false));
  Menu.setApplicationMenu(null);
  app.whenReady().then(() => {
    createTray();
    ready = loadConfig().then(checkOnAir);
    handleArgs(process.argv, true);
    setInterval(checkOnAir, 30000);
    setInterval(loadConfig, 600000);
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => {
    if (quitting || !settings.keepInTray || !tray) app.quit();
  });
}
