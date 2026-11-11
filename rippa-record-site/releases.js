(() => {
  const owner = 'ilovespectra';
  const repo = 'RippaRecord';
  const count = document.getElementById('release-count');
  const status = document.getElementById('release-count-status');
  const latestVersion = document.getElementById('latest-version');
  const releasesPage = `https://github.com/${owner}/${repo}/releases`;
  count.href = releasesPage;
  const format = value => new Intl.NumberFormat().format(value);

  const cacheKey = `rippa-record:${owner}:${repo}:installer-downloads:v1`;
  const cacheTtlMs = 5 * 60 * 1000;
  function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
      if (cached && Number.isSafeInteger(cached.total) && cached.total >= 0
          && Number.isSafeInteger(cached.publishedReleaseCount) && cached.publishedReleaseCount >= 0
          && typeof cached.latestVersion === 'string'
          && Number.isFinite(cached.savedAt) && cached.savedAt > 0 && cached.savedAt <= Date.now()) return cached;
    } catch {}
    return null;
  }
  function cacheAge(savedAt) {
    const minutes = Math.max(0, Math.floor((Date.now() - savedAt) / 60000));
    return minutes < 1 ? 'under a minute' : `${minutes} min`;
  }
  function renderSummary(summary, state = 'fresh') {
    const age = cacheAge(summary.savedAt);
    count.textContent = `${format(summary.total)} installer downloads on GitHub ↗${state === 'stale' ? ` · last checked ${age} ago` : ''}`;
    status.textContent = state === 'stale'
      ? `GitHub is unavailable; showing the last successful total, checked ${age} ago. This is a download count, not a user or install count.`
      : summary.publishedReleaseCount
        ? 'Total downloads of app installer files across published Rippa Record GitHub releases; not unique users or installs.'
        : 'No published Rippa Record installer assets yet; drafts are not included. This counter updates when a release is published.';
    latestVersion.textContent = summary.latestVersion || 'No public release version yet.';
  }

  async function loadInstallerDownloads() {
    const cached = readCache();
    if (cached && Date.now() - cached.savedAt < cacheTtlMs) {
      renderSummary(cached);
      return;
    }
    if (cached) {
      count.textContent = `${format(cached.total)} installer downloads on GitHub ↗ · refreshing`;
      status.textContent = `Last successful GitHub check was ${cacheAge(cached.savedAt)} ago; refreshing the public release total.`;
    }

    try {
      let total = 0;
      let publishedReleaseCount = 0;
      let latestPublishedRelease = null;
      for (let page = 1; ; page += 1) {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100&page=${page}`, {
          headers: { Accept: 'application/vnd.github+json' },
        });
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const releases = await response.json();
        if (!Array.isArray(releases)) throw new Error('Invalid GitHub release list');
        for (const release of releases) {
          if (release.draft || !Array.isArray(release.assets)) continue;
          if (!latestPublishedRelease) latestPublishedRelease = release;
          publishedReleaseCount += 1;
          for (const asset of release.assets) {
            if (!/\.(dmg|pkg|zip|exe|msi|appimage|deb|rpm|tar\.gz)$/i.test(asset.name || '')) continue;
            if (!Number.isSafeInteger(asset.download_count) || asset.download_count < 0) throw new Error('Invalid release asset download count');
            total += asset.download_count;
            if (!Number.isSafeInteger(total)) throw new Error('Installer download total is too large');
          }
        }
        if (releases.length < 100) break;
      }
      const summary = {
        total,
        publishedReleaseCount,
        latestVersion: latestPublishedRelease
          ? `Latest published version: ${latestPublishedRelease.tag_name || latestPublishedRelease.name || 'untagged release'}`
          : '',
        savedAt: Date.now(),
      };
      try { localStorage.setItem(cacheKey, JSON.stringify(summary)); } catch {}
      renderSummary(summary);
    } catch (error) {
      if (cached) renderSummary(cached, 'stale');
      else {
        count.textContent = 'Download count unavailable — view GitHub releases ↗';
        status.textContent = 'GitHub did not return a complete public release list, so no total is guessed.';
        latestVersion.textContent = 'Published version unavailable.';
      }
      console.warn('Rippa Record GitHub release count failed:', error);
    }
  }

  loadInstallerDownloads();
})();
