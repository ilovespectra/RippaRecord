'use strict';
const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  globalShortcut,
  screen,
  ipcMain,
  nativeImage,
  systemPreferences,
  Notification,
  dialog,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./lib/config');
const { Reason } = require('./lib/reason');
const audio = require('./lib/audio');
const media = require('./lib/media');
const { generateSessionName } = require('./lib/namer');
const { sleep } = require('./lib/applescript');

function diagnostic(...parts) {
  const message = parts.map((part) => {
    if (typeof part === 'string') return part;
    try { return JSON.stringify(part); } catch { return String(part); }
  }).join(' ');
  console.log(message);
  try {
    const directory = app.getPath('userData');
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(path.join(directory, 'rippa-diagnostics.log'), `${new Date().toISOString()} ${message}\n`);
  } catch { /* diagnostics must never block recording */ }
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
if (primaryInstance && app.isPackaged) config.initialize(app.getPath('userData'));
let cfg = config.load();
const reason = new Reason(cfg, (...a) => diagnostic('[reason]', ...a));
const trackLog = new media.TrackLog();

/** idle | arming | waiting-login | ready | recording | paused | finishing | done | error */
let state = 'idle';
let tray = null;
let widget = null;
let indicator = null;
let setupWindow = null;
let followTimer = null;
let playbackWatch = null;
let savedAudio = null;
let lastSessionName = null;
let recordingStartPosition = null;
let recordingEndPosition = null;

const WIDGET_SIZE = { w: 300, h: 170 };
const INDICATOR_SIZE = { w: 170, h: 54 };

// ---------------------------------------------------------------- windows

function createWidget() {
  widget = new BrowserWindow({
    width: WIDGET_SIZE.w,
    height: WIDGET_SIZE.h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js') },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widget.setIgnoreMouseEvents(true);
  return widget.loadFile(path.join(__dirname, 'ui', 'widget.html'));
}

function createIndicator() {
  indicator = new BrowserWindow({
    width: INDICATOR_SIZE.w,
    height: INDICATOR_SIZE.h,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js') },
  });
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  return indicator.loadFile(path.join(__dirname, 'ui', 'indicator.html'));
}

function openSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 680,
    minHeight: 640,
    title: 'Rippa Record — Device Setup',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js') },
  });
  setupWindow.once('ready-to-show', () => setupWindow && setupWindow.show());
  setupWindow.on('closed', () => { setupWindow = null; });
  setupWindow.loadFile(path.join(__dirname, 'ui', 'setup.html'));
}

function indicatorTarget() {
  const d = screen.getPrimaryDisplay().workArea;
  const m = cfg.indicatorMargin;
  return {
    x: d.x + d.width - INDICATOR_SIZE.w - m,
    y: d.y + d.height - INDICATOR_SIZE.h - m,
  };
}

// ------------------------------------------------------- widget behaviour

