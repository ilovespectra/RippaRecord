'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

function helperPath() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'save-panel-accessibility.swift'));
  candidates.push(path.join(__dirname, 'save-panel-accessibility.swift'));
  const result = candidates.find((candidate) => fs.existsSync(candidate));
  if (!result) throw new Error('Rippa’s Save-panel Accessibility helper is missing.');
  return result;
}

function runSavePanelAX(processName, action, name) {
  return new Promise((resolve, reject) => {
    const args = [helperPath(), processName, action];
    if (name !== undefined) args.push(String(name));
    execFile('/usr/bin/swift', args, { timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim()));
      try {
        resolve(JSON.parse(String(stdout).trim()));
      } catch {
        reject(new Error('Reason’s Save-panel Accessibility response was invalid.'));
      }
    });
  });
}

function readSavePanel(processName) {
  return runSavePanelAX(processName, 'read');
}

function setSavePanelName(processName, name) {
  return runSavePanelAX(processName, 'set', name);
}

module.exports = { readSavePanel, setSavePanelName };
