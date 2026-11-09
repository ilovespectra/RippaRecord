'use strict';
// Dumps Reason's Edit and File menu item names so we can pin down the exact
// wording for the Loop and Export steps. Run while Reason is open:
//   npm run probe:menus
const { runAppleScript } = require('../src/lib/applescript');
const config = require('../src/lib/config');

(async () => {
  const cfg = config.load();
  const proc = cfg.reason.processName;
  for (const menu of ['Edit', 'File', 'Options']) {
    try {
      const out = await runAppleScript(
        `tell application "System Events" to tell process "${proc}" to get name of menu items of menu "${menu}" of menu bar item "${menu}" of menu bar 1`
      );
      console.log(`\n=== ${menu} menu ===`);
      out.split(', ').forEach((n) => console.log(`  ${n === 'missing value' ? '---' : n}`));
    } catch (e) {
      console.error(`\n=== ${menu} menu === FAILED: ${String(e.message).split('\n')[0]}`);
    }
  }
})();
