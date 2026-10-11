// Builds the JSON for a shields.io "endpoint" badge that counts only real package downloads.
// GitHub's own counter adds latest.yml (fetched by every update check) and .blockmap files, which inflates it.
// Usage: node scripts/download-badge.mjs <owner/repo> <output.json>   (needs GH_TOKEN for the API, or works unauthenticated)
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PACKAGE_PATTERN = /^ajzakomator-(Setup-.+\.exe|Portable-.+\.exe|.+-mac-(arm64|x64)\.(dmg|zip))$/;

/** Sums download_count of the installer and portable packages over all releases. */
export function countPackageDownloads(releases) {
  let total = 0;
  for (const release of releases) {
    for (const asset of release.assets ?? []) {
      if (PACKAGE_PATTERN.test(asset.name) && Number.isFinite(asset.download_count)) total += asset.download_count;
    }
  }
  return total;
}

export function badgeJson(total) {
  return { schemaVersion: 1, label: 'downloads', message: String(total), color: 'f4f4f5', labelColor: '18181b' };
}

async function fetchReleases(repository) {
  const releases = [];
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ajzakomator-badge' };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  for (let page = 1; page < 20; page++) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub API answered ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [repository, output] = process.argv.slice(2);
  if (!repository || !output) throw new Error('usage: node scripts/download-badge.mjs <owner/repo> <output.json>');
  const total = countPackageDownloads(await fetchReleases(repository));
  writeFileSync(output, JSON.stringify(badgeJson(total)) + '\n');
  console.log(`package downloads: ${total}`);
}
