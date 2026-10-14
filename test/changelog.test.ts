import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChangelog } from '../src/main/changelog';
import { cleanReleaseNotes, compareVersions, parseInline, parseNotes, parseReleases } from '../src/shared/changelog';

const GUIDE = '\n\n## Which download should I choose?\n\nChoose from the assets attached to this release.\n';
const release = (tag: string, body: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, name: `unimux ${tag.slice(1)}`, published_at: '2026-10-10T12:00:00Z', html_url: `https://example.test/${tag}`, body, draft: false, prerelease: false, ...extra,
});

describe('release notes', () => {
  it('removes the title, the download guide and housekeeping lines', () => {
    const body = `# unimux 0.5.4\n\n- Added a window.\n- Fixed a bug.\n\nValidated with unit tests.${GUIDE}`;
    expect(cleanReleaseNotes(body)).toBe('- Added a window.\n- Fixed a bug.');
    expect(cleanReleaseNotes(`New status bar.\n\nWindows packages for unimux 0.5.5.${GUIDE}`)).toBe('New status bar.');
    expect(cleanReleaseNotes(`# ajzakomator 0.5.4\n\n- Legacy release.\n\nWindows packages for ajzakomator 0.5.4.${GUIDE}`)).toBe('- Legacy release.');
    expect(cleanReleaseNotes('')).toBe('');
  });

  it('lists published releases newest first and skips drafts and non-version tags', () => {
    const entries = parseReleases([
      release('v0.5.3', '- a'), release('v0.10.0', '- b'), release('v0.5.10', '- c'), release('nightly', '- x'), release('v9.9.9', '- d', { draft: true }),
    ]);
    expect(entries.map((e) => e.version)).toEqual(['0.10.0', '0.5.10', '0.5.3']);
    expect(entries[0]).toMatchObject({ name: 'unimux 0.10.0', date: '2026-10-10T12:00:00Z', url: 'https://example.test/v0.10.0', notes: '- b' });
    expect(parseReleases({ message: 'rate limited' })).toEqual([]);
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.5.10', '0.5.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.5.3', '0.5.3')).toBe(0);
    expect(compareVersions('0.4.9', '0.5.0')).toBeLessThan(0);
  });

  it('turns markdown into blocks without ever producing HTML', () => {
    const blocks = parseNotes('## Added\n\n- **Status bar** with `v0.5.5`\n- Resize cells\n  across rows\n\nSome <b>text</b>.');
    expect(blocks[0]).toEqual({ type: 'heading', level: 2, inlines: [{ type: 'text', text: 'Added' }] });
    expect(blocks[1]).toEqual({ type: 'list', items: [
      [{ type: 'bold', text: 'Status bar' }, { type: 'text', text: ' with ' }, { type: 'code', text: 'v0.5.5' }],
      [{ type: 'text', text: 'Resize cells' }, { type: 'text', text: ' across rows' }],
    ] });
    expect(blocks[2]).toEqual({ type: 'paragraph', inlines: [{ type: 'text', text: 'Some <b>text</b>.' }] });
    expect(parseInline('plain')).toEqual([{ type: 'text', text: 'plain' }]);
  });
});

describe('changelog service', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ajza-changelog-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const releases = [release('v0.5.5', '- new'), release('v0.5.4', '- old')];

  it('fetches once, serves the fresh copy and refetches when forced', async () => {
    let time = 0;
    const fetchJson = vi.fn().mockResolvedValue(releases);
    const service = createChangelog({ fetchJson, cacheFile: join(dir, 'changelog.json'), now: () => time });
    expect((await service.get()).entries.map((e) => e.version)).toEqual(['0.5.5', '0.5.4']);
    await service.get();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    await service.get(true);
    expect(fetchJson).toHaveBeenCalledTimes(2);
    time = 11 * 60 * 1000;
    await service.get();
    expect(fetchJson).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(join(dir, 'changelog.json'), 'utf8'))).toHaveLength(2);
  });

  it('deduplicates concurrent requests', async () => {
    const fetchJson = vi.fn().mockResolvedValue(releases);
    const service = createChangelog({ fetchJson, cacheFile: join(dir, 'c.json') });
    await Promise.all([service.get(), service.get(), service.get(true)]);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('falls back to the saved copy offline and reports the error', async () => {
    writeFileSync(join(dir, 'c.json'), JSON.stringify(releases));
    const service = createChangelog({ fetchJson: vi.fn().mockRejectedValue(new Error('offline')), cacheFile: join(dir, 'c.json') });
    const result = await service.get();
    expect(result).toMatchObject({ stale: true, error: 'offline' });
    expect(result.entries).toHaveLength(2);
  });

  it('reports an empty result with the error when nothing is saved', async () => {
    const service = createChangelog({ fetchJson: vi.fn().mockRejectedValue(new Error('GitHub 403')), cacheFile: join(dir, 'missing.json') });
    expect(await service.get()).toEqual({ entries: [], stale: false, error: 'GitHub 403' });
  });
});
