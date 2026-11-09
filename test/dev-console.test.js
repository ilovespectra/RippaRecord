'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { nextVersion } = require('../dev-console/cli.cjs');

test('developer console increments stable patch, minor, and major versions', () => {
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.0', 'minor'), '0.2.0');
  assert.equal(nextVersion('0.1.0', 'major'), '1.0.0');
});

test('developer console rejects malformed versions and bump levels', () => {
  assert.throws(() => nextVersion('0.1', 'patch'), /stable x.y.z/);
  assert.throws(() => nextVersion('0.1.0', 'preview'), /Unknown version bump/);
});
