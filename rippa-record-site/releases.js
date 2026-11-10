(() => {
  const owner = 'ilovespectra';
  const repo = 'RippaRecord';
  const count = document.getElementById('release-count');
  const status = document.getElementById('release-count-status');
  const latestVersion = document.getElementById('latest-version');
  const releasesPage = `https://github.com/${owner}/${repo}/releases`;
  count.href = releasesPage;
  const format = value => new Intl.NumberFormat().format(value);

  async function loadInstallerDownloads() {
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
        }
      }
      if (releases.length < 100) break;
    }
    count.textContent = `${format(total)} installer downloads on GitHub ↗`;
    status.textContent = publishedReleaseCount
      ? 'Total installer-asset downloads across published Rippa Record GitHub releases.'
      : 'No published Rippa Record GitHub release assets yet; this counter will update when they are published.';
    latestVersion.textContent = latestPublishedRelease
      ? `Latest published version: ${latestPublishedRelease.tag_name || latestPublishedRelease.name || 'untagged release'}`
      : 'No public release version yet.';
  }

  loadInstallerDownloads().catch(error => {
    count.textContent = 'Download count unavailable — view GitHub releases ↗';
    status.textContent = 'GitHub did not return a complete public release list, so no total is guessed.';
    latestVersion.textContent = 'Published version unavailable.';
    console.warn('Rippa Record GitHub release count failed:', error);
  });
})();
