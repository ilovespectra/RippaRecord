'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { verifyReleaseOwner } = require('./github-owner-preflight.cjs');
const {
  resolveReleaseMode, verifyMainCheckout, sha256File, createOrUpdateDraft,
  command: releaseCommand,
} = require('./github-release.cjs');

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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root, stdio: 'inherit', env: options.env || process.env,
    timeout: options.timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
}

function generateReleaseNotes(version, architecture, sourceCommit) {
  const env = { ...process.env, OLLAMA_HOST: '127.0.0.1:11434', OLLAMA_NO_CLOUD: '1' };
  const model = String(process.env.RIPPA_OLLAMA_MODEL || 'qwen2.5:3b').trim();
  const installed = releaseCommand('ollama', ['list'], { cwd: root, env, timeout: 15000 })
    .split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  if (!installed.some((name) => name === model || name === `${model}:latest`)) {
    throw new Error(`Local Ollama model ${model} is not installed; no release draft was created.`);
  }
  const prompt = [
    'Write concise Markdown release notes for a Rippa Record release using only the verified facts below.',
    'Do not invent features, bug fixes, improvements, compatibility, security claims, or dates.',
    'This package has no user-facing app changes beyond the version metadata; the developer-console release automation is not included in the app.',
    `Version: ${version}.`, `Platform: macOS ${architecture}.`,
    `Source commit: ${sourceCommit}.`,
    'Package: ZIP containing the staged macOS application and a separate SHA-256 checksum asset.',
    'Signing: locally signed; not notarized.',
    'Return a short heading and at most two factual bullets, with no preamble or invented claims.',
  ].join('\n');
  let notes = releaseCommand('ollama', ['run', model], { cwd: root, env, input: prompt, timeout: 180000 })
    .replace(/^```(?:markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!notes) throw new Error('Local Ollama returned empty release notes; no draft was created.');
  if (/\b(improv\w*|fix(?:ed|es)?|enhanc\w*|faster|security guarantee|new feature)\b/i.test(notes)) {
    throw new Error('Ollama release notes contain an unverified feature claim; no draft was created. Review the local model output and retry.');
  }
  if (!notes.includes(version)) notes = `# Rippa Record ${version}\n\n${notes}`;
  if (!/not\s+notarized/i.test(notes)) notes += '\n\n- This local-signing build is not notarized.';
  if (!/no user-facing app changes/i.test(notes)) notes += '\n\n- No user-facing app changes beyond the version metadata are included.';
  if (notes.length > 10000) throw new Error('Ollama release notes exceeded the safe 10 KB limit.');
  return { model, notes };
}

function prepareReleaseAssets(version, architecture, stageDirectory) {
  const appPath = path.join(stageDirectory, `Rippa Record-${version}.app`);
  if (!fs.existsSync(appPath)) throw new Error(`Staged app is missing: ${appPath}`);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const bundleVersion = releaseCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]);
  if (bundleVersion !== version) throw new Error(`Staged app reports ${bundleVersion}; expected ${version}.`);
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Rippa Record');
  const architectures = releaseCommand('/usr/bin/lipo', ['-archs', executable]).split(/\s+/);
  if (!architectures.includes(architecture)) throw new Error(`Staged app lacks the ${architecture} architecture.`);
  releaseCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);

  const releaseDirectory = path.join(root, 'dist', 'releases', `v${version}`);
  fs.mkdirSync(releaseDirectory, { recursive: true });
  const archive = path.join(releaseDirectory, `Rippa-Record-${version}-mac-${architecture}.zip`);
  if (!fs.existsSync(archive)) {
    releaseCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
  }
  releaseCommand('/usr/bin/unzip', ['-tq', archive]);
  const contents = releaseCommand('/usr/bin/unzip', ['-Z1', archive]);
  if (!contents.split(/\r?\n/).some((entry) => entry.endsWith(`Rippa Record-${version}.app/Contents/Info.plist`))) {
    throw new Error('The release ZIP does not contain the verified Rippa app bundle.');
  }
  const archiveHash = sha256File(archive);
  const checksumPath = `${archive}.sha256`;
  fs.writeFileSync(checksumPath, `${archiveHash}  ${path.basename(archive)}\n`, { mode: 0o644 });
  if (sha256File(archive) !== archiveHash || !fs.readFileSync(checksumPath, 'utf8').includes(archiveHash)) {
    throw new Error('Release archive checksum verification failed.');
  }
  return {
    appPath, archive, checksumPath, releaseDirectory,
    files: [
      { path: archive, sha256: archiveHash },
      { path: checksumPath, sha256: sha256File(checksumPath) },
    ],
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--owner-preflight')) {
    const access = verifyReleaseOwner();
    console.log(`Read-only release preflight passed for @${access.login}/${access.repo} (no upload performed).`);
    return;
  }

  const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const appName = metadata.productName || metadata.name;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${appName} Developer Console · ${metadata.version}`);
    const localOnly = args.includes('--local-only');
    let release = resolveReleaseMode({ localOnly });
    let checkout = null;
    if (release.mode === 'draft') {
      try {
        checkout = verifyMainCheckout();
        console.log(`Owner publishing access verified; a successful build will become an unpublished GitHub draft from ${checkout.head.slice(0, 12)}.`);
      } catch (error) {
        release = { mode: 'local', reason: error.message };
        console.log(`GitHub draft unavailable (${release.reason}); continuing with a local build.`);
      }
    } else {
      console.log(`Local-only build: ${release.reason || 'GitHub owner access is unavailable.'}`);
    }
    console.log(release.mode === 'draft'
      ? 'Runs tests, creates an isolated macOS package, verifies its checksum, and uploads a GitHub draft. It never publishes.'
      : 'Runs tests, bumps the app version, then builds and installs the local macOS app.');

    const actionArg = args.find((value) => ['next', 'patch', 'current'].includes(value));
    const action = (actionArg || await rl.question('Version action (next / current): ')).trim().toLowerCase();
    const targetVersion = action === 'current' ? metadata.version : nextVersion(metadata.version, action);
    const answer = await rl.question(`Run tests and build ${appName} ${targetVersion}? [y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('No changes made.');
      return;
    }

    run('npm', ['test']);
    const originalPackage = fs.readFileSync(packagePath, 'utf8');
    const originalLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null;
    const stageDirectory = path.join(root, 'dist', 'rippa-candidates', `v${targetVersion}`);
    const stagedApp = path.join(stageDirectory, `${appName}-${targetVersion}.app`);
    const stageExisted = fs.existsSync(stagedApp);
    let packageStarted = false;
    try {
      metadata.version = targetVersion;
      fs.writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
      if (originalLock) {
        const lock = JSON.parse(originalLock);
        lock.version = targetVersion;
        if (lock.packages && lock.packages['']) lock.packages[''].version = targetVersion;
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      }
      if (release.mode === 'draft') {
        if (!stageExisted) {
          packageStarted = true;
          run('npm', ['run', 'package'], {
            env: { ...process.env, RIPPA_STAGE_ONLY: '1', RIPPA_STAGE_DIR: stageDirectory },
          });
        } else {
          const existingVersion = releaseCommand('/usr/libexec/PlistBuddy', [
            '-c', 'Print :CFBundleShortVersionString', path.join(stagedApp, 'Contents', 'Info.plist'),
          ]);
          if (existingVersion !== targetVersion) throw new Error(`Existing checkpoint is ${existingVersion}, not ${targetVersion}; preserving it.`);
          console.log(`Reusing verified-version staged candidate ${stagedApp}.`);
        }
      } else {
        run('npm', ['run', 'package'], { env: process.env });
      }
    } catch (error) {
      fs.writeFileSync(packagePath, originalPackage);
      if (originalLock !== null) fs.writeFileSync(lockPath, originalLock);
      if (packageStarted && fs.existsSync(stageDirectory)) fs.rmSync(stageDirectory, { recursive: true, force: true });
      throw error;
    }

    if (release.mode !== 'draft') {
      if (process.env.RIPPA_STAGE_ONLY === '1') {
        console.log(`\nBuilt ${appName} ${targetVersion} as an isolated local candidate. It was not installed or published.`);
      } else {
        console.log(`\nBuilt ${appName} ${targetVersion} locally. No GitHub release was created.`);
      }
      return;
    }

    // Only the two version metadata files may be dirty at this point; the source commit remains pushed main.
    verifyMainCheckout({ allowedDirty: ['package.json', 'package-lock.json'] });
    const architecture = process.arch;
    const built = prepareReleaseAssets(targetVersion, architecture, stageDirectory);
    const notes = generateReleaseNotes(targetVersion, architecture, checkout.head);
    const notesPath = path.join(built.releaseDirectory, 'release-notes.md');
    fs.writeFileSync(notesPath, `${notes.notes.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
    console.log(`\nOllama (${notes.model}) drafted factual notes:\n${notes.notes}\n`);
    const draft = createOrUpdateDraft({ version: targetVersion, notesPath, files: built.files });
    console.log(`GitHub draft verified and remains unpublished: ${draft.url}`);
    console.log(`Verified assets: ${draft.assets.map((asset) => `${asset.name} (${asset.sha256})`).join('; ')}`);
    console.log('Review and publish the draft manually; no public release was published.');
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
