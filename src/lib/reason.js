'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runAppleScript, sleep, asQuote } = require('./applescript');
const { readReasonTransportPosition, readTextOnScreen } = require('./ocr');
const savePanel = require('./save-panel');

function parseMusicalPosition(text) {
  const match = String(text).match(/(?:^|[^0-9])(\d{1,6})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?:\s*\.\s*(\d{1,3}))?/);
  if (!match) return null;
  return {
    bar: Number(match[1]),
    beat: Number(match[2]),
    subdivision: Number(match[3]),
    tick: Number(match[4] || 0),
  };
}

function normalizeMusicalPosition(value) {
  if (typeof value === 'string') return parseMusicalPosition(value);
  if (!value || typeof value !== 'object') return null;
  const position = {
    bar: Number(value.bar),
    beat: Number(value.beat),
    subdivision: Number(value.subdivision),
    tick: Number(value.tick ?? 0),
  };
  return Object.values(position).every(Number.isInteger) ? position : null;
}

function validMusicalPosition(value) {
  const position = normalizeMusicalPosition(value);
  return !!position && position.bar >= 1 && position.beat >= 1 &&
    position.subdivision >= 1 && position.tick >= 0;
}

function formatMusicalPosition(value) {
  const position = normalizeMusicalPosition(value);
  return position ? `${position.bar}.${position.beat}.${position.subdivision}.${position.tick}` : '';
}

