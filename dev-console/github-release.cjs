'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { verifyReleaseOwner } = require('./github-owner-preflight.cjs');

const OWNER = 'ilovespectra';
const REPO = 'RippaRecord';
const APP = 'Rippa Record';
const root = path.resolve(__dirname, '..');

function command(program, args, { cwd = root, env = process.env, input, timeout = 120000 } = {}) {
  const result = spawnSync(program, args, {
    cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw new Error(`${program} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(-1500);
    throw new Error(`${program} ${args[0] || ''} failed${result.status == null ? '' : ` (exit ${result.status})`}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function resolveReleaseMode({ localOnly = false, checkOwner = verifyReleaseOwner } = {}) {
  if (localOnly) return { mode: 'local', reason: 'Local-only mode was requested.' };
  try {
    const access = checkOwner();
    return { mode: 'draft', access };
  } catch (error) {
    return { mode: 'local', reason: error.message || 'Owner publishing access could not be verified.' };
  }
}

function verifyMainCheckout({ run = command, allowedDirty = [] } = {}) {
  const branch = run('git', ['branch', '--show-current']);
  const remote = run('git', ['remote', 'get-url', 'origin']);
  const head = run('git', ['rev-parse', 'HEAD']);
  const remoteMain = run('git', ['rev-parse', 'origin/main']);
  if (branch !== 'main') throw new Error(`Draft uploads require the existing main branch; found ${branch || 'detached HEAD'}.`);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)ilovespectra\/RippaRecord(?:\.git)?$/i.test(remote)) {
    throw new Error('Draft uploads require the canonical ilovespectra/RippaRecord origin.');
  }
  if (head !== remoteMain) throw new Error('Draft uploads require main to match origin/main. Push the verified source commit first.');
  const changedFiles = [
    run('git', ['diff', '--name-only']),
    run('git', ['diff', '--cached', '--name-only']),
    run('git', ['ls-files', '--others', '--exclude-standard']),
  ].flatMap((output) => output.split(/\r?\n/).filter(Boolean));
  const unexpected = [...new Set(changedFiles)].filter((file) => !allowedDirty.includes(file));
  if (unexpected.length) throw new Error(`Draft uploads require a clean checkout; unrelated local edits remain: ${unexpected.join(', ')}.`);
  return { branch, head, remoteMain };
}

function sha256File(filename) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filename));
  return hash.digest('hex');
}

function verifyDraftRecord(record, version, files) {
  const tag = `v${version}`;
  if (!record || record.tag_name !== tag || record.name !== `${APP} ${version}` || record.draft !== true) {
    throw new Error(`GitHub did not confirm an unpublished ${tag} draft with the expected title.`);
  }
  const assets = new Map((record.assets || []).map((asset) => [asset.name, asset]));
  for (const file of files) {
    const asset = assets.get(path.basename(file.path));
    if (!asset) throw new Error(`GitHub draft is missing ${path.basename(file.path)}.`);
    if (asset.size !== fs.statSync(file.path).size) throw new Error(`GitHub draft asset size differs for ${asset.name}.`);
    if (asset.digest && asset.digest !== `sha256:${file.sha256}`) {
      throw new Error(`GitHub draft SHA-256 differs for ${asset.name}.`);
    }
    if (!asset.digest) throw new Error(`GitHub did not return a verifiable SHA-256 digest for ${asset.name}.`);
  }
  if (!record.html_url || !record.id) throw new Error('GitHub draft record is missing its review URL or release ID.');
  return {
    version, tag, draft: true,
    url: `https://github.com/${OWNER}/${REPO}/releases/edit/${record.id}`,
    assets: files.map((file) => ({ name: path.basename(file.path), sha256: file.sha256, size: fs.statSync(file.path).size })),
  };
}

function releaseRecord(tag, run = command) {
  const query = `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id,tag_name,name,draft,html_url,assets:[.assets[]|{name,size,digest}]}`;
  const raw = run('gh', ['api', `repos/${OWNER}/${REPO}/releases`, '--paginate', '--jq', query]);
  const records = raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (records.length > 1) throw new Error(`More than one GitHub release matches ${tag}; refusing to guess.`);
  return records[0] || null;
}

function tagExists(tag, run = command) {
  const result = spawnSync('gh', ['api', `repos/${OWNER}/${REPO}/git/ref/tags/${tag}`], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000,
  });
  if (result.error) throw new Error(`Could not inspect GitHub tag ${tag}: ${result.error.message}`);
  if (result.status === 0) return true;
  const message = `${result.stderr || ''} ${result.stdout || ''}`;
  if (/\b404\b|not found/i.test(message)) return false;
  throw new Error(`Could not verify whether GitHub tag ${tag} already exists.`);
}

function createOrUpdateDraft({ version, notesPath, files, run = command, inspectTag = tagExists, readRelease = releaseRecord, assertOwner = verifyReleaseOwner }) {
  const access = assertOwner();
  if (access.owner !== OWNER || access.repo !== REPO || access.admin !== true) {
    throw new Error('GitHub draft creation requires verified admin access to the canonical Rippa Record repository.');
  }
  const tag = `v${version}`;
  const title = `${APP} ${version}`;
  const current = readRelease(tag, run);
  if (current && current.draft !== true) throw new Error(`${tag} is already published; refusing to modify it.`);
  if (current && current.name !== title) throw new Error(`An unrelated draft already uses ${tag}; refusing to replace it.`);
  if (!current && inspectTag(tag, run)) throw new Error(`GitHub tag ${tag} already exists without a matching draft; refusing to reuse it.`);

  const assetPaths = files.map((file) => file.path);
  if (current) {
    run('gh', ['release', 'edit', tag, '--repo', `${OWNER}/${REPO}`, '--title', title, '--notes-file', notesPath]);
    run('gh', ['release', 'upload', tag, ...assetPaths, '--repo', `${OWNER}/${REPO}`, '--clobber']);
  } else {
    run('gh', ['release', 'create', tag, ...assetPaths, '--repo', `${OWNER}/${REPO}`, '--draft', '--title', title, '--notes-file', notesPath, '--target', 'main']);
  }

  const verified = readRelease(tag, run);
  return verifyDraftRecord(verified, version, files);
}

module.exports = {
  APP, OWNER, REPO, command, resolveReleaseMode, verifyMainCheckout,
  sha256File, verifyDraftRecord, releaseRecord, tagExists, createOrUpdateDraft,
};
