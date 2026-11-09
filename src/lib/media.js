'use strict';
const { execFile } = require('child_process');
const { findBin } = require('./audio');
const { runAppleScript } = require('./applescript');

const NOWPLAYING = findBin('nowplaying-cli');

function np(args) {
  return new Promise((resolve, reject) => {
    execFile(NOWPLAYING, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`nowplaying-cli ${args.join(' ')} failed: ${stderr || err.message}`));
      resolve(String(stdout).trim());
    });
  });
}

/** Returns { title, artist, album, playing } or null on failure. */
async function getNowPlaying() {
  try {
    const out = await np(['get', 'title', 'artist', 'album', 'playbackRate']);
    const [title, artist, album, rate] = out.split('\n').map((s) => (s === 'null' ? null : s));
    return { title, artist, album, playing: parseFloat(rate || '0') > 0 };
  } catch {
    return null;
  }
}

function asQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function mediaPlay(appName) {
  try { await np(['play']); } catch { /* best effort */ }
  if (appName) await runAppleScript(`tell application ${asQuote(appName)} to play`).catch(() => {});
}

async function mediaPause(appName) {
  try { await np(['pause']); } catch { /* best effort */ }
  if (appName) await runAppleScript(`tell application ${asQuote(appName)} to pause`).catch(() => {});
}

/**
 * Tracks what plays during a session for later naming.
 */
class TrackLog {
  constructor() {
    this.tracks = [];
    this._seen = new Set();
    this._timer = null;
  }

  start(pollMs = 2500) {
    this.stop();
    this._timer = setInterval(async () => {
      const info = await getNowPlaying();
      if (info && info.playing && info.title) {
        const key = `${info.title}::${info.artist || ''}`;
        if (!this._seen.has(key)) {
          this._seen.add(key);
          this.tracks.push({ title: info.title, artist: info.artist, album: info.album, at: new Date().toISOString() });
        }
      }
    }, pollMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

/**
 * Pause everything that could be making noise: the system Now Playing session
 * plus any running known players (VLC, Music, Spotify, QuickTime, TV).
 * Only talks to apps that are actually running, so nothing gets launched.
 */
async function pauseEverything(targetApp = '') {
  await mediaPause(targetApp);
  let procs = '';
  try {
    procs = await runAppleScript('tell application "System Events" to get name of processes');
  } catch { /* no accessibility — fall back to system session only */ }
  const running = new Set(procs.split(', '));
  const players = [
    ['VLC', 'tell application "VLC" to if playing then play'], // VLC "play" toggles pause
    ['Music', 'tell application "Music" to pause'],
    ['Spotify', 'tell application "Spotify" to pause'],
    ['QuickTime Player', 'tell application "QuickTime Player" to pause every document'],
    ['TV', 'tell application "TV" to pause'],
  ];
  if (targetApp && !players.some(([name]) => name.toLowerCase() === targetApp.toLowerCase())) {
    players.push([targetApp, `tell application ${asQuote(targetApp)} to pause`]);
  }
  await Promise.all(
    players.filter(([p]) => running.has(p)).map(([, cmd]) => runAppleScript(cmd).catch(() => {}))
  );
}

module.exports = { getNowPlaying, mediaPlay, mediaPause, pauseEverything, TrackLog };
