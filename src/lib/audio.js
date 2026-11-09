'use strict';
const { execFile } = require('child_process');
const { runAppleScript } = require('./applescript');

function findBin(name) {
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];
  const fs = require('fs');
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return name; // hope it's on PATH
}

const SWITCH_AUDIO = findBin('SwitchAudioSource');

function switchAudio(args) {
  return new Promise((resolve, reject) => {
    execFile(SWITCH_AUDIO, args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`SwitchAudioSource ${args.join(' ')} failed: ${stderr || err.message}`));
      resolve(String(stdout).trim());
    });
  });
}

function parseDeviceList(output) {
  return [...new Set(String(output || '').split(/\r?\n/)
    .map((line) => line.trim().replace(/^\*\s*/, ''))
    .filter((line) => line && !/^available audio devices:?$/i.test(line)))];
}

async function listDevices(type = 'output') {
  if (!['input', 'output'].includes(type)) throw new Error('Audio device type must be input or output.');
  return parseDeviceList(await switchAudio(['-a', '-t', type]));
}

async function getCurrentOutput() {
  return switchAudio(['-c', '-t', 'output']);
}

async function setOutput(deviceName) {
  return switchAudio(['-s', deviceName, '-t', 'output']);
}

async function getSystemVolume() {
  const out = await runAppleScript('output volume of (get volume settings)');
  const volume = parseInt(out, 10);
  return Number.isFinite(volume) ? volume : null;
}

async function setSystemVolume(v) {
  return runAppleScript(`set volume output volume ${Math.max(0, Math.min(100, v))}`);
}

async function setNativeDeviceVolume(deviceName, percent) {
  const fs = require('fs');
  const path = require('path');
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'set-device-volume.swift'));
  candidates.push(path.join(__dirname, 'set-device-volume.swift'));
  const script = candidates.find((candidate) => fs.existsSync(candidate));
  if (!script) throw new Error('Rippa’s CoreAudio volume helper is missing.');

  return new Promise((resolve, reject) => {
    execFile('/usr/bin/swift', [script, deviceName, String(percent)], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`CoreAudio volume update failed for ${deviceName}: ${stderr || err.message}`));
      try {
        const result = JSON.parse(String(stdout).trim());
        resolve(Number(result.actualPercent));
      } catch {
        reject(new Error(`CoreAudio volume read-back was invalid for ${deviceName}.`));
      }
    });
  });
}

/** Select a physical output before changing its native CoreAudio volume. */
async function setDeviceVolume(deviceName, volume, ops = module.exports) {
  const name = String(deviceName || '').trim();
  const numericVolume = Number(volume);
  if (!name) throw new Error('No audio device configured for volume adjustment.');
  if (!Number.isFinite(numericVolume)) throw new Error(`Invalid output volume for ${name}.`);
  const target = Math.max(0, Math.min(100, Math.round(numericVolume)));

  await ops.setOutput(name);
  const selected = String(await ops.getCurrentOutput()).trim();
  if (selected !== name) {
    throw new Error(`Could not select ${name}; current output is ${selected || 'unknown'}.`);
  }
  const actual = await ops.setNativeDeviceVolume(name, target);
  if (!Number.isFinite(actual) || Math.abs(actual - target) > 2) {
    throw new Error(`Could not set ${name} to ${target}% (read back ${actual ?? 'unavailable'}%).`);
  }
  return Math.round(actual);
}

/** Set physical-device levels before the fixed-level aggregate is selected. */
async function prepareDeviceVolumes(settings, ops = module.exports) {
  const speakerDevice = String(settings.speakerDevice || '').trim();
  const monitorDevice = String(settings.monitorDevice || '').trim();
  const monitorVolume = settings.monitorVolumePercent ?? 40;

  if (settings.muteSpeakersFirst !== false && speakerDevice) {
    await ops.setDeviceVolume(speakerDevice, 0);
  }
  if (monitorDevice) await ops.setDeviceVolume(monitorDevice, monitorVolume);
}

module.exports = {
  parseDeviceList,
  listDevices,
  getCurrentOutput,
  setOutput,
  getSystemVolume,
  setSystemVolume,
  setNativeDeviceVolume,
  setDeviceVolume,
  prepareDeviceVolumes,
  findBin,
};
