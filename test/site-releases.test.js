'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const script = fs.readFileSync(path.join(__dirname, '../rippa-record-site/releases.js'), 'utf8');
const page = fs.readFileSync(path.join(__dirname, '../rippa-record-site/index.html'), 'utf8');

async function render(releases, { responseOk = true, storage = new Map() } = {}) {
  const elements = {
    'release-count': { textContent: '', href: '' },
    'release-count-status': { textContent: '' },
    'latest-version': { textContent: '' },
  };
  const warnings = [];
  const requests = [];
  const context = vm.createContext({
    document: { getElementById: (id) => elements[id] },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    fetch: async (url) => { requests.push(url); return { ok: responseOk, status: responseOk ? 200 : 503, json: async () => releases }; },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(script, context);
  await new Promise(setImmediate);
  return { elements, warnings, requests, storage };
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
  assert.equal(elements['release-count-status'].textContent, 'Total downloads of app installer files across published Rippa Record GitHub releases; not unique users or installs.');
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
  assert.match(elements['release-count-status'].textContent, /No published Rippa Record installer assets yet; drafts are not included/);
});

test('reuses a fresh cache and shows the last successful total if GitHub fails', async () => {
  const first = await render([
    { tag_name: 'v0.1.4', draft: false, assets: [{ name: 'Rippa-Record-0.1.4.dmg', download_count: 6 }] },
  ]);
  assert.equal(first.elements['release-count'].textContent, '6 installer downloads on GitHub ↗');
  assert.equal(first.requests.length, 1);

  const cached = await render([], { responseOk: false, storage: first.storage });
  assert.equal(cached.elements['release-count'].textContent, '6 installer downloads on GitHub ↗');
  assert.equal(cached.requests.length, 0);

  const key = 'rippa-record:ilovespectra:RippaRecord:installer-downloads:v1';
  const staleData = JSON.parse(first.storage.get(key));
  staleData.savedAt = Date.now() - 10 * 60 * 1000;
  first.storage.set(key, JSON.stringify(staleData));
  const stale = await render([], { responseOk: false, storage: first.storage });
  assert.match(stale.elements['release-count'].textContent, /6 installer downloads.*last checked \d+ min ago/);
  assert.match(stale.elements['release-count-status'].textContent, /GitHub is unavailable/);
});

test('landing page reports version and counter unavailable when GitHub fails', async () => {
  const { elements, warnings } = await render([], { responseOk: false });
  assert.equal(elements['latest-version'].textContent, 'Published version unavailable.');
  assert.equal(elements['release-count'].textContent, 'Download count unavailable — view GitHub releases ↗');
  assert.equal(warnings.length, 1);
});
