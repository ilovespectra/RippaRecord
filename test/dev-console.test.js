'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { nextVersion } = require('../dev-console/cli.cjs');

test('developer console rolls decimal version digits forward', () => {
  assert.equal(nextVersion('0.1.0'), '0.1.1');
  assert.equal(nextVersion('1.0.8'), '1.0.9');
  assert.equal(nextVersion('1.0.9'), '1.1.0');
  assert.equal(nextVersion('1.9.9'), '2.0.0');
  assert.equal(nextVersion('1.0.13'), '1.1.0');
});

test('developer console rejects malformed versions and non-rollover actions', () => {
  assert.throws(() => nextVersion('0.1'), /stable x.y.z/);
  assert.throws(() => nextVersion('0.1.0', 'major'), /one rollover step/);
});
