'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rippa-config-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  delete require.cache[require.resolve('../src/lib/config')];
  return { directory, config: require('../src/lib/config') };
}

test('development and probes continue to use the project config', (t) => {
  const { config } = fixture(t);
  assert.equal(config.CONFIG_PATH, path.join(__dirname, '..', 'config.json'));
  assert.deepEqual(config.load(), JSON.parse(fs.readFileSync(config.CONFIG_PATH, 'utf8')));
});

test('installed app copies defaults to a writable user directory and preserves edits', (t) => {
  const { directory, config } = fixture(t);
  config.initialize(path.join(directory, 'settings'));
  const firstRun = config.load();
  assert.equal(firstRun.setupComplete, false);
  assert.equal(firstRun.reason.appPath, '');
  assert.equal(firstRun.reason.projectPath, '');
  assert.equal(firstRun.reason.audioDevice, '');
  assert.equal(firstRun.audio.systemOutputDevice, '');
  assert.equal(firstRun.recording.sourceApp, '');
  assert.deepEqual(firstRun.delays, require('../config.example.json').delays);
  assert.deepEqual(firstRun.reason.clickPoints, require('../config.example.json').reason.clickPoints);
  const edited = { ...firstRun, nowPlayingPollMs: 5000 };
  fs.writeFileSync(config.CONFIG_PATH, JSON.stringify(edited));
  config.initialize(path.join(directory, 'settings'));
  assert.deepEqual(config.load(), edited);
});

test('device setup saves actual preferences without discarding unrelated settings', (t) => {
  const { directory, config } = fixture(t);
  config.initialize(path.join(directory, 'settings'));
  const original = config.load();
  const saved = config.saveSettings({
    reason: {
      appPath: '/Applications/Reason.app',
      processName: 'Reason',
      projectPath: '/tmp/rippa-fixture/Music/Session.reason',
      projectWindowMatch: 'Session',
      audioDevice: 'Virtual Loopback Input',
      trackName: 'Vocal Capture',
    },
    audio: {
      systemOutputDevice: 'Virtual Output',
      speakerDevice: 'Built-in Speakers',
      monitorDevice: 'Headphones',
      monitorVolumePercent: 35,
      muteSpeakersFirst: false,
      restoreAudioAfterFinish: true,
    },
    recording: { sourceApp: 'Spotify' },
  });
  assert.equal(saved.reason.trackName, 'Vocal Capture');
  assert.equal(saved.reason.audioDevice, 'Virtual Loopback Input');
  assert.equal(saved.audio.systemOutputDevice, 'Virtual Output');
  assert.equal(saved.recording.sourceApp, 'Spotify');
  assert.equal(saved.setupComplete, true);
  assert.deepEqual(saved.delays, original.delays);
  assert.deepEqual(config.load(), saved);
});

test('setup rejects invalid monitor levels without writing them', (t) => {
  const { directory, config } = fixture(t);
  config.initialize(path.join(directory, 'settings'));
  const before = config.load();
  assert.throws(() => config.saveSettings({ audio: { monitorVolumePercent: 101 } }), /between 0 and 100/);
  assert.deepEqual(config.load(), before);
});

test('invalid saved config is reported instead of replaced with defaults', (t) => {
  const { directory, config } = fixture(t);
  fs.writeFileSync(path.join(directory, 'config.json'), '{invalid');
  config.initialize(directory);
  assert.throws(() => config.load(), SyntaxError);
});
