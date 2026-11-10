'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');

function fixture({ packaged = false, primary = true, trusted = true, load, spyLaunch = true, setupComplete = true } = {}) {
  const app = new EventEmitter();
  app.isPackaged = packaged;
  app.requestSingleInstanceLock = () => primary;
  app.whenReady = () => Promise.resolve();
  app.getPath = () => '/test/user-data';
  app.getVersion = () => '0.1.4';
  app.dock = { hide() {} };
  app.quitCount = 0;
  app.quit = () => { app.quitCount++; };
  const timers = [];
  const windows = [];
  const errors = [];
  const configDirectories = [];
  const permissionChecks = [];
  const config = {
    initialize: (directory) => configDirectories.push(directory),
    load: () => ({ ...structuredClone(require('../config.json')), setupComplete }),
  };
  class Window {
    constructor() {
      windows.push(this);
      this.messages = [];
      this.webContents = { send: (_channel, data) => this.messages.push(data) };
    }
    loadFile() { return load ? load() : Promise.resolve(); }
    once() { return this; }
    on() { return this; }
    show() {}
    focus() {}
    close() {}
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    setPosition() {}
    showInactive() {}
    hide() {}
  }
  class Tray {
    constructor(image) { this.image = image; this.title = ''; }
    setImage(image) { this.image = image; }
    setTitle(title) { this.title = title; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu() {}
    popUpContextMenu() {}
    on() {}
  }
  class Reason {
    async exportLoop() {}
  }
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const electron = {
    app,
    BrowserWindow: Window,
    Tray,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: {
      createFromBitmap: (buffer, options) => ({
        buffer, options, template: false,
        setTemplateImage(value) { this.template = value; },
      }),
    },
    systemPreferences: {
      isTrustedAccessibilityClient: (prompt) => {
        permissionChecks.push(prompt);
        return trusted;
      },
    },
    globalShortcut: { register() {}, unregisterAll() {} },
    ipcMain,
    Notification: class { show() {} },
    dialog: { showErrorBox: (...args) => errors.push(args), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  };
  const modules = {
    electron,
    path,
    fs: { mkdirSync() {}, appendFileSync() {} },
    './lib/config': config,
    './lib/reason': { Reason },
    './lib/audio': {},
    './lib/media': { TrackLog: class { stop() {} } },
    './lib/namer': {},
    './lib/applescript': {},
  };
  const context = vm.createContext({
    require: (id) => {
      assert.ok(Object.hasOwn(modules, id), `Unexpected module: ${id}`);
      return modules[id];
    },
    __dirname: path.join(__dirname, '../src'),
    Buffer,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    clearInterval() {},
    starts: 0,
  });
  const run = (code) => vm.runInContext(code, context);
  run(source);
  if (spyLaunch) run('enableRippaMode = async () => { starts++; state = "arming"; };');
  return {
    app, timers, windows, errors, configDirectories, permissionChecks, config, run,
    settled: () => new Promise(setImmediate),
  };
}

test('development stays in idle tray mode', async () => {
  const f = fixture();
  await f.settled();
  assert.equal(f.run('starts'), 0);
  assert.equal(f.run('state'), 'idle');
  assert.deepEqual(f.configDirectories, []);
});

test('a new settings profile opens the setup wizard without starting a recording', async () => {
  const f = fixture({ setupComplete: false });
  await f.settled();
  assert.equal(f.run('starts'), 0);
  assert.equal(f.run('setupWindow !== null'), true);
  assert.equal(f.windows.length, 3);
  assert.ok(f.run('trayMenu().some((item) => item.label === "Preferences & device setup…")'));
});

test('tray menu and tooltip display the installed app version', async () => {
  const f = fixture({ packaged: true });
  await f.settled();
  assert.equal(f.run('trayMenu()[0].label'), 'Rippa Record v0.1.4 — idle');
  assert.equal(f.run('tray.tooltip'), 'Rippa Record v0.1.4 — idle');
});

test('tray has one hollow idle circle and one solid red active circle', async () => {
  const f = fixture();
  await f.settled();
  assert.equal(f.run('tray.title'), '');
  assert.equal(f.run('tray.image.template'), true);
  assert.equal(f.run('tray.image.options.width'), 18);
  assert.equal(f.run('tray.image.buffer[(9 * 18 + 9) * 4 + 3]'), 0);

  f.run('setState("arming")');
  assert.equal(f.run('tray.title'), '');
  assert.equal(f.run('tray.image.template'), false);
  assert.equal(f.run('tray.image.buffer[(9 * 18 + 9) * 4]'), 255);
  assert.equal(f.run('tray.image.buffer[(9 * 18 + 9) * 4 + 1]'), 59);
  assert.equal(f.run('tray.image.buffer[(9 * 18 + 9) * 4 + 2]'), 48);
  assert.equal(f.run('tray.image.buffer[(9 * 18 + 9) * 4 + 3]'), 255);
});

test('installed app loads the original menu and starts only when Start Recording is selected', async () => {
  let resolveLoad;
  const loaded = new Promise((resolve) => { resolveLoad = resolve; });
  const f = fixture({ packaged: true, load: () => loaded });
  await f.settled();
  assert.equal(f.run('starts'), 0);
  resolveLoad();
  await f.settled();
  assert.equal(f.run('starts'), 0);
  assert.equal(f.run('state'), 'idle');
  assert.deepEqual(f.permissionChecks, []);
  assert.deepEqual(f.configDirectories, ['/test/user-data']);
  f.app.emit('activate');
  f.app.emit('second-instance');
  assert.equal(f.run('starts'), 0);
  await f.run('trayMenu().find((item) => item.label === "Start Recording").click()');
  assert.equal(f.run('starts'), 1);
  assert.equal(f.run('trayMenu().find((item) => item.label === "Start Recording").enabled'), false);
});

test('a second process exits without creating windows or starting recording', async () => {
  const f = fixture({ packaged: true, primary: false });
  await f.settled();
  assert.equal(f.app.quitCount, 1);
  assert.equal(f.windows.length, 0);
  assert.equal(f.run('starts'), 0);
});

test('successful installed export returns to idle and keeps the original menu available', async () => {
  const f = fixture({ packaged: true });
  await f.settled();
  await f.run('exportAndWrapUp("Session")');
  assert.equal(f.run('state'), 'done');
  assert.equal(f.app.quitCount, 0);
  assert.equal(f.timers[0].delay, 6000);
  f.timers[0].callback();
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.app.quitCount, 0);
  assert.equal(f.run('trayMenu().find((item) => item.label === "Start Recording").enabled'), true);
});

test('successful development export returns to idle instead of quitting', async () => {
  const f = fixture();
  await f.settled();
  await f.run('exportAndWrapUp("Session")');
  f.timers[0].callback();
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.app.quitCount, 0);
});

