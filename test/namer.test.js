'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sanitize, timestamp } = require('../src/lib/namer');

test('session export names include seconds to reduce same-minute collisions', () => {
  assert.equal(timestamp(new Date(2026, 10, 7, 11, 54, 23)), '2026-11-07_11.54.23');
});

test('generated name components are safe for Reason export filenames', () => {
  assert.equal(sanitize('Sunday Jazz Mix'), 'sunday-jazz-mix');
  assert.equal(sanitize('jazz / live'), 'jazz-live');
});
