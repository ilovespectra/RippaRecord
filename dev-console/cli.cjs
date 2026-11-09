'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { verifyReleaseOwner } = require('./github-owner-preflight.cjs');

const root = path.resolve(__dirname, '..');
const packagePath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');

function nextVersion(version, action = 'next') {
  const match = String(version).match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error(`Expected a stable x.y.z version, got: ${version}`);
  if (!['next', 'patch'].includes(action)) throw new Error('Use next (or the legacy patch alias) for one rollover step.');
  let [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 9) return `${major + 1}.0.0`;
  if (patch > 9) return minor < 9 ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`;
  if (patch < 9) return `${major}.${minor}.${patch + 1}`;
  if (minor < 9) return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
}

async function main() {
  if (process.argv.includes('--owner-preflight')) {
    const access = verifyReleaseOwner();
    console.log(`Read-only release preflight passed for @${access.login}/${access.repo} (no upload performed).`);
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const appName = metadata.productName || metadata.name;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${appName} Developer Console · ${metadata.version}`);
    console.log('Runs tests, bumps the app version, then builds and installs the local macOS app.');
    console.log('It does not publish releases or configure in-app updates.');
    const action = (process.argv[2] || await rl.question('Version action (next / current): ')).trim().toLowerCase();
    const targetVersion = action === 'current' ? metadata.version : nextVersion(metadata.version, action);
    const answer = await rl.question(`Run tests and build ${appName} ${targetVersion}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('No changes made.');
      return;
    }

    run('npm', ['test']);
    const originalPackage = fs.readFileSync(packagePath, 'utf8');
    const originalLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
    try {
      metadata.version = targetVersion;
      fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
      if (originalLock) {
        const lock = JSON.parse(originalLock);
        lock.version = targetVersion;
        if (lock.packages && lock.packages['']) lock.packages[''].version = targetVersion;
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      }
      run('npm', ['run', 'package']);
    } catch (error) {
      fs.writeFileSync(packagePath, originalPackage);
      if (originalLock !== null) fs.writeFileSync(lockPath, originalLock);
      throw error;
    }
    if (process.env.RIPPA_STAGE_ONLY === '1') {
      console.log(`\nBuilt ${appName} ${targetVersion} as an isolated local candidate. It was not installed or published.`);
    } else {
      console.log(`\nBuilt ${appName} ${targetVersion}. The installed app is local only; release hosting is not configured.`);
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Developer Console stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main, nextVersion };
