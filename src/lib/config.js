'use strict';
const path = require('path');
const fs = require('fs');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const TEMPLATE_CONFIG_PATH = path.join(__dirname, '..', '..', 'config.example.json');
let configPath = DEFAULT_CONFIG_PATH;

function ensureProjectConfig() {
  if (fs.existsSync(DEFAULT_CONFIG_PATH)) return;
  const defaults = JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf8'));
  fs.writeFileSync(DEFAULT_CONFIG_PATH, `${JSON.stringify(defaults, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function initialize(directory) {
  const target = path.join(directory, 'config.json');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(target)) {
    const defaults = JSON.parse(fs.readFileSync(TEMPLATE_CONFIG_PATH, 'utf8'));
    const firstRun = {
      ...defaults,
      reason: {
        ...defaults.reason,
        appPath: '',
        projectPath: '',
        projectWindowMatch: '',
        audioDevice: '',
        trackName: defaults.reason.trackName || 'Audio Track 1',
      },
      audio: {
        ...defaults.audio,
        systemOutputDevice: '',
        speakerDevice: '',
        monitorDevice: '',
        muteSpeakersFirst: false,
        restoreAudioAfterFinish: true,
      },
      recording: { ...(defaults.recording || {}), sourceApp: '' },
      setupComplete: false,
    };
    fs.writeFileSync(target, `${JSON.stringify(firstRun, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  configPath = target;
}

function load() {
  if (configPath === DEFAULT_CONFIG_PATH) ensureProjectConfig();
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function saveSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Setup preferences must be an object.');
  }
  const current = load();
  const next = {
    ...current,
    reason: { ...current.reason },
    audio: { ...current.audio },
    recording: { ...(current.recording || {}) },
  };
  const copyString = (section, key, label, required = true) => {
    if (!(key in (input[section] || {}))) return;
    const value = String(input[section][key] ?? '').trim();
    if (required && !value) throw new Error(`${label} is required.`);
    next[section][key] = value;
  };
  for (const [key, label] of Object.entries({
    appPath: 'Reason application', processName: 'Reason process name',
    projectPath: 'Reason project', projectWindowMatch: 'Project window name',
    audioDevice: 'Recording input', trackName: 'Reason recording track',
  })) copyString('reason', key, label);
  copyString('audio', 'systemOutputDevice', 'System output');
  for (const [key, label] of Object.entries({
    speakerDevice: 'Speaker output', monitorDevice: 'Monitor output',
  })) copyString('audio', key, label, false);
  copyString('recording', 'sourceApp', 'Playback app', false);
  if ('monitorVolumePercent' in (input.audio || {})) {
    const value = Number(input.audio.monitorVolumePercent);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      throw new Error('Monitor volume must be between 0 and 100%.');
    }
    next.audio.monitorVolumePercent = Math.round(value);
  }
  for (const key of ['muteSpeakersFirst', 'restoreAudioAfterFinish']) {
    if (key in (input.audio || {})) next.audio[key] = Boolean(input.audio[key]);
  }
  next.setupComplete = true;
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  return next;
}

module.exports = {
  load,
  initialize,
  saveSettings,
  get CONFIG_PATH() { return configPath; },
};
