'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const appleScript = require('../src/lib/applescript');

let scriptRunner;
let visibleScreen;
appleScript.runAppleScript = (...args) => scriptRunner(...args);
appleScript.sleep = async () => {};
const ocr = require('../src/lib/ocr');
ocr.readTextOnScreen = async () => visibleScreen;
// Unit tests must use their fixture screenshots rather than the current desktop.
ocr.readReasonTransportPosition = async () => null;
const {
  Reason,
  compareMusicalPositions,
  currentPosition,
  currentPositionBar,
  exportNameVisible,
  formatMusicalPosition,
  locatorField,
  parseMusicalPosition,
  positionBar,
  trackHeaderItem,
} = require('../src/lib/reason');
const reason = new Reason({
  reason: { processName: 'Reason', projectWindowMatch: 'rippa-record' },
  loginWindowPatterns: ['log in', 'login', 'sign in', 'authorize'],
});

test('detects Reason 10 sign-in by its Welcome to Reason window title', async () => {
  scriptRunner = async () => 'Welcome to Reason!';
  assert.equal(await reason.loginWindowShowing(), true);
});

test('surfaces System Events permission errors instead of treating them as no windows', async () => {
  scriptRunner = async () => {
    throw new Error('osascript failed: Not authorized to send Apple events to System Events');
  };
  await assert.rejects(reason.projectIsOpen(), /Not authorized to send Apple events/);
});

function locatorReason() {
  const instance = new Reason({
    reason: {
      processName: 'Reason',
      projectWindowMatch: 'rippa-record',
      loopMenuOverride: '',
      walkPresses: 300,
    },
    delays: { afterMenuClickMs: 0 },
  });
  instance.findExistingExports = async () => [];
  return instance;
}

function asPosition(value, fallback) {
  if (typeof value === 'string') return value;
  return `${value ?? fallback}. 1. 1. 0`;
}

function reasonScreen(left = 3100, right = 3100, cursor = 3131) {
  return {
    width: 1728,
    height: 1117,
    items: [
      { x: 555, y: 1003, text: asPosition(cursor, 3131) },
      { x: 1182, y: 1004, width: 130, text: `L ${asPosition(left, 3100)}` },
      { x: 1181, y: 1022, width: 130, text: `R ${asPosition(right, 3100)}` },
    ],
  };
}

test('parses four high-confidence transport cells from the isolated Reason window', () => {
  const header = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const rows = ['3131.', '1.', '1.', '0'].map((value, index) =>
    `5\t1\t1\t1\t1\t${index + 1}\t${350 + index * 20}\t642\t15\t20\t92\t${value}`
  );
  assert.deepEqual(ocr.parseTransportPositionTsv([header, ...rows].join('\n'), 1200, 700), {
    bar: 3131, beat: 1, subdivision: 1, tick: 0,
  });

  const lowConfidence = rows.map((row, index) => index === 2 ? row.replace('\t92\t', '\t60\t') : row);
  assert.equal(ocr.parseTransportPositionTsv([header, ...lowConfidence].join('\n'), 1200, 700), null);
});

test('reads full bar.beat.subdivision.tick positions from the transport and locators', () => {
  assert.deepEqual(parseMusicalPosition('3131. 2. 3. 22*'), { bar: 3131, beat: 2, subdivision: 3, tick: 22 });
  assert.equal(positionBar('3131. 2. 3. 22"'), 3131);
  const screen = reasonScreen('3131.2.3.75', '3237.4.1.225', '3237.4.1.225');
  assert.deepEqual(currentPosition(screen), { bar: 3237, beat: 4, subdivision: 1, tick: 225 });
  assert.equal(currentPositionBar(screen), 3237);
  const leftField = locatorField(screen, 'L');
  const rightField = locatorField(screen, 'R');
  assert.deepEqual({ y: leftField.y, bar: leftField.bar, position: leftField.position }, {
    y: 1004, bar: 3131, position: { bar: 3131, beat: 2, subdivision: 3, tick: 75 },
  });
  assert.deepEqual({ y: rightField.y, bar: rightField.bar }, { y: 1022, bar: 3237 });
  assert.ok(leftField.x < 1182, 'click target is within the bar digits, not the whole display center');
  assert.ok(rightField.x < 1181, 'click target is within the bar digits, not the whole display center');
  assert.equal(formatMusicalPosition(leftField.position), '3131.2.3.75');
  assert.equal(compareMusicalPositions(leftField.position, rightField.position), -1);
});

