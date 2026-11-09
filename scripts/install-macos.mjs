import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

if (process.platform !== 'darwin') {
  throw new Error('Rippa Record requires macOS.');
}

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const appName = 'Rippa Record';
const appId = 'com.rippa.record';
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stageOnly = process.env.RIPPA_STAGE_ONLY === '1';
const stageDir = path.resolve(process.env.RIPPA_STAGE_DIR || path.join(root, 'dist-candidates'));
const destination = stageOnly
  ? path.join(stageDir, `${appName}-${metadata.version}.app`)
  : path.join(os.homedir(), 'Applications', `${appName}.app`);
if (stageOnly && fs.existsSync(destination)) {
  throw new Error(`Refusing to overwrite existing staged candidate: ${destination}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rippa-record-install-'));

try {
  const [build] = await packager({
    dir: root,
    name: appName,
    executableName: appName,
    appBundleId: appId,
    appCategoryType: 'public.app-category.music',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: require('electron/package.json').version,
    electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
    icon: path.join(root, 'src', 'assets', 'rippa-record.icns'),
    out: temporary,
    asar: true,
    extraResource: [
      path.join(root, 'src', 'lib', 'set-device-volume.swift'),
      path.join(root, 'src', 'lib', 'save-panel-accessibility.swift'),
      path.join(root, 'src', 'lib', 'reason-window-info.swift'),
    ],
    ignore: [
      /^\/(?:scripts|test|tools|dev-console|rippa-record-site)(?:\/|$)/,
      /^\/config\.json$/,
    ],
    extendInfo: {
      LSUIElement: true,
      CFBundleIconFile: 'RippaRecord.icns',
      NSAppleEventsUsageDescription: 'Rippa Record controls Reason and music playback to record and export your session.',
    },
  });
  const builtApp = path.join(build, `${appName}.app`);
  let signingIdentity = process.env.RIPPA_CODESIGN_IDENTITY;
  if (!signingIdentity) {
    try {
      const identities = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const localIdentity = 'Rippa Record Local Signing';
      signingIdentity = identities.split('\n').some(line => line.includes(localIdentity))
        ? localIdentity
        : '-';
    } catch {
      signingIdentity = '-';
    }
  }
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', signingIdentity, builtApp], { stdio: 'inherit' });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync('/usr/bin/ditto', [builtApp, destination]);
  if (stageOnly) {
    console.log(`Staged isolated candidate ${destination}`);
  } else {
    execFileSync(
      '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
      ['-f', destination],
    );
    console.log(`Installed ${destination}`);
    console.log('The app icon is a red recording dot; the menu bar shows one red dot when active and one outline when idle.');
    console.log('Choose Start Recording from its dropdown to begin automation.');
    console.log('The menu stays idle between recordings. No VS Code or Apple Shortcuts is needed.');
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
