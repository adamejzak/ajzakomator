import { describe, expect, it } from 'vitest';
import { isTrustedUpdateUrl, MAC_FEED_URL, macAssetBase, parseLatestMacYml, selectMacAsset } from '../src/main/macUpdate/feed';
import { compareVersions } from '../src/main/startupGate';

/** The real latest-mac.yml of release 0.6.5: base64 hashes are folded onto their own line by electron-builder. */
const FEED = `version: 0.6.5
files:
  - url: ajzakomator-0.6.5-mac-x64.zip
    sha512: >-
      EEAVct4YfgdfjvREA5LoRlH7ugkyfLeYG31Ac62bW1J7XdtujcaKqYuvbKnLyeAclow6VHvrSOn8vMfkpVo4bg==
    size: 139957940
  - url: ajzakomator-0.6.5-mac-x64.dmg
    sha512: >-
      caxxp8h1eaahlr51EIGCt8kimQS/kiCWGlMdahRc4+ssdgjtcr0xZPHOtGpzWy2SFwp9llpomUSW1YdAY/HQpA==
    size: 138337654
  - url: ajzakomator-0.6.5-mac-arm64.zip
    sha512: >-
      iiAalEqRVdFvRqRtfE9YKI20pqKhZb/QDtIVTJFX28RQMDnWNlJx4HPiWQG0KQsZHT1TznvJjHWGE+ZLiaTDBQ==
    size: 134273891
  - url: ajzakomator-0.6.5-mac-arm64.dmg
    sha512: >-
      NozzCYb/0Iol4IcGjfZZoE/jMJxYzyPg23Z0ilX+F/3duFPNQsJSijrey+//YmhN8Wp8A0uCJw43UHt7sus3LA==
    size: 132700616
path: ajzakomator-0.6.5-mac-x64.zip
sha512: >-
  EEAVct4YfgdfjvREA5LoRlH7ugkyfLeYG31Ac62bW1J7XdtujcaKqYuvbKnLyeAclow6VHvrSOn8vMfkpVo4bg==
releaseDate: '2026-10-12T18:08:47.228Z'
`;

describe('latest-mac.yml parsing', () => {
  it('reads the version and every file with its folded sha512', () => {
    const feed = parseLatestMacYml(FEED);
    expect(feed.version).toBe('0.6.5');
    expect(feed.files).toHaveLength(4);
    expect(feed.files[2]).toEqual({
      name: 'ajzakomator-0.6.5-mac-arm64.zip',
      sha512: 'iiAalEqRVdFvRqRtfE9YKI20pqKhZb/QDtIVTJFX28RQMDnWNlJx4HPiWQG0KQsZHT1TznvJjHWGE+ZLiaTDBQ==',
      size: 134273891,
    });
  });
  it('accepts CRLF, plain and quoted scalars', () => {
    const feed = parseLatestMacYml(`version: "1.2.3"\r\nfiles:\r\n  - url: 'app-1.2.3-mac-arm64.zip'\r\n    sha512: abc==\r\n    size: 10\r\n`);
    expect(feed).toEqual({ version: '1.2.3', files: [{ name: 'app-1.2.3-mac-arm64.zip', sha512: 'abc==', size: 10 }] });
  });
  it('skips incomplete entries and rejects a feed without a valid version', () => {
    const feed = parseLatestMacYml(`version: 1.0.0\nfiles:\n  - url: a.zip\n    size: 5\n  - url: b.zip\n    sha512: x\n    size: notanumber\n  - url: c.zip\n    sha512: y\n    size: 7\n`);
    expect(feed.files).toEqual([{ name: 'c.zip', sha512: 'y', size: 7 }]);
    expect(() => parseLatestMacYml('files:\n  - url: a.zip\n')).toThrow();
    expect(() => parseLatestMacYml('version: latest\n')).toThrow();
    expect(() => parseLatestMacYml('')).toThrow();
  });
});

describe('asset selection', () => {
  const feed = parseLatestMacYml(FEED);
  it('picks the zip of the running architecture, never the dmg or the other architecture', () => {
    expect(selectMacAsset(feed, 'arm64')?.name).toBe('ajzakomator-0.6.5-mac-arm64.zip');
    expect(selectMacAsset(feed, 'x64')?.name).toBe('ajzakomator-0.6.5-mac-x64.zip');
    expect(selectMacAsset(feed, 'x64')?.size).toBe(139957940);
  });
  it('has nothing for other architectures or a feed without that zip', () => {
    expect(selectMacAsset(feed, 'ia32')).toBeUndefined();
    expect(selectMacAsset({ version: '0.6.5', files: feed.files.filter((file) => !file.name.includes('arm64')) }, 'arm64')).toBeUndefined();
  });
  it('refuses file names that are not plain archive names (no paths, no other hosts)', () => {
    const hostile = (name: string) => selectMacAsset({ version: '1.0.0', files: [{ name, sha512: 'x', size: 1 }] }, 'arm64');
    expect(hostile('../evil-1.0.0-mac-arm64.zip')).toBeUndefined();
    expect(hostile('https://example.com/a-1.0.0-mac-arm64.zip')).toBeUndefined();
    expect(hostile('sub/a-1.0.0-mac-arm64.zip')).toBeUndefined();
    expect(hostile('a-1.0.0-mac-arm64.zip')?.name).toBe('a-1.0.0-mac-arm64.zip');
    // The file must belong to the announced version.
    expect(hostile('a-0.9.0-mac-arm64.zip')).toBeUndefined();
  });
  it('points at the GitHub release of the announced version', () => {
    expect(MAC_FEED_URL).toBe('https://github.com/adamejzak/ajzakomator/releases/latest/download/latest-mac.yml');
    expect(new URL('ajzakomator-0.6.5-mac-arm64.zip', macAssetBase('0.6.5')).href)
      .toBe('https://github.com/adamejzak/ajzakomator/releases/download/v0.6.5/ajzakomator-0.6.5-mac-arm64.zip');
  });
});

describe('isTrustedUpdateUrl', () => {
  it('accepts https GitHub hosts only', () => {
    expect(isTrustedUpdateUrl(MAC_FEED_URL)).toBe(true);
    expect(isTrustedUpdateUrl('https://objects.githubusercontent.com/a')).toBe(true);
    expect(isTrustedUpdateUrl('https://release-assets.githubusercontent.com/a')).toBe(true);
    for (const bad of ['http://github.com/a', 'https://githubusercontent.com/a', 'https://evilgithubusercontent.com/a', 'https://github.com.evil.example/a', 'https://github.com:444/a', 'https://u:p@github.com/a', 'ftp://github.com/a', 'not a url', '']) expect(isTrustedUpdateUrl(bad), bad).toBe(false);
  });
  it('allows extra origins (development feed) exactly', () => {
    expect(isTrustedUpdateUrl('http://localhost:8080/latest-mac.yml', ['http://localhost:8080'])).toBe(true);
    expect(isTrustedUpdateUrl('http://localhost:9999/latest-mac.yml', ['http://localhost:8080'])).toBe(false);
  });
});

describe('version comparison used for the offer', () => {
  it('offers only strictly newer versions', () => {
    expect(compareVersions('0.6.6', '0.6.5')).toBeGreaterThan(0);
    expect(compareVersions('0.6.5', '0.6.5')).toBe(0);
    expect(compareVersions('0.6.4', '0.6.5')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
  });
});
