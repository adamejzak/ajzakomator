import { describe, expect, it } from 'vitest';
import { parseGithubRemote, toGithubItem } from '../src/shared/github';

describe('github remote', () => {
  it('reads https, ssh and scp-like addresses', () => {
    for (const url of ['https://github.com/daven-team/unimux.git', 'https://github.com/daven-team/unimux', 'git@github.com:daven-team/unimux.git', 'ssh://git@github.com/daven-team/unimux.git', 'https://user@github.com/daven-team/unimux/']) {
      expect(parseGithubRemote(url)).toEqual({ owner: 'daven-team', repo: 'unimux' });
    }
  });
  it('ignores other hosts and odd input', () => {
    for (const url of ['https://gitlab.com/a/b.git', 'git@bitbucket.org:a/b.git', 'https://github.com.evil.com/a/b', 'https://github.com/a', 'file:///c/repo', '']) {
      expect(parseGithubRemote(url)).toBeNull();
    }
  });
  it('keeps only usable items with github links', () => {
    expect(toGithubItem({ number: 4, title: 'Fix', html_url: 'https://github.com/a/b/pull/4', user: { login: 'x' }, updated_at: '2026-01-01T00:00:00Z', draft: true, labels: [{ name: 'bug' }] }))
      .toMatchObject({ number: 4, author: 'x', draft: true, labels: ['bug'] });
    expect(toGithubItem({ number: 4, title: 'Fix', html_url: 'https://evil.example/a/b/pull/4' })).toBeNull();
    expect(toGithubItem({ title: 'no number', html_url: 'https://github.com/a/b/issues/1' })).toBeNull();
  });
});
