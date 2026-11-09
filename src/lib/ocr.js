'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const JXA = `
ObjC.import('Foundation');
ObjC.import('Vision');
ObjC.import('AppKit');
function run(argv) {
  const imgPath = argv[0];
  const url = $.NSURL.fileURLWithPath(imgPath);
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $.NSDictionary.dictionary);
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 1; // fast
  handler.performRequestsError($.NSArray.arrayWithObject(req), null);
  const obs = req.results;
  if (!obs) return 'null';
  const screen = $.NSScreen.mainScreen.frame.size;
  const items = [];
  for (let i = 0; i < obs.count; i++) {
    const o = obs.objectAtIndex(i);
    const cands = o.topCandidates(1);
    if (cands.count === 0) continue;
    const bb = o.boundingBox; // normalized, origin bottom-left
    const cx = (bb.origin.x + bb.size.width / 2) * screen.width;
    const cy = (1 - (bb.origin.y + bb.size.height / 2)) * screen.height;
    items.push({
      x: Math.round(cx),
      y: Math.round(cy),
      width: Math.round(bb.size.width * screen.width),
      height: Math.round(bb.size.height * screen.height),
      text: cands.objectAtIndex(0).string.js,
    });
  }
  return JSON.stringify({ width: screen.width, height: screen.height, items });
}`;

function recognizeScreen() {
  return new Promise((resolve) => {
    const img = path.join(os.tmpdir(), `rippa-ocr-${Date.now()}.png`);
    execFile('/usr/sbin/screencapture', ['-x', img], (err) => {
      if (err) return resolve(null);
      execFile(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', JXA, img],
        { timeout: 30000 },
        (err2, stdout) => {
          fs.unlink(img, () => {});
          if (err2) return resolve(null);
          const out = String(stdout).trim();
          if (!out || out === 'null') return resolve(null);
          try {
            resolve(JSON.parse(out));
          } catch {
            resolve(null);
          }
        }
      );
    });
  });
}

/** Return screen text with logical coordinates for UI that Reason draws itself. */
function readTextOnScreen() {
  return recognizeScreen();
}

function parseTransportPositionTsv(tsv, imageWidth, imageHeight) {
  const rows = String(tsv || '').trim().split(/\r?\n/).slice(1);
  const tokens = rows.map((line) => {
    const cols = line.split('\t');
    if (cols.length < 12 || cols[0] !== '5') return null;
    const left = Number(cols[6]);
    const top = Number(cols[7]);
    const confidence = Number(cols[10]);
    // Tesseract often includes the transport cell's printed separator in OCR
    // (e.g. "1."); strip only trailing punctuation, not arbitrary characters.
    const text = cols[11].trim().replace(/[.,]+$/, '');
    if (!Number.isFinite(left) || !Number.isFinite(top) || confidence < 75 || !/^\d{1,6}$/.test(text)) return null;
    // Reason's four transport cells are on the bottom-left of the Reason window.
    if (left / imageWidth < 0.27 || left / imageWidth > 0.40 || top / imageHeight < 0.90 || top / imageHeight > 0.94) return null;
    return { left, top, value: Number(text) };
  }).filter(Boolean).sort((a, b) => a.top - b.top || a.left - b.left);
  for (const first of tokens) {
    const row = tokens.filter((token) => Math.abs(token.top - first.top) <= imageHeight * 0.012)
      .sort((a, b) => a.left - b.left);
    if (row.length !== 4) continue;
    const [bar, beat, subdivision, tick] = row.map((token) => token.value);
    if (bar >= 1 && beat >= 1 && subdivision >= 1 && tick >= 0) return { bar, beat, subdivision, tick };
  }
  return null;
}

function reasonWindowInfo() {
  return new Promise((resolve) => {
    const helper = process.resourcesPath
      ? path.join(process.resourcesPath, 'reason-window-info.swift')
      : path.join(__dirname, 'reason-window-info.swift');
    execFile('/usr/bin/swift', [helper], { timeout: 20000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try { resolve(JSON.parse(String(stdout).trim())); } catch { resolve(null); }
    });
  });
}

async function readReasonTransportPosition() {
  const tesseract = ['/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract'].find(fs.existsSync);
  if (!tesseract) return null;
  const info = await reasonWindowInfo();
  if (!info || !Number.isFinite(Number(info.id))) return null;
  const imagePath = path.join(os.tmpdir(), `rippa-reason-${process.pid}-${Date.now()}.png`);
  try {
    await new Promise((resolve, reject) => {
      execFile('/usr/sbin/screencapture', ['-x', '-l', String(Math.trunc(info.id)), imagePath], { timeout: 15000 }, (error) => error ? reject(error) : resolve());
    });
    const { stdout } = await new Promise((resolve, reject) => {
      execFile(tesseract, [imagePath, 'stdout', '--psm', '11', 'tsv'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim()));
        resolve({ stdout: String(stdout || '') });
      });
    });
    const dimensions = await new Promise((resolve) => {
      execFile('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', imagePath], (_error, stdout) => {
        const text = String(stdout || '');
        const width = Number(text.match(/pixelWidth: (\d+)/)?.[1]);
        const height = Number(text.match(/pixelHeight: (\d+)/)?.[1]);
        resolve(width && height ? { width, height } : null);
      });
    });
    return dimensions ? parseTransportPositionTsv(stdout, dimensions.width, dimensions.height) : null;
  } catch {
    return null;
  } finally {
    fs.unlink(imagePath, () => {});
  }
}

/**
 * Finds text on screen via macOS Vision OCR and returns the logical screen
 * coordinates of its leftmost match, or null.
 */
async function findTextOnScreen(needle) {
  const screen = await recognizeScreen();
  if (!screen || !Array.isArray(screen.items)) return null;
  const lower = String(needle).toLowerCase();
  const matches = screen.items.filter((item) => String(item.text).toLowerCase().includes(lower));
  return matches.sort((a, b) => a.x - b.x || a.y - b.y)[0] || null;
}

module.exports = { findTextOnScreen, readReasonTransportPosition, readTextOnScreen, parseTransportPositionTsv };