test('confirms the exact generated filename beside Save As before saving', () => {
  const screen = {
    width: 1728,
    height: 1117,
    items: [
      { x: 836, y: 258, text: 'Save As:' },
      { x: 965, y: 258, text: 'Sunday-jazz-mix__jazz__2026-11-07_11.54' },
      { x: 1240, y: 592, text: 'Save' },
    ],
  };
  assert.equal(exportNameVisible(screen, 'sunday-jazz-mix__jazz__2026-11-07_11.54'), true);
  assert.equal(exportNameVisible({ ...screen, items: [screen.items[0], screen.items[2]] }, 'sunday-jazz-mix__jazz__2026-11-07_11.54'), false);
  assert.equal(exportNameVisible({ ...screen, items: [screen.items[0], { ...screen.items[1], y: 318 }, screen.items[2]] }, 'sunday-jazz-mix__jazz__2026-11-07_11.54'), false);
});

test('recognizes Reason’s separate native Save AXDialog and safely names export', async () => {
  const name = 'test-session__jazz__2026-11-07_11.54';
  const calls = [];
  visibleScreen = null; // The native field may clip its leading text; AX must supply the exact value.
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('subrole of w as text') && script.includes('return "save-dialog"')) return 'save-dialog';
    if (script.includes('set targetPanel to missing value') && script.includes('key code 36')) return 'confirmed';
    if (script.includes('button "Export" of w')) return 'clicked';
    if (script.includes('first window whose name is "Export Audio"')) return 'false';
    return '';
  };

  const r = locatorReason();
  r.readSavePanel = async () => ({ saveName: name, folderName: 'sleep', fileNames: ['earlier-export.aif'] });
  r.verifyExportFile = async () => ({ path: '/tmp/test-session.aif', sizeBytes: 1234, durationSeconds: 3.5 });
  await r.exportLoop(name);
  assert.ok(calls.some((script) => script.includes('name of w as text') && script.includes('AXDialog')));
  assert.ok(calls.some((script) => script.includes('key code 36')));
  assert.ok(!calls.some((script) => script.includes(`keystroke "${name}"`)));
});

test('sets and reads the full Save As value through Accessibility when it differs', async () => {
  const name = 'test-session__jazz__2026-11-07_11.54';
  const calls = [];
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('subrole of w as text') && script.includes('return "save-dialog"')) return 'save-dialog';
    if (script.includes('key code 36')) return 'confirmed';
    if (script.includes('button "Export" of w')) return 'clicked';
    if (script.includes('first window whose name is "Export Audio"')) return 'false';
    return '';
  };
  const r = locatorReason();
  r.readSavePanel = async () => ({ saveName: 'clipped-name-suffix', folderName: 'sleep', fileNames: [] });
  r.writeSavePanelName = async (value) => ({ saveName: value, folderName: 'sleep', fileNames: [] });
  r.verifyExportFile = async () => ({ path: '/tmp/test-session.aif', sizeBytes: 1234, durationSeconds: 3.5 });
  await r.exportLoop(name);
  assert.ok(calls.some((script) => script.includes('key code 36')));
});

