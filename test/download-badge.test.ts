import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { badgeJson, countPackageDownloads } from '../scripts/download-badge.mjs';

const asset = (name: string, download_count: number) => ({ name, download_count });

describe('countPackageDownloads', () => {
  it('counts installers, portable builds and mac packages but not update metadata', () => {
    const releases = [
      { assets: [
        asset('ajzakomator-Setup-0.5.8.exe', 3),
        asset('ajzakomator-Setup-0.5.8.exe.blockmap', 50),
        asset('ajzakomator-Portable-0.5.8.exe', 2),
        asset('ajzakomator-0.5.8-mac-arm64.dmg', 4),
        asset('ajzakomator-0.5.8-mac-arm64.zip', 1),
        asset('ajzakomator-0.5.8-mac-x64.dmg', 5),
        asset('latest.yml', 90),
        asset('latest-mac.yml', 7),
        asset('SHA256SUMS.txt', 9),
      ] },
      { assets: [asset('ajzakomator-Setup-0.5.7.exe', 1)] },
      { assets: undefined },
    ];
    expect(countPackageDownloads(releases)).toBe(3 + 2 + 4 + 1 + 5 + 1);
  });

  it('returns 0 for no releases and ignores broken counts', () => {
    expect(countPackageDownloads([])).toBe(0);
    expect(countPackageDownloads([{ assets: [{ name: 'ajzakomator-Setup-1.exe', download_count: null }] }])).toBe(0);
  });
});

describe('badgeJson', () => {
  it('matches the shields endpoint schema', () => {
    expect(badgeJson(13)).toEqual({ schemaVersion: 1, label: 'downloads', message: '13', color: 'f4f4f5', labelColor: '18181b' });
  });
});
