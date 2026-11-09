'use strict';

const { main, nextVersion } = require('../dev-console/cli.cjs');

if (require.main === module) {
  main().catch((error) => {
    console.error(`Developer Console stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, nextVersion };
