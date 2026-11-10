'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveReleaseMode, verifyMainCheckout, sha256File, verifyDraftRecord, createOrUpdateDraft,
} = require('../dev-console/github-release.cjs');
const ownerAccess = () => ({ owner: 'ilovespectra', repo: 'RippaRecord', admin: true });

function makeFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rippa-release-test-'));
  const archive = path.join(dir, 'Rippa-Record-0.1.5-mac-arm64.zip');
  const checksum = path.join(dir, `${path.basename(archive)}.sha256`);
  const notes = path.join(dir, 'release-notes.md');
  fs.writeFileSync(archive, 'verified test package');
  const digest = sha256File(archive);
  fs.writeFileSync(checksum, `${digest}  ${path.basename(archive)}\n`);
  fs.writeFileSync(notes, '# Rippa Record 0.1.5\n');
  return { dir, archive, checksum, notes, digest, files: [
    { path: archive, sha256: digest },
    { path: checksum, sha256: sha256File(checksum) },
  ] };
}

function recordFor(f, overrides = {}) {
  return {
    id: 73, tag_name: 'v0.1.5', name: 'Rippa Record 0.1.5', draft: true,
    html_url: 'https://github.com/ilovespectra/RippaRecord/releases/tag/v0.1.5',
    assets: f.files.map((item) => ({
      name: path.basename(item.path), size: fs.statSync(item.path).size,
      digest: `sha256:${item.sha256}`,
    })),
    ...overrides,
  };
}

test('owner access selects draft; unavailable or non-owner access stays local', () => {
  assert.equal(resolveReleaseMode({ checkOwner: () => ({ login: 'ilovespectra' }) }).mode, 'draft');
  assert.deepEqual(resolveReleaseMode({ checkOwner: () => { throw new Error('not the owner'); } }), {
    mode: 'local', reason: 'not the owner',
  });
  let checked = false;
  assert.equal(resolveReleaseMode({ localOnly: true, checkOwner: () => { checked = true; } }).mode, 'local');
  assert.equal(checked, false);
});

test('main checkout preflight permits only the console version metadata changes', () => {
  const outputs = new Map([
    ['branch --show-current', 'main'],
    ['remote get-url origin', 'https://github.com/ilovespectra/RippaRecord.git'],
    ['rev-parse HEAD', 'a'.repeat(40)],
    ['rev-parse origin/main', 'a'.repeat(40)],
    ['diff --name-only', 'package.json\npackage-lock.json'],
    ['diff --cached --name-only', ''],
    ['ls-files --others --exclude-standard', ''],
  ]);
  const run = (_program, args) => outputs.get(args.join(' ')) ?? '';
  assert.equal(verifyMainCheckout({ run, allowedDirty: ['package.json', 'package-lock.json'] }).branch, 'main');
  outputs.set('diff --name-only', 'README.md\npackage.json');
  assert.throws(() => verifyMainCheckout({ run, allowedDirty: ['package.json', 'package-lock.json'] }), /unrelated local edits remain: README.md/);
});

test('remote draft verification requires exact version, asset sizes, and SHA-256 digests', () => {
  const f = makeFiles();
  try {
    assert.equal(verifyDraftRecord(recordFor(f), '0.1.5', f.files).draft, true);
    assert.throws(() => verifyDraftRecord(recordFor(f, { draft: false }), '0.1.5', f.files), /unpublished/);
    const wrong = recordFor(f);
    wrong.assets[0].digest = 'sha256:' + '0'.repeat(64);
    assert.throws(() => verifyDraftRecord(wrong, '0.1.5', f.files), /SHA-256 differs/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('new release operation creates a draft on main and verifies both assets', () => {
  const f = makeFiles();
  try {
    let created = false;
    const calls = [];
    const run = (_program, args) => {
      calls.push(args);
      if (args[0] === 'api') return created ? JSON.stringify(recordFor(f)) : '';
      if (args[0] === 'release' && args[1] === 'create') { created = true; return ''; }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };
    const result = createOrUpdateDraft({
      version: '0.1.5', notesPath: f.notes, files: f.files, run, inspectTag: () => false, assertOwner: ownerAccess,
    });
    assert.equal(result.draft, true);
    assert.equal(result.assets.length, 2);
    const create = calls.find((args) => args[0] === 'release' && args[1] === 'create');
    assert.ok(create.includes('--draft'));
    assert.ok(create.includes('--target') && create.includes('main'));
    assert.ok(!create.includes('--publish'));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('existing draft is updated; published or unrelated releases are preserved', () => {
  const f = makeFiles();
  try {
    let current = recordFor(f);
    const calls = [];
    const run = (_program, args) => { calls.push(args); return ''; };
    const readRelease = () => current;
    const result = createOrUpdateDraft({ version: '0.1.5', notesPath: f.notes, files: f.files, run, readRelease, assertOwner: ownerAccess });
    assert.equal(result.draft, true);
    assert.ok(calls.some((args) => args[0] === 'release' && args[1] === 'edit'));
    assert.ok(calls.some((args) => args[0] === 'release' && args[1] === 'upload' && args.includes('--clobber')));

    calls.length = 0;
    current = recordFor(f, { draft: false });
    assert.throws(() => createOrUpdateDraft({ version: '0.1.5', notesPath: f.notes, files: f.files, run, readRelease, assertOwner: ownerAccess }), /already published/);
    assert.equal(calls.length, 0);
    current = recordFor(f, { name: 'Other release' });
    assert.throws(() => createOrUpdateDraft({ version: '0.1.5', notesPath: f.notes, files: f.files, run, readRelease, assertOwner: ownerAccess }), /unrelated draft/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