test('uses verified Save As OCR when Save-panel Accessibility readback is unavailable', async () => {
  const name = 'verified-ocr-fallback__jazz__2026-11-07_14.31';
  const calls = [];
  visibleScreen = {
    width: 1728,
    height: 1117,
    items: [
      { x: 836, y: 258, text: 'Save As:' },
      { x: 965, y: 258, text: name },
    ],
  };
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('subrole of w as text') && script.includes('return "save-dialog"')) return 'save-dialog';
    if (script.includes('key code 36')) return 'confirmed';
    if (script.includes('button "Export" of w')) return 'clicked';
    if (script.includes('first window whose name is "Export Audio"')) return 'false';
    return '';
  };
  const r = locatorReason();
  r.readSavePanel = async () => { throw new Error('Reason Save As field is unavailable through Accessibility.'); };
  r.writeSavePanelName = async () => { throw new Error('Reason Save As field is not writable through Accessibility.'); };
  r.enterExportFilename = async (typedName) => { assert.equal(typedName, name); return 'typed'; };
  r.verifyExportFile = async () => ({ path: `/sleep/${name}.aif`, sizeBytes: 1234, durationSeconds: 3.5 });

  const exported = await r.exportLoop(name);
  assert.equal(exported.path, `/sleep/${name}.aif`);
  assert.ok(calls.some((script) => script.includes('key code 36')));
});

test('does not save when OCR cannot confirm the generated Save As name', async () => {
  const name = 'unverified-name__jazz__2026-11-07_14.31';
  const calls = [];
  visibleScreen = {
    width: 1728,
    height: 1117,
    items: [
      { x: 836, y: 258, text: 'Save As:' },
      { x: 965, y: 258, text: 'rippa-record' },
    ],
  };
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('subrole of w as text') && script.includes('return "save-dialog"')) return 'save-dialog';
    return '';
  };
  const r = locatorReason();
  r.readSavePanel = async () => { throw new Error('AX unavailable'); };
  r.writeSavePanelName = async () => { throw new Error('AX unavailable'); };
  r.enterExportFilename = async () => 'typed';
  await assert.rejects(r.exportLoop(name), /did not verify generated export name/);
  assert.ok(!calls.some((script) => script.includes('key code 36')));
});

test('refuses to overwrite an export already listed in the Save folder', async () => {
  const name = 'test-session__jazz__2026-11-07_11.54';
  const calls = [];
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('subrole of w as text') && script.includes('return "save-dialog"')) return 'save-dialog';
    return '';
  };
  const r = locatorReason();
  r.readSavePanel = async () => ({ saveName: name, folderName: 'sleep', fileNames: [`${name}.aif`] });
  await assert.rejects(r.exportLoop(name), /already exists in the selected folder/);
  assert.ok(!calls.some((script) => script.includes('key code 36')));
});

test('never types a generated filename when Reason Save dialog was not detected', async () => {
  const calls = [];
  scriptRunner = async (script) => { calls.push(script); return 'no'; };
  await assert.rejects(locatorReason().exportLoop('test-session__2026-11-07_11.54'), /native Save panel did not appear/);
  assert.ok(!calls.some((script) => script.includes('keystroke "test-session__2026-11-07_11.54"')));
});

test('sets and verifies exact L/R BBTT positions rather than truncating to bars', async () => {
  const calls = [];
  const start = { bar: 3131, beat: 2, subdivision: 3, tick: 75 };
  const end = { bar: 3237, beat: 4, subdivision: 1, tick: 225 };
  visibleScreen = reasonScreen();
  scriptRunner = async (script) => {
    calls.push(script);
    if (script.includes('keystroke "3131.2.3.75"')) visibleScreen = reasonScreen('3131.2.3.75', 3100);
    if (script.includes('keystroke "3237.4.1.225"')) visibleScreen = reasonScreen('3131.2.3.75', '3237.4.1.225', '3237.4.1.225');
    return '';
  };
  const result = await locatorReason().loopAroundRecording(start, end);

  assert.deepEqual(result, {
    ok: true,
    via: 'Manual L/R entry (3131.2.3.75–3237.4.1.225)',
    start: '3131.2.3.75',
    end: '3237.4.1.225',
  });
  assert.equal(calls.length, 2);
  const lClickX = Math.round(locatorField(reasonScreen(), 'L').x);
  const rClickX = Math.round(locatorField(reasonScreen(), 'R').x);
  assert.match(calls[0], new RegExp(`click at \\{${lClickX}, 1004\\}[\\s\\S]*keystroke "3131.2.3.75"[\\s\\S]*key code 36`));
  assert.match(calls[1], new RegExp(`click at \\{${rClickX}, 1022\\}[\\s\\S]*keystroke "3237.4.1.225"[\\s\\S]*key code 36`));
  assert.doesNotMatch(calls.join('\n'), /Set Loop to Selection/);
});

