'use strict';
const { execFile } = require('child_process');

/**
 * Run an AppleScript string via osascript. Resolves stdout (trimmed).
 */
function runAppleScript(script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        err.message = `osascript failed: ${stderr || err.message}\n--- script ---\n${script}`;
        return reject(err);
      }
      resolve(String(stdout).trim());
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
function asQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { runAppleScript, sleep, asQuote };
