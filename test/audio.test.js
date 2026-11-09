'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseDeviceList, setDeviceVolume, prepareDeviceVolumes } = require('../src/lib/audio');

test('parses unique audio device names from SwitchAudioSource output', () => {
  assert.deepEqual(parseDeviceList('* Built-in Audio\nVirtual Loopback\nBuilt-in Audio\n'), [
    'Built-in Audio', 'Virtual Loopback',
  ]);
});

test('sets and verifies a device volume only after selecting that output', async () => {
  const calls = [];
  const ops = {
    async setOutput(name) { calls.push(['select', name]); },
    async getCurrentOutput() { calls.push(['read-output']); return 'Studio Monitor'; },
    async setNativeDeviceVolume(device, value) { calls.push(['set-device-volume', device, value]); return 40; },
  };

  assert.equal(await setDeviceVolume('Studio Monitor', 40, ops), 40);
  assert.deepEqual(calls, [
    ['select', 'Studio Monitor'],
    ['read-output'],
    ['set-device-volume', 'Studio Monitor', 40],
  ]);
});

test('does not change volume when the requested output did not become selected', async () => {
  const calls = [];
  const ops = {
    async setOutput(name) { calls.push(['select', name]); },
    async getCurrentOutput() { calls.push(['read-output']); return 'Aggregate Output'; },
    async setNativeDeviceVolume(device, value) { calls.push(['set-device-volume', device, value]); return 40; },
  };

  await assert.rejects(setDeviceVolume('Studio Monitor', 40, ops), /current output is Aggregate Output/);
  assert.deepEqual(calls, [['select', 'Studio Monitor'], ['read-output']]);
});

test('does not assume another user’s speaker or monitor names when no devices were selected', async () => {
  const calls = [];
  await prepareDeviceVolumes({
    speakerDevice: '', monitorDevice: '', muteSpeakersFirst: false,
  }, { async setDeviceVolume(...args) { calls.push(args); } });
  assert.deepEqual(calls, []);
});

test('sets a configured speaker and monitor before selecting the aggregate output', async () => {
  const calls = [];
  const ops = {
    async setDeviceVolume(device, volume) { calls.push(['device-volume', device, volume]); },
  };

  await prepareDeviceVolumes({
    speakerDevice: 'Built-in Speakers',
    monitorDevice: 'Studio Monitor',
    monitorVolumePercent: 40,
    muteSpeakersFirst: true,
  }, ops);
  calls.push(['select-aggregate', 'Aggregate Output']);

  assert.deepEqual(calls, [
    ['device-volume', 'Built-in Speakers', 0],
    ['device-volume', 'Studio Monitor', 40],
    ['select-aggregate', 'Aggregate Output'],
  ]);
});