test('starts at the observed transport song end without using prior loop selection', async () => {
  const calls = [];
  visibleScreen = {
    width: 1728,
    height: 1117,
    items: [
      { x: 430, y: 285, text: 'Audio Track 1' },
      { x: 555, y: 1003, text: '3340.3.2.225' },
      { x: 1182, y: 1004, width: 130, text: 'L 3131.1.1.0' },
      { x: 1181, y: 1022, width: 130, text: 'R 3237.1.1.0' },
    ],
  };
  scriptRunner = async (script) => { calls.push(script); return ''; };
  const start = await locatorReason().goToTrack1End();
  assert.deepEqual(start, { bar: 3340, beat: 3, subdivision: 2, tick: 225 });
  assert.ok(calls.some((script) => script.includes('key code 119')));
  assert.doesNotMatch(calls.join('\n'), /Set Loop to Selection|key code 84/);
});

test('locates Audio Track 1 in the sequencer and ignores Browser text or stale coordinates', async () => {
  const screen = {
    width: 1728,
    height: 1117,
    items: [
      { x: 50, y: 200, text: 'Audio Track 1' },
      { x: 430, y: 285, text: 'Audio Track 1' },
      { x: 430, y: 780, text: 'Audio Track 1' },
    ],
  };
  assert.deepEqual(trackHeaderItem(screen), screen.items[1]);

  const calls = [];
  visibleScreen = screen;
  scriptRunner = async (script) => { calls.push(script); return ''; };
  const configured = new Reason({
    reason: { processName: 'Reason', clickPoints: { trackHeader: { x: 430, y: 780 } } },
    delays: { keystrokeGapMs: 0 },
  });
  await configured.selectTrack1();
  assert.ok(calls.some((script) => script.includes('click at {430, 285}')));
  assert.ok(!calls.some((script) => script.includes('click at {430, 780}')));
});

test('fails closed instead of clicking a stale track coordinate when OCR misses Track 1', async () => {
  visibleScreen = { width: 1728, height: 1117, items: [{ x: 430, y: 285, text: 'Track 2' }] };
  const calls = [];
  scriptRunner = async (script) => { calls.push(script); return ''; };
  const configured = new Reason({
    reason: { processName: 'Reason', clickPoints: { trackHeader: { x: 430, y: 285 } } },
    delays: { keystrokeGapMs: 0 },
  });
  await assert.rejects(configured.selectTrack1(), /no recording was started/);
  assert.ok(!calls.some((script) => script.includes('click at {430, 285}')));
});

test('does not loop or export when a full recorded position is missing, equal, or reversed', async () => {
  const calls = [];
  scriptRunner = async (script) => { calls.push(script); return ''; };
  const start = { bar: 3131, beat: 1, subdivision: 1, tick: 0 };
  assert.equal((await locatorReason().loopAroundRecording(null, start)).ok, false);
  assert.equal((await locatorReason().loopAroundRecording(start, start)).ok, false);
  assert.equal((await locatorReason().loopAroundRecording({ bar: 3237, beat: 1, subdivision: 1, tick: 0 }, start)).ok, false);
  assert.equal(calls.length, 0);
});