function compareMusicalPositions(left, right) {
  const a = normalizeMusicalPosition(left);
  const b = normalizeMusicalPosition(right);
  if (!a || !b) return NaN;
  for (const key of ['bar', 'beat', 'subdivision', 'tick']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function barSegment(text) {
  const source = String(text);
  const match = source.match(/(?:^|[^0-9])(\d{1,6})\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}(?:\s*\.\s*\d{1,3})?/);
  if (!match) return null;
  const start = match.index + match[0].indexOf(match[1]);
  return {
    bar: Number(match[1]),
    position: parseMusicalPosition(match[0]),
    start,
    length: match[1].length,
  };
}

function positionBar(text) {
  return parseMusicalPosition(text)?.bar ?? null;
}

function segmentCenterX(item, segment) {
  const width = Number(item.width) || 0;
  const textLength = String(item.text).length;
  if (!width || !textLength) return Number(item.x);
  return Number(item.x) - width / 2 + width * (segment.start + segment.length / 2) / textLength;
}

/** Find the exact Audio Track 1 label in Reason's sequencer track list. */
function trackHeaderItem(screen, name = 'Audio Track 1') {
  if (!screen || !Array.isArray(screen.items)) return null;
  const width = Number(screen.width) || 0;
  const height = Number(screen.height) || 0;
  if (!width || !height) return null;
  const wanted = String(name).trim().replace(/\s+/g, ' ').toLowerCase();
  const candidates = screen.items.filter((item) => {
    const text = String(item.text).trim().replace(/\s+/g, ' ').toLowerCase();
    const x = Number(item.x) / width;
    const y = Number(item.y) / height;
    // The Browser also contains the project track name; the sequencer's
    // Track List sits just to its right. Never fall back to a stale pixel.
    return text === wanted && x >= 0.19 && x <= 0.52 && y >= 0.12 && y <= 0.7;
  });
  candidates.sort((a, b) => {
    const score = (item) => Math.abs(Number(item.x) / width - 0.25) + Math.abs(Number(item.y) / height - 0.25) * 0.35;
    return score(a) - score(b);
  });
  return candidates[0] || null;
}

function locatorField(screen, side) {
  if (!screen || !Array.isArray(screen.items)) return null;
  const width = Number(screen.width) || 0;
  const height = Number(screen.height) || 0;
  const sidePattern = new RegExp(`^\\s*${side}\\s*[:=]?\\s*\\d`, 'i');
  const visible = screen.items.filter((item) =>
    Number(item.x) > width * 0.5 && Number(item.y) > height * 0.85
  );
  const combined = visible.find((item) => sidePattern.test(String(item.text)));
  if (combined) {
    const segment = barSegment(combined.text);
    if (segment) return {
      x: segmentCenterX(combined, segment),
      y: combined.y,
      bar: segment.bar,
      position: segment.position,
    };
  }
  const label = visible.find((item) => String(item.text).trim().toUpperCase() === side);
  if (!label) return null;
  const value = visible
    .filter((item) => Number(item.x) > Number(label.x) && Math.abs(Number(item.y) - Number(label.y)) < height * 0.025)
    .map((item) => ({ item, segment: barSegment(item.text) }))
    .find((entry) => entry.segment != null);
  return value
    ? {
      x: segmentCenterX(value.item, value.segment),
      y: value.item.y,
      bar: value.segment.bar,
      position: value.segment.position,
    }
    : null;
}

function currentPosition(screen) {
  if (!screen || !Array.isArray(screen.items)) return null;
  const width = Number(screen.width) || 0;
  const height = Number(screen.height) || 0;
  const candidates = screen.items
    .filter((item) => Number(item.x) < width * 0.6 && Number(item.y) > height * 0.85)
    .map((item) => ({ item, position: parseMusicalPosition(item.text) }))
    .filter((entry) => entry.position != null);
  candidates.sort((a, b) =>
    Math.abs(Number(a.item.x) / width - 0.32) - Math.abs(Number(b.item.x) / width - 0.32)
  );
  return candidates[0]?.position ?? null;
}

function currentPositionBar(screen) {
  return currentPosition(screen)?.bar ?? null;
}

function normalizedText(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Confirm the exact export name is visible in the Save As value field. */
function exportNameVisible(screen, name) {
  if (!screen || !Array.isArray(screen.items)) return false;
  const expected = normalizedText(name);
  if (!expected) return false;
  const labels = screen.items.filter((item) => /save\s*as/i.test(String(item.text)));
  if (!labels.length) return false;
  const rowTolerance = Math.max(16, (Number(screen.height) || 0) * 0.025);
  return labels.some((label) => screen.items.some((item) =>
    Number(item.x) > Number(label.x) &&
    Math.abs(Number(item.y) - Number(label.y)) <= rowTolerance &&
    normalizedText(item.text).includes(expected)
  ));
}

/**
 * All Reason 10 automation. Keystrokes are sent via System Events, which
 * requires Accessibility permission for the app running this process.
 *
 * Reason 10 transport keys:
 *   Space        = play/stop toggle
 *   Cmd+Return   = record (starts transport if stopped)
 *   End          = jump song position to end of song
 */
class Reason {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg;
    this.log = log;
  }

  get proc() {
    return this.cfg.reason.processName;
  }

  async isRunning() {
    const out = await runAppleScript(
      `tell application "System Events" to (name of processes) contains ${asQuote(this.proc)}`
    );
    return out === 'true';
  }

  async launch() {
    if (await this.isRunning()) return false;
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-g', '-a', this.cfg.reason.appPath], (err) => (err ? reject(err) : resolve()));
    });
    // wait until the process exists
    for (let i = 0; i < 60; i++) {
      if (await this.isRunning()) break;
      await sleep(1000);
    }
    await sleep(this.cfg.delays.afterLaunchMs);
    return true;
  }

  async windowNames() {
    // Do not turn a TCC/Accessibility denial into an empty window list: callers
    // would otherwise wait for the project until the ten-minute timeout.
    const out = await runAppleScript(
      `tell application "System Events" to tell process ${asQuote(this.proc)} to get name of windows`
    );
    return out ? out.split(', ').map((s) => s.trim()) : [];
  }

  /** True if a login/sign-in window is currently showing. */
  async loginWindowShowing() {
    const names = await this.windowNames();
    // Reason 10's sign-in dialog is titled "Welcome to Reason!", not "Log in".
    const patterns = [...(this.cfg.loginWindowPatterns || []), 'welcome to reason']
      .map((p) => p.toLowerCase());
    if (names.some((n) => patterns.some((p) => n.toLowerCase().includes(p)))) return true;
    // Reason 10's login dialog is unnamed: an AXDialog containing the account
    // email in a text field
    try {
      const out = await runAppleScript(`
tell application "System Events"
  tell process ${asQuote(this.proc)}
    repeat with w in windows
      if subrole of w is "AXDialog" then
        try
          repeat with t in (text fields of w)
            if (value of t as string) contains "@" then return "login"
          end repeat
        end try
      end if
    end repeat
    return "none"
  end tell
end tell`, { timeoutMs: 15000 });
      return out === 'login';
    } catch {
      return false;
    }
  }

  /**
   * Handles the login dialog. The account email and password are prefilled
   * ("Remember my password"), so Return submits the default Log in button.
   * Tries a few times, then falls back to waiting for a manual login.
   */
  async waitThroughLogin(onWaiting, timeoutMs = 300000) {
    if (!(await this.loginWindowShowing())) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.log(`auto-login attempt ${attempt + 1}`);
      await this.activate();
      await this.keystroke('keystroke return');
      await sleep(3000);
      if (!(await this.loginWindowShowing())) return;
    }
    // auto-login didn't take — wait for the user
    if (onWaiting) onWaiting();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(2000);
      if (!(await this.loginWindowShowing())) return;
    }
    throw new Error('Timed out waiting for Reason login');
  }

  async projectIsOpen() {
    const match = this.cfg.reason.projectWindowMatch.toLowerCase();
    const names = await this.windowNames();
    return names.some((n) => n.toLowerCase().includes(match));
  }

  /** Opens the project and polls until its window appears (big files are slow). */
  async openProject(onProgress, timeoutMs = 600000) {
    const p = this.cfg.reason.projectPath;
    if (!p) return;
    if (await this.projectIsOpen()) {
      this.log('project already open');
      return;
    }
    await new Promise((resolve, reject) => {
      execFile('/usr/bin/open', ['-g', p], (err) => (err ? reject(err) : resolve()));
    });
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(3000);
      if (await this.projectIsOpen()) {
        await sleep(this.cfg.delays.afterOpenProjectMs);
        return;
      }
      // the login dialog can appear late (e.g. after a cold launch) and block
      // the project from opening — handle it here too
      if (await this.loginWindowShowing()) {
        await this.waitThroughLogin(onProgress ? () => onProgress('login') : null);
      }
      if (onProgress) onProgress(Math.round((Date.now() - start) / 1000));
    }
    throw new Error(`Timed out waiting for project window matching "${this.cfg.reason.projectWindowMatch}"`);
  }

  async activate() {
    await runAppleScript(
      `tell application "System Events" to tell process ${asQuote(this.proc)} to set frontmost to true`
    );
    await sleep(this.cfg.delays.keystrokeGapMs);
  }

  /** Name of the currently frontmost app. */
  async frontmostApp() {
    return runAppleScript(
      `tell application "System Events" to get name of first process whose frontmost is true`
    );
  }

  /** Bring a named app back to the front (best effort). */
  async focusApp(name) {
    if (!name || name === this.proc) return;
    await runAppleScript(
      `tell application "System Events" to tell process ${asQuote(name)} to set frontmost to true`
    ).catch(() => {});
  }

  /** Remembers the frontmost app, runs fn with Reason focused, restores focus. */
  async withFocus(fn, restore = true) {
    let prev = null;
    try {
      prev = await runAppleScript(
        `tell application "System Events" to get name of first process whose frontmost is true`
      );
    } catch { /* ignore */ }
    await this.activate();
    try {
      return await fn();
    } finally {
      if (restore && prev && prev !== this.proc) {
        runAppleScript(
          `tell application "System Events" to tell process ${asQuote(prev)} to set frontmost to true`
        ).catch(() => {});
      }
    }
  }

  async keystroke(script) {
    return runAppleScript(
      `tell application "System Events" to tell process ${asQuote(this.proc)}\n${script}\nend tell`
    );
  }

  /**
   * Select the configured recording track by its exact OCR label in Reason's
   * sequencer Track List. A stale configured coordinate can select another
   * track after F7 changes the layout, so missing labels fail closed.
   */
  async selectTrack1() {
    const trackName = String(this.cfg.reason.trackName || 'Audio Track 1').trim();
    await this.activate();
    await this.keystroke('key code 98'); // F7: sequencer focus
    await sleep(400);
    const pt = trackHeaderItem(await readTextOnScreen(), trackName);
    if (!pt) throw new Error(`Could not locate ${trackName} in Reason’s sequencer track list; no recording was started.`);
    this.log(`clicking OCR-located ${trackName} header at ${pt.x},${pt.y}`);
    await runAppleScript(`tell application "System Events" to click at {${Math.round(pt.x)}, ${Math.round(pt.y)}}`);
    await sleep(500);
  }

  /**
   * Select the configured recording track, move to Reason's song end, and capture
   * the full displayed bar.beat.subdivision.tick position before recording.
   * Never infer a take boundary from loop locators or a prior clip selection.
   */
  async goToTrack1End() {
    await this.selectTrack1();
    await this.keystroke('key code 119'); // End: jump transport to song end
    await sleep(this.cfg.delays.keystrokeGapMs);
    const position = await this.currentPosition();
    if (!validMusicalPosition(position)) {
      throw new Error('Could not read Reason’s full transport position at take start; no recording was started.');
    }
    this.log(`captured take start ${formatMusicalPosition(position)} from Reason transport`);
    return position;
  }

  async currentPosition() {
    // Reason's compact position display is split into four separate native
    // tokens; use the isolated Reason window plus high-confidence TSV OCR.
    const isolated = await readReasonTransportPosition().catch(() => null);
    if (validMusicalPosition(isolated)) {
      this.log(`read Reason transport BBT ${formatMusicalPosition(isolated)} from four OCR-verified cells`);
      return isolated;
    }
    const fallback = currentPosition(await readTextOnScreen());
    if (validMusicalPosition(fallback)) {
      this.log(`read Reason transport BBT ${formatMusicalPosition(fallback)} from full-screen OCR`);
      return fallback;
    }
    this.log('Reason transport read failed: no complete, high-confidence BBT position');
    return null;
  }

  async currentPositionBar() {
    return (await this.currentPosition())?.bar ?? null;
  }

  async readLocatorPosition(side) {
    const field = locatorField(await readTextOnScreen(), side);
    return field?.position ?? null;
  }

  async readLocatorBar(side) {
    return (await this.readLocatorPosition(side))?.bar ?? null;
  }

  async setLocatorPosition(side, value) {
    const position = normalizeMusicalPosition(value);
    if (!['L', 'R'].includes(side) || !validMusicalPosition(position)) {
      throw new Error(`Invalid ${side} loop locator position: ${formatMusicalPosition(value) || String(value)}`);
    }
    const expected = formatMusicalPosition(position);
    let screen = await readTextOnScreen();
    let field = locatorField(screen, side);
    if (!field) throw new Error(`Could not locate Reason's ${side} loop locator on screen`);
    if (compareMusicalPositions(field.position, position) === 0) {
      return { unchanged: true, position };
    }
    await this.keystroke(
      `click at {${Math.round(field.x)}, ${Math.round(field.y)}}\ndelay 0.12\nclick at {${Math.round(field.x)}, ${Math.round(field.y)}}\ndelay 0.15\nkeystroke "a" using command down\nkeystroke ${asQuote(expected)}\nkey code 36`
    );
    await sleep(350);
    for (let attempt = 0; attempt < 2; attempt++) {
      screen = await readTextOnScreen();
      field = locatorField(screen, side);
      if (field && compareMusicalPositions(field.position, position) === 0) {
        return { unchanged: false, position };
      }
      if (attempt === 0) await sleep(250);
    }
    throw new Error(`Reason did not confirm ${side} loop locator at ${expected}`);
  }

  async setLocatorBar(side, bar) {
    return this.setLocatorPosition(side, { bar, beat: 1, subdivision: 1, tick: 0 });
  }

  /**
   * Opens Preferences and selects the configured audio device in the Audio
   * page. The prefs window is a native toolbar window titled after the current
   * page (General/Audio/...). If the device already matches, this is a no-op.
   */
  async setAudioDevice() {
    const device = this.cfg.reason.audioDevice;
    const d = this.cfg.delays;
    await this.activate();
    const script = `
tell application "System Events"
  tell process ${asQuote(this.proc)}
    set frontmost to true
    -- open prefs unless a prefs window (one with a toolbar) is already up
    set prefWin to missing value
    repeat with w in windows
      if (exists toolbar 1 of w) then
        set prefWin to w
        exit repeat
      end if
    end repeat
    if prefWin is missing value then
      keystroke "," using command down
      delay ${d.afterPrefsOpenMs / 1000}
      repeat with w in windows
        if (exists toolbar 1 of w) then
          set prefWin to w
          exit repeat
        end if
      end repeat
    end if
    if prefWin is missing value then error "Preferences window did not open"
    -- switch to the Audio page
    try
      click button "Audio" of toolbar 1 of prefWin
      delay 0.8
    end try
    -- pass 1: already set?
    repeat with pb in (pop up buttons of prefWin)
      if (value of pb as string) contains ${asQuote(device)} then
        click (first button of prefWin whose subrole is "AXCloseButton")
        return "already-set"
      end if
    end repeat
    -- pass 2: find the popup that offers the device
    repeat with pb in (pop up buttons of prefWin)
      click pb
      delay 0.8
      set picked to false
      try
        repeat with mi in (menu items of menu 1 of pb)
          if (name of mi as string) contains ${asQuote(device)} then
            click mi
            set picked to true
            exit repeat
          end if
        end repeat
      end try
      if picked then
        delay 1.0
        click (first button of prefWin whose subrole is "AXCloseButton")
        return "set"
      else
        key code 53
        delay 0.4
      end if
    end repeat
    click (first button of prefWin whose subrole is "AXCloseButton")
    error "No popup offered audio device '${device}'"
  end tell
end tell`;
    const result = await runAppleScript(script, { timeoutMs: 60000 });
    await sleep(d.afterMenuClickMs);
    return result;
  }

  /** Start recording: Cmd+Return. */
  async startRecord() {
    await this.withFocus(async () => {
      await this.keystroke('keystroke return using command down');
    }, false);
  }

  /** Stop transport: Space. */
  async stopTransport() {
    await this.withFocus(async () => {
      await this.keystroke('key code 49');
    });
  }

  /** Resume recording: Cmd+Return (records from current song position). */
  async resumeRecord() {
    await this.withFocus(async () => {
      await this.keystroke('keystroke return using command down');
    });
  }

  async menuItems(menuName) {
    const out = await runAppleScript(
      `tell application "System Events" to tell process ${asQuote(this.proc)} to get name of menu items of menu ${asQuote(
        menuName
      )} of menu bar item ${asQuote(menuName)} of menu bar 1`
    );
    return out ? out.split(', ') : [];
  }

  async clickMenuItem(menuName, itemMatch) {
    const script = `
tell application "System Events"
  tell process ${asQuote(this.proc)}
    set frontmost to true
    delay 0.3
    set theMenu to menu ${asQuote(menuName)} of menu bar item ${asQuote(menuName)} of menu bar 1
    set clicked to false
    repeat with mi in (menu items of theMenu)
      set n to name of mi
      if n is not missing value and n contains ${asQuote(itemMatch)} then
        click mi
        set clicked to true
        exit repeat
      end if
    end repeat
    if not clicked then error "No menu item in ${menuName} contains '${itemMatch}'"
  end tell
end tell`;
    await runAppleScript(script, { timeoutMs: 30000 });
    await sleep(this.cfg.delays.afterMenuClickMs);
  }

  /** Set exact L/R bounds from the full transport positions recorded at start/stop. */
  async loopAroundRecording(startPosition, endPosition) {
    if (!validMusicalPosition(startPosition) || !validMusicalPosition(endPosition) ||
        compareMusicalPositions(endPosition, startPosition) <= 0) {
      return {
        ok: false,
        error: `Invalid recorded position range: ${formatMusicalPosition(startPosition) || String(startPosition)}–${formatMusicalPosition(endPosition) || String(endPosition)}`,
      };
    }
    const start = formatMusicalPosition(startPosition);
    const end = formatMusicalPosition(endPosition);
    try {
      await this.setLocatorPosition('L', startPosition);
      await this.setLocatorPosition('R', endPosition);
      this.log(`verified Reason loop bounds L=${start} R=${end}`);
      return { ok: true, via: `Manual L/R entry (${start}–${end})`, start, end };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Reason 10 exposes its native Save panel as a separate AXDialog named Save. */
  async exportSavePanelState() {
    return runAppleScript(`
tell application "System Events"
  tell process ${asQuote(this.proc)}
    repeat with w in windows
      try
        if (name of w as text) is "Save" and (subrole of w as text) is "AXDialog" then return "save-dialog"
      end try
      try
        repeat with s in sheets of w
          if (name of s as text) is "Save" then return "save-dialog"
          try
            if (count of text fields of s) > 0 and (exists button "Save" of s) then return "save-dialog"
          end try
        end repeat
      end try
    end repeat
    return "no"
  end tell
end tell`, { timeoutMs: 5000 });
  }

  /** Set the Save As value only after verifying the native Save panel is frontmost. */
  async enterExportFilename(name) {
    return runAppleScript(`
tell application "System Events"
  tell process ${asQuote(this.proc)}
    set frontmost to true
    delay 0.2
    set targetPanel to missing value
    repeat with w in windows
      try
        if (name of w as text) is "Save" and (subrole of w as text) is "AXDialog" then
          set targetPanel to w
          exit repeat
        end if
      end try
      try
        repeat with s in sheets of w
          if (name of s as text) is "Save" then
            set targetPanel to s
            exit repeat
          end if
        end repeat
      end try
      if targetPanel is not missing value then exit repeat
    end repeat
    if targetPanel is missing value then error "Reason's Save panel is no longer open"
    -- Prefer direct Accessibility value entry when the native field is exposed.
    try
      if (count of text fields of targetPanel) > 0 then
        set value of text field 1 of targetPanel to ${asQuote(name)}
        if (value of text field 1 of targetPanel as text) is ${asQuote(name)} then return "set-and-verified"
      end if
    end try
    -- On this Reason build the panel is AXDialog named Save but its controls
    -- are not exposed. Its Save As field is preselected; type only after the
    -- named dialog has been positively identified above.
    keystroke "a" using command down
    delay 0.15
    keystroke ${asQuote(name)}
    return "typed"
  end tell
end tell`, { timeoutMs: 30000 });
  }

  async confirmExportSavePanel() {
    return runAppleScript(`
tell application "System Events"
  tell process ${asQuote(this.proc)}
    set targetPanel to missing value
    repeat with w in windows
      try
        if (name of w as text) is "Save" and (subrole of w as text) is "AXDialog" then
          set targetPanel to w
          exit repeat
        end if
      end try
      try
        repeat with s in sheets of w
          if (name of s as text) is "Save" then
            set targetPanel to s
            exit repeat
          end if
        end repeat
      end try
      if targetPanel is not missing value then exit repeat
    end repeat
    if targetPanel is missing value then error "Reason's Save panel is no longer open"
    set frontmost to true
    key code 36
    return "confirmed"
  end tell
end tell`, { timeoutMs: 15000 });
  }

  async readSavePanel() {
    return savePanel.readSavePanel(this.proc);
  }

  async writeSavePanelName(name) {
    return savePanel.setSavePanelName(this.proc, name);
  }

  async findExistingExports(name) {
    const extensions = ['aif', 'aiff', 'wav', 'caf'];
    const matches = [];
    for (const extension of extensions) {
      const filename = `${name}.${extension}`;
      const results = await new Promise((resolve) => {
        execFile('/usr/bin/mdfind', ['-name', filename], { timeout: 15000 }, (_error, stdout) => {
          resolve(String(stdout || '').split(/\r?\n/).filter(Boolean));
        });
      });
      matches.push(...results.filter((candidate) => path.basename(candidate).toLowerCase() === filename.toLowerCase()));
    }
    return [...new Set(matches)];
  }

  /** Locate the exact audio file and read its completed duration. */
  async verifyExportFile(name, timeoutMs = 180000) {
    const started = Date.now();
    let matches = [];
    while (Date.now() - started < timeoutMs) {
      matches = await this.findExistingExports(name);
      if (matches.length) break;
      await sleep(2000);
    }
    if (matches.length !== 1) {
      throw new Error(matches.length > 1
        ? `More than one completed export named “${name}” was found`
        : `Reason finished but the completed audio file “${name}” could not be located`);
    }
    const filePath = matches[0];
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) throw new Error('The generated audio export is empty or unavailable');
    const audioInfo = await new Promise((resolve, reject) => {
      execFile('/usr/bin/afinfo', [filePath], { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).trim()));
        resolve(String(stdout));
      });
    });
    const duration = audioInfo.match(/estimated duration:\s*([0-9.]+)\s*sec/i);
    if (!duration || !(Number(duration[1]) > 0)) throw new Error('The completed export’s audio duration could not be verified');
    return { path: filePath, sizeBytes: stat.size, durationSeconds: Number(duration[1]) };
  }

  /**
   * File > Export Loop as Audio File…, detect Reason's native Save panel,
   * set/read the exact name through Accessibility, then verify the finished file.
   */
  async exportLoop(name) {
    const d = this.cfg.delays;
    const generatedName = String(name || '').trim();
    if (!generatedName || /[\\/:*?"<>|]/.test(generatedName)) {
      throw new Error('Generated export name is empty or contains invalid filename characters');
    }
    await this.activate();
    // A failed attempt may leave the verified Save panel open; reuse it rather
    // than opening another dialog behind it.
    let where = await this.exportSavePanelState().catch(() => 'no');
    if (where !== 'save-dialog') {
      await this.clickMenuItem('File', this.cfg.reason.exportMenuMatch);
    }
    // Reason exposes this as a separate AXDialog named "Save", not as a sheet
    // or a window with accessible text fields/buttons. Check that exact panel.
    for (let i = 0; i < 60 && where !== 'save-dialog'; i++) {
      await sleep(500);
      where = await this.exportSavePanelState().catch(() => 'no');
    }
    if (where !== 'save-dialog') {
      throw new Error('Reason’s native Save panel did not appear; no filename was entered');
    }
    let panel = null;
    try {
      panel = await this.readSavePanel();
      this.log(`Save panel read: folder="${panel.folderName || ''}", Save As="${panel.saveName || ''}", existing entry count=${(panel.fileNames || []).length}`);
    } catch (e) {
      this.log(`Save-panel Accessibility read failed: ${e.message}; will use the identified-panel fallback and verify the field before saving`);
    }
    const possibleOutputNames = [
      generatedName,
      `${generatedName}.aif`,
      `${generatedName}.aiff`,
      `${generatedName}.wav`,
      `${generatedName}.caf`,
    ].map(normalizedText);
    if ((panel?.fileNames || []).some((file) => possibleOutputNames.includes(normalizedText(file)))) {
      throw new Error('An export with this name already exists in the selected folder; no file was saved');
    }
    const existingMatches = await this.findExistingExports(generatedName);
    if (existingMatches.length) {
      throw new Error(`An audio export named “${generatedName}” already exists (${existingMatches.length} match${existingMatches.length === 1 ? '' : 'es'}); no file was saved`);
    }

    let namedPanel = panel?.saveName === generatedName ? panel : null;
    if (!namedPanel) {
      try {
        namedPanel = await this.writeSavePanelName(generatedName);
      } catch (e) {
        this.log(`Save-panel Accessibility name write failed for ${generatedName}: ${e.message}; trying the verified dialog typing path`);
      }
    }
    if (namedPanel?.saveName !== generatedName) {
      try {
        this.log(`Entering generated name through the positively identified Save dialog: ${generatedName}`);
        await this.enterExportFilename(generatedName);
      } catch (e) {
        this.log(`Save dialog typing fallback failed: ${e.message}`);
      }
      const reread = await this.readSavePanel().catch((e) => {
        this.log(`Save-panel name reread failed: ${e.message}`);
        return null;
      });
      if (reread?.saveName === generatedName) {
        namedPanel = reread;
      } else if (exportNameVisible(await readTextOnScreen(), generatedName)) {
        namedPanel = reread || panel || { folderName: '' };
        namedPanel.saveName = generatedName;
        this.log(`Generated name confirmed by full Save As OCR after Accessibility readback was unavailable`);
      } else {
        const actual = reread?.saveName || namedPanel?.saveName || '';
        this.log(`Generated-name verification failed: expected="${generatedName}", actual="${actual}"`);
        throw new Error(`Reason did not verify generated export name “${generatedName}” in Save As (read back “${actual || 'unavailable'}”); no file was saved`);
      }
    }
    this.log(`Save As verified for generated name: ${generatedName}; folder="${namedPanel?.folderName || panel?.folderName || ''}"`);
    await this.confirmExportSavePanel();

    // Wait for the Audio Export Settings dialog and click Export.
    let clicked = false;
    for (let i = 0; i < 20; i++) {
      await sleep(700);
      const out = await runAppleScript(`
tell application "System Events"
  tell process ${asQuote(this.proc)}
    repeat with w in windows
      try
        if exists button "Export" of w then
          click button "Export" of w
          return "clicked"
        end if
      end try
    end repeat
    return "waiting"
  end tell
end tell`, { timeoutMs: 15000 }).catch(() => 'waiting');
      if (out === 'clicked') { clicked = true; break; }
      const prog = await this.exportInProgress();
      if (prog) { clicked = true; break; }
    }
    if (!clicked) throw new Error('Audio Export Settings dialog never appeared after Save was confirmed');
    // Wait for Reason's progress dialog to disappear; it can pre-calculate for minutes.
    for (let i = 0; i < 1800; i++) {
      await sleep(1000);
      if (!(await this.exportInProgress())) {
        const exported = await this.verifyExportFile(generatedName);
        this.log(`completed export independently verified: path="${exported.path}", bytes=${exported.sizeBytes}, duration=${exported.durationSeconds}s`);
        return exported;
      }
    }
    throw new Error('Export still running after 30 minutes');
  }

  async exportInProgress() {
    try {
      const out = await runAppleScript(
        `tell application "System Events" to tell process ${asQuote(this.proc)} to exists (first window whose name is "Export Audio")`,
        { timeoutMs: 10000 }
      );
      return out === 'true';
    } catch {
      return false;
    }
  }
}

module.exports = {
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
};
