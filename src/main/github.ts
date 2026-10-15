// Reads the open pull requests / issues of the project's GitHub repository. The address comes from the repository's own `origin`; the token (if any)
// comes from the environment or the GitHub CLI and is sent only to api.github.com.
import { execFile } from 'child_process';
import { parseGithubRemote, toGithubItem, type GithubItem, type GithubKind, type GithubResult } from '../shared/github';

const exec = (file: string, args: string[], timeout: number): Promise<string | null> =>
  new Promise((resolve) => execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => resolve(error ? null : stdout.toString().trim() || null)));

async function remoteUrl(projectPath: string): Promise<string | null> {
  const origin = await exec('git', ['-C', projectPath, 'config', '--get', 'remote.origin.url'], 5000);
  if (origin) return origin;
  const first = (await exec('git', ['-C', projectPath, 'remote'], 5000))?.split(/\r?\n/)[0];
  return first ? exec('git', ['-C', projectPath, 'config', '--get', `remote.${first}.url`], 5000) : null;
}

let cachedToken: { value: string | null; at: number } | null = null;
async function token(): Promise<string | null> {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  if (cachedToken && Date.now() - cachedToken.at < 5 * 60 * 1000) return cachedToken.value;
  const value = await exec('gh', ['auth', 'token'], 4000);
  cachedToken = { value, at: Date.now() };
  return value;
}

export async function listGithub(projectPath: string, kind: GithubKind): Promise<GithubResult> {
  const url = await remoteUrl(projectPath);
  const parsed = url ? parseGithubRemote(url) : null;
  if (!parsed) return { ok: false, code: 'no-github', error: 'To repozytorium nie ma zdalnego adresu na GitHubie.' };
  const repo = `${parsed.owner}/${parsed.repo}`;
  const api = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${kind === 'pulls' ? 'pulls' : 'issues'}?state=open&per_page=30&sort=updated&direction=desc`;
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'unimux', 'X-GitHub-Api-Version': '2022-11-28' };
  const auth = await token();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  try {
    const response = await fetch(api, { headers, signal: AbortSignal.timeout(12000), redirect: 'error' });
    if (response.status === 403 || response.status === 429) return { ok: false, code: 'rate', error: 'Limit zapytań GitHuba został wyczerpany. Zaloguj się w GitHub CLI (gh auth login) lub ustaw GITHUB_TOKEN.' };
    if (response.status === 401) return { ok: false, code: 'auth', error: 'Token GitHuba jest nieprawidłowy.' };
    if (response.status === 404) return { ok: false, code: 'auth', error: 'Repozytorium jest prywatne albo nie istnieje. Zaloguj się w GitHub CLI (gh auth login) lub ustaw GITHUB_TOKEN.' };
    if (!response.ok) return { ok: false, code: 'failed', error: `GitHub: ${response.status}` };
    const body = await response.json() as unknown[];
    // The issues endpoint also returns pull requests: they are listed on their own tab.
    const items = body.filter((entry) => kind === 'pulls' || !(entry as { pull_request?: unknown }).pull_request).map(toGithubItem).filter((item): item is GithubItem => item !== null);
    return { ok: true, repo, items, hasMore: body.length >= 30 };
  } catch (error) {
    return { ok: false, code: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}
