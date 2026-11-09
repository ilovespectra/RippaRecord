'use strict';

const { spawnSync } = require('node:child_process');

const OWNER = 'ilovespectra';
const REPO = 'rippa-record';

function requestGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  if (result.error || result.status !== 0) {
    throw new Error('GitHub preflight failed. Check that the local GitHub CLI is installed and authenticated.');
  }
  return String(result.stdout || '').trim();
}

function verifyReleaseOwner(run = requestGh) {
  const login = run(['api', 'user', '--jq', '.login']);
  if (login !== OWNER) {
    throw new Error('Release publishing is restricted to the official repository owner.');
  }

  let metadata;
  try {
    metadata = JSON.parse(run([
      'api', `repos/${OWNER}/${REPO}`,
      '--jq', '{full_name, permissions}',
    ]));
  } catch {
    throw new Error('GitHub returned invalid repository metadata; refusing release access.');
  }

  if (String(metadata.full_name || '').toLowerCase() !== `${OWNER}/${REPO}`.toLowerCase()) {
    throw new Error('The authenticated repository did not match the official Rippa Record repository.');
  }
  if (metadata.permissions?.admin !== true) {
    throw new Error('Release publishing requires admin permission on the official repository.');
  }
  return { owner: OWNER, repo: REPO, login, admin: true };
}

module.exports = { OWNER, REPO, verifyReleaseOwner };
