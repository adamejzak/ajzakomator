import { describe, expect, it } from 'vitest';
import { badgeFor, buildBadges } from '../src/shared/gitBadges';
import type { GitFileChange } from '../src/shared/git';

const change = (path: string, x: string, y: string, extra: Partial<GitFileChange> = {}): GitFileChange => ({
  path, x, y, staged: x !== ' ' && x !== '?', unstaged: y !== ' ', untracked: false, conflict: false, ...extra,
});
const root = { kind: 'inside-root', prefix: '' } as const;

describe('git badges for the Files tree', () => {
  it('marks files with their letter and the folders above them with a dot', () => {
    const badges = buildBadges([change('src/a.ts', ' ', 'M'), change('src/deep/b.ts', 'A', ' '), change('new.txt', '?', '?', { untracked: true })], root);
    expect(badgeFor(badges, 'src/a.ts', false).letter?.letter).toBe('M');
    expect(badgeFor(badges, 'src/deep/b.ts', false).letter?.letter).toBe('A');
    expect(badgeFor(badges, 'new.txt', false).letter?.letter).toBe('U');
    expect(badgeFor(badges, 'src', true).dot).toBe('mod'); // modified wins over added
    expect(badgeFor(badges, 'src/deep', true).dot).toBe('add');
    expect(badgeFor(badges, 'docs', true).dot).toBeNull();
  });
  it('treats everything under an untracked folder as untracked', () => {
    const badges = buildBadges([change('build/', '?', '?', { untracked: true })], root);
    expect(badgeFor(badges, 'build', true).letter?.letter).toBe('U');
    expect(badgeFor(badges, 'build/x.js', false).letter?.letter).toBe('U');
    expect(badgeFor(badges, 'build/sub', true).dot).toBe('add');
  });
  it('shows conflicts first and follows a project below the repository root', () => {
    const badges = buildBadges([change('app/c.ts', 'U', 'U', { conflict: true }), change('other/d.ts', ' ', 'M')], { kind: 'inside-root', prefix: 'app' });
    expect(badgeFor(badges, 'c.ts', false).letter?.letter).toBe('!');
    expect(badgeFor(badges, 'd.ts', false).letter).toBeNull(); // outside the project folder
  });
});
