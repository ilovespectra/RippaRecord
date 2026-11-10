'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const script = fs.readFileSync(path.join(__dirname, '../rippa-record-site/releases.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../rippa-record-site/index.html'), 'utf8');

async function render(releases, { responseOk = true } = {}) {
  const elements = {
    'release-count': { textContent: '', href: '' },
    'release-count-status': { textContent: '' },
    'latest-version': { textContent: '' },
  };
  const warnings = [];
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    fetch: async (url) => { requests.push(url); return { ok: responseOk, status: responseOk ? 200 : 503, json: async () => releases }; },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(script, context);
  await new Promise(setImmediate);
  return { elements, warnings, requests };
}

test('landing page shows the newest published release and counts only installer assets', async () => {
  const { elements, requests } = await render([
    { tag_name: 'v0.1.4', name: 'Rippa Record 0.1.4', html_url: 'https://github.com/ilovespectra/RippaRecord/releases/tag/v0.1.4', draft: false, prerelease: false,
      assets: [{ name: 'Rippa-Record-0.1.4.dmg', download_count: 7 }, { name: 'notes.txt', download_count: 90 }] },
    { tag_name: 'v0.1.3', name: 'Rippa Record 0.1.3', html_url: 'https://github.com/ilovespectra/RippaRecord/releases/tag/v0.1.3', draft: false, prerelease: false,
      assets: [{ name: 'Rippa-Record-0.1.3.zip', download_count: 4 }] },
    { tag_name: 'v0.1.5-draft', draft: true, assets: [{ name: 'draft.dmg', download_count: 100 }] },
  ]);
  assert.equal(elements['latest-version'].textContent, 'Latest published version: v0.1.4');
  assert.equal(elements['release-count'].textContent, '11 installer downloads on GitHub ↗');
  assert.equal(elements['release-count-status'].textContent, 'Total installer-asset downloads across published Rippa Record GitHub releases.');
  assert.equal(requests[0], 'https://api.github.com/repos/ilovespectra/RippaRecord/releases?per_page=100&page=1');
  assert.equal(elements['release-count'].href, 'https://github.com/ilovespectra/RippaRecord/releases');
});

test('landing page declares the canonical site and source URLs', () => {
  assert.match(page, /<link rel="canonical" href="https:\/\/ripparecord\.kolektivkrog\.si\/">/);
  assert.match(page, /https:\/\/github\.com\/ilovespectra\/RippaRecord/);
});

test('landing page stays accurate when there are no published releases', async () => {
  const { elements } = await render([]);
  assert.equal(elements['latest-version'].textContent, 'No public release version yet.');
  assert.equal(elements['release-count'].textContent, '0 installer downloads on GitHub ↗');
  assert.match(elements['release-count-status'].textContent, /No published Rippa Record GitHub release assets yet/);
});

test('landing page reports version and counter unavailable when GitHub fails', async () => {
  const { elements, warnings } = await render([], { responseOk: false });
  assert.equal(elements['latest-version'].textContent, 'Published version unavailable.');
  assert.equal(elements['release-count'].textContent, 'Download count unavailable — view GitHub releases ↗');
  assert.equal(warnings.length, 1);
});
