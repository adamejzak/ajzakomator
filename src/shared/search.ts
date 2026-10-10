/** Find and replace across a project: types and the text engine shared by the main process and the window. */

export interface SearchOptions {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma separated globs such as `*.ts, src/**`; empty means every text file. */
  include?: string;
  exclude?: string;
  /** Also search folders such as node_modules and dist. */
  includeIgnored?: boolean;
}

export interface SearchMatch {
  /** 1-based line and 0-based column of the match in the file. */
  line: number;
  column: number;
  /** The matched text. */
  text: string;
  /** The line (shortened around the match) and where the match sits inside it. */
  preview: string;
  matchStart: number;
  matchLength: number;
}

export interface SearchFile { path: string; matches: SearchMatch[] }

export type SearchResult =
  | { ok: true; files: SearchFile[]; matches: number; scanned: number; skipped: number; truncated: boolean }
  | { ok: false; error: string };

export type ReplaceScope =
  | { kind: 'all' }
  | { kind: 'file'; path: string }
  | { kind: 'match'; path: string; line: number; column: number; text: string };

export interface ReplaceRequest { options: SearchOptions; replacement: string; scope: ReplaceScope }
export interface ReplaceFileResult { path: string; replaced: number; error?: string }
export type ReplaceResult = { ok: true; replaced: number; files: ReplaceFileResult[] } | { ok: false; error: string };

/** Folders that hold dependencies or build output; skipped by search and "expand all" unless asked for. */
export const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', '.next', '.nuxt', 'coverage', '.cache', '.venv', 'venv', '__pycache__', 'target', 'release',
]);

export const MAX_MATCHES = 5000;
export const MAX_LINE_LENGTH = 5000;
const PREVIEW_BEFORE = 60;
const PREVIEW_AFTER = 160;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Compiles the search options; returns an error message for an invalid regular expression. */
export function buildPattern(options: SearchOptions): { regex: RegExp } | { error: string } {
  if (!options.query) return { error: '' };
  const body = options.regex ? options.query : escapeRegExp(options.query);
  const attempts: Array<[string, string]> = [
    [options.wholeWord ? `(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])` : body, 'gu'],
    [options.wholeWord ? `(?<![\\w])(?:${body})(?![\\w])` : body, 'g'],
  ];
  let failure = '';
  for (const [source, flags] of attempts) {
    try { return { regex: new RegExp(source, flags + (options.caseSensitive ? '' : 'i')) }; }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
  }
  return { error: failure };
}

/** Matches of every line of `text`; stops after `limit` matches and reports whether it did. */
export function searchText(text: string, regex: RegExp, limit = MAX_MATCHES): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > MAX_LINE_LENGTH) continue;
    regex.lastIndex = 0;
    for (let m = regex.exec(line); m; m = regex.exec(line)) {
      if (!m[0]) { regex.lastIndex++; continue; }
      if (matches.length >= limit) return { matches, truncated: true };
      const from = Math.max(0, m.index - PREVIEW_BEFORE);
      const to = Math.min(line.length, m.index + m[0].length + PREVIEW_AFTER);
      matches.push({
        line: i + 1, column: m.index, text: m[0],
        preview: (from > 0 ? '…' : '') + line.slice(from, to) + (to < line.length ? '…' : ''),
        matchStart: m.index - from + (from > 0 ? 1 : 0), matchLength: m[0].length,
      });
    }
  }
  return { matches, truncated: false };
}

/** `$1`, `$&`, `$<name>` and `$$` of a regular-expression replacement; literal searches keep the text as typed. */
export function expandReplacement(replacement: string, match: RegExpExecArray): string {
  return replacement.replace(/\$(\$|&|<([^>]+)>|\d{1,2})/g, (all, token: string, name?: string) => {
    if (token === '$') return '$';
    if (token === '&') return match[0];
    if (name) return match.groups?.[name] ?? '';
    const group = Number(token);
    return group >= 1 && group < match.length ? match[group] ?? '' : all;
  });
}

export interface ReplaceOptions {
  regex: RegExp;
  replacement: string;
  /** Expand `$1` and friends (regular-expression searches). */
  expand: boolean;
  /** Replace only this occurrence. */
  only?: { line: number; column: number; text: string };
}

/** Replaces matches line by line and keeps every line ending untouched. */
export function replaceInText(text: string, { regex, replacement, expand, only }: ReplaceOptions): { text: string; count: number } {
  const parts = text.split(/(\r\n|\r|\n)/);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const lineNumber = i / 2 + 1;
    if (line.length > MAX_LINE_LENGTH || (only && only.line !== lineNumber)) continue;
    let out = '';
    let last = 0;
    regex.lastIndex = 0;
    for (let m = regex.exec(line); m; m = regex.exec(line)) {
      if (!m[0]) { regex.lastIndex++; continue; }
      if (only && (m.index !== only.column || m[0] !== only.text)) continue;
      out += line.slice(last, m.index) + (expand ? expandReplacement(replacement, m) : replacement);
      last = m.index + m[0].length;
      count++;
    }
    if (last > 0 || out) parts[i] = out + line.slice(last);
  }
  return { text: parts.join(''), count };
}

/** Glob list (`*.ts, src/**`) as a path predicate; a pattern without a slash matches file names anywhere. */
export function compileGlobs(spec: string | undefined): ((path: string) => boolean) | null {
  const patterns = (spec ?? '').split(',').map((part) => part.trim().replace(/\\/g, '/')).filter(Boolean);
  if (!patterns.length) return null;
  const matchers = patterns.map((pattern) => {
    const directory = pattern.endsWith('/');
    const body = directory ? `${pattern}**` : pattern;
    const source = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    const anchored = new RegExp(`^${source}$`, 'i');
    return body.includes('/') ? (path: string) => anchored.test(path) : (path: string) => anchored.test(path.split('/').pop() ?? path);
  });
  return (path) => matchers.some((matches) => matches(path.replace(/\\/g, '/')));
}
