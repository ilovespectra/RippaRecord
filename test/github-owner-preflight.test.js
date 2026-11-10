'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyReleaseOwner } = require('../dev-console/github-owner-preflight.cjs');

const ownerMetadata = JSON.stringify({
  full_name: 'ilovespectra/RippaRecord',
  permissions: { admin: true, push: true },
});

function stubGh(login, metadata = ownerMetadata) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      if (args[1] === 'user') return login;
      return metadata;
    },
  };
}

test('release preflight permits the official admin account without publishing', () => {
  const gh = stubGh('ilovespectra');
  assert.deepEqual(verifyReleaseOwner(gh.run), {
    owner: 'ilovespectra', repo: 'RippaRecord', login: 'ilovespectra', admin: true,
  });
  assert.equal(gh.calls.length, 2);
  assert.ok(gh.calls.every(args => args[0] === 'api'));
});

test('release preflight rejects another GitHub account before repository access', () => {
  const gh = stubGh('not-the-owner');
  assert.throws(() => verifyReleaseOwner(gh.run), /restricted to the official repository owner/);
  assert.equal(gh.calls.length, 1);
});

test('release preflight rejects a non-admin account', () => {
  const gh = stubGh('ilovespectra', JSON.stringify({
    full_name: 'ilovespectra/RippaRecord', permissions: { admin: false, push: true },
  }));
  assert.throws(() => verifyReleaseOwner(gh.run), /requires admin permission/);
});

test('release preflight rejects mismatched repository metadata', () => {
  const gh = stubGh('ilovespectra', JSON.stringify({
    full_name: 'someone-else/RippaRecord', permissions: { admin: true },
  }));
  assert.throws(() => verifyReleaseOwner(gh.run), /did not match the official Rippa Record repository/);
});
