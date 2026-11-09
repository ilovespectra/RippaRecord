'use strict';
// Opens Reason's Preferences and dumps the UI elements of the window, to help
// tune the audio-device automation. Run while Reason is open:
//   npm run probe:prefs
const { runAppleScript } = require('../src/lib/applescript');
const config = require('../src/lib/config');

(async () => {
  const cfg = config.load();
  const proc = cfg.reason.processName;
  const script = `
tell application "System Events"
  tell process "${proc}"
    set frontmost to true
    keystroke "," using command down
    delay 1.5
    set prefWin to window 1
    set reportLines to {"window: " & (name of prefWin as string)}
    repeat with pb in (pop up buttons of prefWin)
      set end of reportLines to "popup value: " & (value of pb as string)
    end repeat
    repeat with st in (static texts of prefWin)
      set end of reportLines to "text: " & (value of st as string)
    end repeat
    set AppleScript's text item delimiters to linefeed
    return reportLines as string
  end tell
end tell`;
  try {
    console.log(await runAppleScript(script, { timeoutMs: 30000 }));
  } catch (e) {
    console.error('FAILED:', e.message);
  }
})();