test('an earlier completion timer cannot reset an active recording', async () => {
  const f = fixture({ packaged: true });
  await f.settled();
  await f.run('exportAndWrapUp("Session")');
  f.run('state = "recording"');
  f.timers[0].callback();
  assert.equal(f.run('state'), 'recording');
  assert.equal(f.app.quitCount, 0);
});

test('failed export stays open with retry actions and never schedules a quit', async () => {
  const f = fixture({ packaged: true });
  await f.settled();
  f.run('reason.exportLoop = async () => { throw new Error("Export failed"); }');
  await f.run('exportAndWrapUp("Session")');
  assert.equal(f.run('state'), 'error');
  assert.equal(f.timers.length, 0);
  assert.equal(f.app.quitCount, 0);
  assert.ok(f.windows[0].messages.at(-1).actions.some((action) => action.id === 'retry-export'));
});

test('Accessibility is requested only after Start Recording, before any Reason automation', async () => {
  const f = fixture({ packaged: true, trusted: false, spyLaunch: false });
  await f.settled();
  assert.equal(f.run('state'), 'idle');
  assert.deepEqual(f.permissionChecks, []);
  await f.run('trayMenu().find((item) => item.label === "Start Recording").click()');
  assert.equal(f.run('state'), 'error');
  assert.equal(f.app.quitCount, 0);
  assert.equal(f.windows[0].messages.at(-1).message, 'Allow Rippa Record in Accessibility');
  assert.deepEqual(f.permissionChecks, [true]);
  assert.ok(f.windows[0].messages.at(-1).actions.some((action) => action.id === 'open-accessibility'));
  f.run('resetToIdle()');
  assert.equal(f.run('state'), 'idle');
  assert.equal(f.app.quitCount, 0);
});

test('window loading errors are shown and the app exits', async () => {
  const f = fixture({ packaged: true, load: () => Promise.reject(new Error('Missing UI')) });
  await f.settled();
  assert.equal(f.app.quitCount, 1);
  assert.deepEqual(f.errors, [['Rippa could not start', 'Missing UI']]);
  assert.equal(f.run('starts'), 0);
});
