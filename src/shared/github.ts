// Pull requests and issues of a GitHub repository, as the Git panel lists them. Pure parts: the remote address and the shape of an item.
export type GithubKind = 'pulls' | 'issues';

export interface GithubItem {
  number: number;
  title: string;
  author: string;
  /** ISO time of the last update. */
  updatedAt: string;
  url: string;
  draft: boolean;
  comments: number;
  labels: string[];
}

export type GithubResult =
  | { ok: true; repo: string; items: GithubItem[]; hasMore: boolean }
  | { ok: false; code: 'no-github' | 'rate' | 'auth' | 'failed'; error: string };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo` of a github.com remote (https, ssh or scp-like form); null for any other host. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const text = url.trim();
  const match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|(?:[^@/\s]+@)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(text);
  if (!match) return null;
  const [, owner, repo] = match;
  return SEGMENT.test(owner) && SEGMENT.test(repo) && repo !== '.' && repo !== '..' ? { owner, repo } : null;
}

/** The list item of a GitHub REST response (issues and pulls share most fields); null when it is not usable. */
export function toGithubItem(raw: unknown): GithubItem | null {
  const item = raw as Record<string, any> | null;
  if (!item || typeof item.number !== 'number' || typeof item.title !== 'string' || typeof item.html_url !== 'string') return null;
  if (!/^https:\/\/github\.com\//.test(item.html_url)) return null;
  return {
    number: item.number,
    title: item.title.slice(0, 300),
    author: typeof item.user?.login === 'string' ? item.user.login : '',
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    url: item.html_url,
    draft: item.draft === true,
    comments: typeof item.comments === 'number' ? item.comments : 0,
    labels: Array.isArray(item.labels) ? item.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter((n: unknown): n is string => typeof n === 'string').slice(0, 4) : [],
  };
}
