'use strict';
const http = require('http');

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

function sanitize(s, max = 48) {
  return String(s)
    .replace(/[\\/:*?"<>|.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim()
    .replace(/\s/g, '-')
    .toLowerCase();
}

function askOllama(cfg, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: cfg.model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.9 },
    });
    const url = new URL('/api/generate', cfg.url);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: cfg.timeoutMs || 20000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(JSON.parse(data).response));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('ollama timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Builds a creative session name from the recorded track log via Ollama.
 * Always falls back to a timestamped generic name.
 */
async function generateSessionName(ollamaCfg, tracks) {
  const ts = timestamp();
  if (!tracks || tracks.length === 0) {
    return `rippa-session__${ts}`;
  }
  const trackList = tracks
    .map((t) => `- "${t.title}"${t.artist ? ` by ${t.artist}` : ''}${t.album ? ` (${t.album})` : ''}`)
    .join('\n');
  const prompt = `You name recorded music streaming sessions (radio rips, playlists, mixes).
Given the tracks that played, respond ONLY with JSON like {"name": "...", "genre": "..."}.
- "name": a short, creative, evocative session name, 2-4 words. If it looks like an NTS show, a playlist, or a single artist session, reflect that.
- "genre": your best approximate genre for the whole session, 1-3 words.

Tracks played:
${trackList}`;
  try {
    const res = await askOllama(ollamaCfg, prompt);
    const name = sanitize(res.name || 'rippa-session');
    const genre = sanitize(res.genre || '', 24);
    return `${name || 'rippa-session'}${genre ? `__${genre}` : ''}__${ts}`;
  } catch {
    const first = tracks[0];
    const hint = sanitize(first.artist || first.title || 'session', 24);
    return `rippa-${hint}__${ts}`;
  }
}

module.exports = { generateSessionName, timestamp, sanitize };
