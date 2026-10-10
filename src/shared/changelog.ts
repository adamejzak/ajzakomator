/** Release notes shown in the app, built from the repository's GitHub releases. */
export interface ChangelogEntry {
  version: string;
  name: string;
  /** ISO publication date. */
  date: string;
  url: string;
  /** Markdown without the download guide that every release body ends with. */
  notes: string;
  prerelease: boolean;
}

export interface ChangelogResult {
  entries: ChangelogEntry[];
  /** True when GitHub could not be reached and a saved copy is shown. */
  stale: boolean;
  error?: string;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a), right = SEMVER.exec(b);
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i++) if (left[i] !== right[i]) return Number(left[i]) - Number(right[i]);
  return 0;
}

/** Drops the title, download guide and housekeeping lines so only what changed remains. */
export function cleanReleaseNotes(body: string): string {
  const guide = body.search(/^#{1,3}\s+Which download should I choose\?/im);
  const text = (guide >= 0 ? body.slice(0, guide) : body).replace(/\r\n/g, '\n');
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && !/^#\s+ajzakomator\s+\d/i.test(part) && !/^Windows packages for ajzakomator/i.test(part) && !/^Validated with\b/i.test(part))
    .join('\n\n')
    .trim();
}

/** Published releases of the GitHub API response, newest version first. */
export function parseReleases(json: unknown): ChangelogEntry[] {
  if (!Array.isArray(json)) return [];
  const entries: ChangelogEntry[] = [];
  for (const item of json as Array<Record<string, unknown>>) {
    const tag = typeof item?.tag_name === 'string' ? item.tag_name : '';
    if (item?.draft || !SEMVER.test(tag)) continue;
    entries.push({
      version: tag.replace(/^v/, ''),
      name: typeof item.name === 'string' && item.name ? item.name : `ajzakomator ${tag.replace(/^v/, '')}`,
      date: typeof item.published_at === 'string' ? item.published_at : typeof item.created_at === 'string' ? item.created_at : '',
      url: typeof item.html_url === 'string' ? item.html_url : '',
      notes: cleanReleaseNotes(typeof item.body === 'string' ? item.body : ''),
      prerelease: !!item.prerelease,
    });
  }
  return entries.sort((a, b) => compareVersions(b.version, a.version));
}

export type Inline = { type: 'text' | 'bold' | 'code'; text: string };
export type Block =
  | { type: 'heading'; level: number; inlines: Inline[] }
  | { type: 'list'; items: Inline[][] }
  | { type: 'paragraph'; inlines: Inline[] };

/** Splits `**bold**` and `` `code` `` out of a line; everything else is plain text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) out.push({ type: 'text', text: text.slice(last, match.index) });
    out.push(match[1] !== undefined ? { type: 'bold', text: match[1] } : { type: 'code', text: match[2] });
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** A small markdown subset (headings, bullet lists, paragraphs) rendered as React elements, never as HTML. */
export function parseNotes(markdown: string): Block[] {
  const blocks: Block[] = [];
  let list: Inline[][] | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', inlines: parseInline(paragraph.join(' ')) });
    paragraph = []; list = null;
  };
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) }); continue; }
    if (bullet) {
      if (paragraph.length) flush();
      if (!list) { list = []; blocks.push({ type: 'list', items: list }); }
      list.push(parseInline(bullet[1]));
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) { list[list.length - 1].push(...parseInline(` ${line.trim()}`)); continue; }
    list = null;
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