function startFollowingCursor() {
  stopFollowingCursor();
  let cur = screen.getCursorScreenPoint();
  let pos = { x: cur.x + 24, y: cur.y + 24 };
  followTimer = setInterval(() => {
    if (!widget || widget.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    const disp = screen.getDisplayNearestPoint(c).workArea;
    const target = {
      x: Math.min(Math.max(c.x + 24, disp.x), disp.x + disp.width - WIDGET_SIZE.w),
      y: Math.min(Math.max(c.y + 24, disp.y), disp.y + disp.height - WIDGET_SIZE.h),
    };
    // ease toward the cursor for a floaty feel
    pos.x += (target.x - pos.x) * 0.25;
    pos.y += (target.y - pos.y) * 0.25;
    widget.setPosition(Math.round(pos.x), Math.round(pos.y));
  }, 16);
}

function stopFollowingCursor() {
  if (followTimer) clearInterval(followTimer);
  followTimer = null;
}

/** Glide the widget to the bottom-right corner, then swap to the red dot. */
async function dockWidgetToCorner() {
  stopFollowingCursor();
  if (!widget || widget.isDestroyed()) return;
  const from = widget.getBounds();
  const to = indicatorTarget();
  const steps = 40;
  for (let i = 1; i <= steps; i++) {
    const t = 1 - Math.pow(1 - i / steps, 3); // ease-out cubic
    widget.setPosition(
      Math.round(from.x + (to.x - from.x) * t),
      Math.round(from.y + (to.y - from.y) * t)
    );
    await sleep(14);
  }
  widget.hide();
  const p = indicatorTarget();
  indicator.setPosition(p.x, p.y);
  indicator.showInactive();
  sendIndicator();
}

// ------------------------------------------------------------ messaging

function sendWidget(extra = {}) {
  if (widget && !widget.isDestroyed()) {
    // clickable only when it offers action buttons; otherwise stays click-through
    widget.setIgnoreMouseEvents(!(extra.actions && extra.actions.length));
    widget.webContents.send('state', { state, ...extra });
  }
}

function sendIndicator() {
  if (indicator && !indicator.isDestroyed()) {
    indicator.webContents.send('state', { state });
  }
}

function setState(s, extra = {}) {
  state = s;
  diagnostic('[state]', s, extra.message || '');
  sendWidget(extra);
  sendIndicator();
  refreshTray();
}

function notify(title, body) {
  try {
    new Notification({ title, body }).show();
  } catch { /* notifications unavailable */ }
}

// -------------------------------------------------------------- arming

const STEP_LABELS = [
  'Checking internet (for Reason login)',
  'Launching Reason (background)',
  'Checking login',
  'Opening rippa-record (background)',
  'Setting configured audio levels',
  'Routing system audio',
  'Setting Reason input',
  'Arming Track 1 & jumping to session end',
  'Pausing all other players',
  'Rolling: hitting Record',
];

/** Fast connectivity probe — Reason's login requires internet. */
async function hasInternet() {
  try {
    await fetch('http://captive.apple.com/hotspot-detect.html', {
      signal: AbortSignal.timeout(4000),
    });
    return true;
  } catch {
    return false;
  }
}

async function enableRippaMode() {
  if (state !== 'idle' && state !== 'done' && state !== 'error') return;
  if (cfg.setupComplete === false) {
    openSetupWindow();
    return;
  }
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    const accessibilityApp = app.isPackaged ? 'Rippa Record' : 'Electron';
    widget.showInactive();
    setState('error', {
      message: `Allow ${accessibilityApp} in Accessibility`,
      recommendation: `Enable ${accessibilityApp} in System Settings > Privacy & Security > Accessibility, then Retry.`,
      actions: [
        { id: 'open-accessibility', label: 'Open Settings' },
        { id: 'retry-arming', label: 'Retry' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    });
    return;
  }
  const warnings = [];
  widget.showInactive();
  startFollowingCursor();
  setState('arming', { step: 0, steps: STEP_LABELS, message: STEP_LABELS[0] });

  const step = (i, message) =>
    sendWidget({ step: i, steps: STEP_LABELS, message: message || STEP_LABELS[i] });

  // Do not reuse transport positions from a previous take.
  recordingStartPosition = null;
  recordingEndPosition = null;
  // remember what the user was doing so we can hand focus back at READY
  const prevApp = await reason.frontmostApp().catch(() => null);

  try {
    Object.assign(cfg, config.load()); // pick up config edits without replacing Reason's shared config object
    // 0. internet check — login needs it (skippable if Reason already runs)
    const online = await hasInternet();
    if (!online) {
      if (!(await reason.isRunning())) {
        throw new Error('No internet connection — Reason needs it to log in. Connect Wi-Fi and retry.');
      }
      warnings.push('Offline — continuing since Reason is already running');
    }

    // 1. launch in background — user keeps working
    step(1);
    await reason.launch();

    // 2. login (auto-submitted if possible)
    step(2);
    await reason.waitThroughLogin(() => {
      setState('waiting-login', {
        step: 2,
        steps: STEP_LABELS,
        message: 'Log in to Reason — I\u2019ll wait…',
      });
    });
    if (state === 'waiting-login') setState('arming', { step: 2, steps: STEP_LABELS });

    // 3. open project in background (11GB file — can take a while)
    step(3);
    await reason.openProject((p) =>
      step(3, p === 'login' ? 'Log in detected — auto-submitting…' : `Opening rippa-record… ${p}s`)
    );

    // 4. Set physical-device levels before selecting the fixed-level aggregate.
    step(4);
    savedAudio = {
      device: await audio.getCurrentOutput().catch(() => null),
      volume: await audio.getSystemVolume().catch(() => null),
    };
    try {
      await audio.prepareDeviceVolumes(cfg.audio);

      // 5. select the configured system output (no focus needed)
      step(5);
      await audio.setOutput(cfg.audio.systemOutputDevice);
    } catch (e) {
      if (savedAudio.device) await audio.setOutput(savedAudio.device).catch(() => {});
      if (Number.isFinite(savedAudio.volume)) {
        await audio.setDeviceVolume(savedAudio.device, savedAudio.volume).catch(() => {});
      }
      throw e;
    }

    // 6. select the configured Reason audio input before arming
    step(6);
    try {
      await reason.setAudioDevice();
    } catch (e) {
      warnings.push(`Audio device: ${firstLine(e)} — set it manually if needed`);
      console.warn(e.message);
    }

    // 7. select Track 1 and capture the exact transport position before record.
    step(7);
    recordingStartPosition = await reason.goToTrack1End();
    recordingEndPosition = null;
    if (!recordingStartPosition || !Number.isInteger(recordingStartPosition.bar) ||
        !Number.isInteger(recordingStartPosition.beat) || !Number.isInteger(recordingStartPosition.subdivision) ||
        !Number.isInteger(recordingStartPosition.tick)) {
      throw new Error('Could not read Reason’s full start position; no recording was started.');
    }
    diagnostic('Take start position:', recordingStartPosition);

    step(8);
    await media.pauseEverything(cfg.recording?.sourceApp || '');

    step(9);
    await reason.startRecord();

    // hand focus back to whatever the user was doing
    await reason.focusApp(prevApp);

    trackLog.tracks.length = 0;
    trackLog.start(cfg.nowPlayingPollMs);
    watchForPlayback();
    setState('ready', {
      steps: STEP_LABELS,
      step: STEP_LABELS.length,
      message: 'READY — hit Play on your stream',
      warnings,
    });
    notify('Rippa is recording', 'Hit Play on your music — the widget will dock once playback starts.');
  } catch (e) {
    console.error(e);
    trackLog.stop();
    await reason.focusApp(prevApp);
    setState('error', {
      message: firstLine(e),
      recommendation: 'Fix the issue above (or just retry — most arming steps are self-healing).',
      actions: [
        { id: 'retry-arming', label: 'Retry' },
        { id: 'open-reason', label: 'Open Reason' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
      warnings,
    });
    notify('Rippa failed', firstLine(e));
  }
}

function firstLine(e) {
  return String(e.message || e).split('\n')[0];
}

// ----------------------------------------------------- playback detection

function watchForPlayback() {
  stopPlaybackWatch();
  // arming pauses every player first, so any playback seen during READY is
  // the user's cue — no transition guard needed (it deadlocked when the user
  // hit Play before the first poll)
  playbackWatch = setInterval(async () => {
    if (state !== 'ready') return stopPlaybackWatch();
    const info = await media.getNowPlaying();
    if (info && info.playing) {
      stopPlaybackWatch();
      onPlaybackStarted();
    }
  }, 1000);
}

function stopPlaybackWatch() {
  if (playbackWatch) clearInterval(playbackWatch);
  playbackWatch = null;
}

async function onPlaybackStarted() {
  if (state !== 'ready') return;
  setState('recording');
  await dockWidgetToCorner();
}

// --------------------------------------------------------- pause/resume

async function togglePauseResume() {
  if (state === 'recording') {
    setState('paused');
    await Promise.all([media.mediaPause(), reason.stopTransport()]);
    trackLog.stop();
  } else if (state === 'paused') {
    setState('recording');
    await Promise.all([media.mediaPlay(), reason.resumeRecord()]);
    trackLog.start(cfg.nowPlayingPollMs);
  } else if (state === 'ready') {
    // let the shortcut double as "start playback"
    await media.mediaPlay();
  }
}

// --------------------------------------------------------- stop & finish

let pendingFinishName = null;

async function stopAndFinish() {
  if (state !== 'recording' && state !== 'paused') return;
  const wasRecording = state === 'recording';
  setState('finishing', { message: 'Stopping…' });
  trackLog.stop();
  stopPlaybackWatch();

  // stop both absolutely together
  await Promise.all([media.mediaPause(), wasRecording ? reason.stopTransport() : Promise.resolve()]);

  indicator.hide();
  widget.showInactive();
  const p = indicatorTarget();
  widget.setPosition(p.x - (WIDGET_SIZE.w - INDICATOR_SIZE.w), p.y - (WIDGET_SIZE.h - INDICATOR_SIZE.h));
  sendWidget({ message: 'Naming session…' });

  // name it (ollama, with fallbacks)
  const name = await generateSessionName(cfg.ollama, trackLog.tracks);
  lastSessionName = name;

  // Capture the stopped playhead at full musical resolution. Do not export if
  // either boundary is missing or Reason cannot confirm exact L/R entry.
  sendWidget({ message: 'Setting exact loop bounds…' });
  await reason.activate();
  recordingEndPosition = await reason.currentPosition();
  diagnostic('Take stop position:', recordingEndPosition);
  const loop = await reason.loopAroundRecording(recordingStartPosition, recordingEndPosition);
  if (!loop.ok) {
    diagnostic('Exact locator setup failed:', loop.error);
    pendingFinishName = name;
    setState('error', {
      message: 'Couldn\u2019t loop the recorded session',
      recommendation: 'Confirm the take’s start/end bars in Reason, then retry only when L/R matches the segment.',
      actions: [
        { id: 'retry-loop', label: 'Retry loop + export' },
        { id: 'export-current', label: 'Export current loop' },
        { id: 'open-reason', label: 'Open Reason' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    });
    notify('Rippa: loop failed', 'Confirm the L/R bars in Reason before retrying.');
    return;
  }
  await exportAndWrapUp(name);
}

async function exportAndWrapUp(name) {
  sendWidget({ message: `Exporting “${name}”… (Reason pre-calculates, takes a few min)` });
  try {
    const exported = await reason.exportLoop(name);
    diagnostic('Export verified:', exported);
    if (cfg.audio.restoreAudioAfterFinish && savedAudio) {
      if (savedAudio.device) await audio.setOutput(savedAudio.device).catch(() => {});
      if (Number.isFinite(savedAudio.volume) && savedAudio.device) {
        await audio.setDeviceVolume(savedAudio.device, savedAudio.volume).catch(() => {});
      }
    }
    pendingFinishName = null;
    const duration = Number.isFinite(exported?.durationSeconds)
      ? ` (${Math.round(exported.durationSeconds)}s)`
      : '';
    setState('done', { message: `Done ✓ ${name}${duration}` });
    notify('Rippa export complete', `${name}${duration}`);
    setTimeout(() => {
      if (state === 'done') resetToIdle();
    }, 6000);
  } catch (e) {
    diagnostic('Export failed:', e?.stack || e?.message || e);
    pendingFinishName = name;
    setState('error', {
      message: `Export snag: ${firstLine(e)}`,
      recommendation: 'Rippa waits for a verified Save panel and generated name. If the panel remains open, check Save As before retrying; no file is saved until the name is confirmed.',
      actions: [
        { id: 'retry-export', label: 'Retry export' },
        { id: 'open-reason', label: 'Open Reason' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    });
    notify('Rippa export failed', firstLine(e));
  }
}

/** Retry after a failed loop/export. withLoop=true re-enters the saved L/R bars. */
async function retryFinish(withLoop) {
  if (!pendingFinishName) return;
  widget.showInactive();
  setState('finishing', { message: withLoop ? 'Looping recorded session…' : 'Exporting with current loop…' });
  await reason.activate();
  if (withLoop) {
    const loop = await reason.loopAroundRecording(recordingStartPosition, recordingEndPosition);
    if (!loop.ok) {
      setState('error', {
        message: 'Loop failed again',
        recommendation: 'Check the take’s start/end bars in Reason before retrying or exporting the current loop.',
        actions: [
          { id: 'export-current', label: 'Export current loop' },
          { id: 'open-reason', label: 'Open Reason' },
          { id: 'dismiss', label: 'Dismiss' },
        ],
      });
      return;
    }
  }
  await exportAndWrapUp(pendingFinishName);
}

function resetToIdle() {
  stopFollowingCursor();
  stopPlaybackWatch();
  trackLog.stop();
  pendingFinishName = null;
  recordingStartPosition = null;
  recordingEndPosition = null;
  if (widget && !widget.isDestroyed()) widget.hide();
  if (indicator && !indicator.isDestroyed()) indicator.hide();
  setState('idle');
}

// ----------------------------------------------------------------- tray

function trayMenu() {
  const busy = !['idle', 'done', 'error'].includes(state);
  return Menu.buildFromTemplate([
    { label: `Rippa — ${state}`, enabled: false },
    { type: 'separator' },
    { label: 'Start Recording', enabled: !busy, click: enableRippaMode },
    {
      label: state === 'paused' ? 'Resume recording + playback' : 'Pause recording + playback',
      accelerator: cfg.shortcuts.pauseResume,
      enabled: state === 'recording' || state === 'paused',
      click: togglePauseResume,
    },
    {
      label: 'Stop & Finish (loop + export)',
      accelerator: cfg.shortcuts.stopFinish,
      enabled: state === 'recording' || state === 'paused',
      click: stopAndFinish,
    },
    { type: 'separator' },
    {
      label: 'Playback started (manual override)',
      enabled: state === 'ready',
      click: onPlaybackStarted,
    },
    {
      label: 'Retry finish (loop recorded clip + export)',
      enabled: !!pendingFinishName,
      click: () => retryFinish(true),
    },
    {
      label: 'Export with current loop',
      enabled: !!pendingFinishName,
      click: () => retryFinish(false),
    },
    { label: 'Abort / reset', enabled: busy || !!pendingFinishName, click: resetToIdle },
    { type: 'separator' },
    { label: 'Preferences & device setup…', click: openSetupWindow },
    { label: 'Open config.json', click: () => shell.openPath(config.CONFIG_PATH) },
    { label: 'Quit Rippa', role: 'quit' },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const active = !['idle', 'done', 'error'].includes(state);
  tray.setImage(makeTrayIcon(active));
  tray.setTitle('');
  tray.setToolTip(`Rippa — ${state}`);
  tray.setContextMenu(trayMenu());
}

// A single antialiased 18px circle: a red disc while Rippa mode is active,
// or a system-adaptive outline while idle and ready to be selected.
function makeTrayIcon(active = false) {
  const size = 18;
  const samples = 4;
  const center = (size - 1) / 2;
  const radius = 5.5;
  const ringWidth = 1.65;
  const buf = Buffer.alloc(size * size * 4, 0);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + (sx + 0.5) / samples - center;
          const dy = y + (sy + 0.5) / samples - center;
          const distance = Math.hypot(dx, dy);
          if (active ? distance <= radius : Math.abs(distance - radius) <= ringWidth / 2) {
            covered++;
          }
        }
      }
      if (!covered) continue;
      const i = (y * size + x) * 4;
      const alpha = Math.round(covered / (samples * samples) * 255);
      buf[i] = 255;
      buf[i + 1] = active ? 59 : 255;
      buf[i + 2] = active ? 48 : 255;
      buf[i + 3] = alpha;
    }
  }

  const img = nativeImage.createFromBitmap(buf, { width: size, height: size });
  img.setTemplateImage(!active);
  return img;
}


if (primaryInstance) app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();

  await Promise.all([createWidget(), createIndicator()]);

  tray = new Tray(makeTrayIcon());
  tray.setToolTip('Rippa');
  refreshTray();
  tray.on('click', () => tray.popUpContextMenu());

  ipcMain.handle('rippa:setup-data', async () => {
    const [inputs, outputs] = await Promise.all([
      audio.listDevices('input').catch(() => []),
      audio.listDevices('output').catch(() => []),
    ]);
    return {
      reason: { ...cfg.reason },
      audio: { ...cfg.audio },
      recording: { ...(cfg.recording || {}) },
      devices: { inputs, outputs },
    };
  });
  ipcMain.handle('rippa:pick-path', async (_event, kind) => {
    const project = kind === 'project';
    const result = await dialog.showOpenDialog(setupWindow, {
      title: project ? 'Choose a Reason project' : 'Choose the Reason application',
      properties: ['openFile'],
      ...(project ? { filters: [{ name: 'Reason projects', extensions: ['reason'] }] }
        : { filters: [{ name: 'macOS applications', extensions: ['app'] }] }),
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('rippa:save-settings', async (_event, settings) => {
    if (!['idle', 'done', 'error'].includes(state)) {
      throw new Error('Stop the active recording before changing setup preferences.');
    }
    const saved = config.saveSettings(settings);
    Object.assign(cfg, saved);
    refreshTray();
    if (setupWindow && !setupWindow.isDestroyed()) setupWindow.close();
    return { saved: true };
  });

  globalShortcut.register(cfg.shortcuts.pauseResume, togglePauseResume);
  globalShortcut.register(cfg.shortcuts.stopFinish, stopAndFinish);

  ipcMain.on('indicator-action', (_e, action) => {
    if (action === 'toggle') togglePauseResume();
    if (action === 'stop') stopAndFinish();
  });
  ipcMain.on('widget-action', (_e, id) => {
    const handlers = {
      'retry-arming': () => enableRippaMode(),
      'retry-loop': () => retryFinish(true),
      'retry-export': () => retryFinish(false),
      'export-current': () => retryFinish(false),
      'open-reason': () => reason.activate().catch(() => {}),
      'open-accessibility': () => shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      ),
      dismiss: () => resetToIdle(),
    };
    if (handlers[id]) handlers[id]();
  });
  ipcMain.on('indicator-hover', (_e, hovering) => {
    // indicator stays clickable; nothing to do, hook kept for future use
  });

  console.log('Rippa ready (tray dot icon). Shortcuts:', cfg.shortcuts);
  app.on('second-instance', () => tray.popUpContextMenu());
  if (cfg.setupComplete === false) openSetupWindow();
}).catch((error) => {
  console.error('Rippa startup failed:', error);
  dialog.showErrorBox('Rippa could not start', firstLine(error));
  app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
