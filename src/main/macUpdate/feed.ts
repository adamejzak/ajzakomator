/**
 * Reading the macOS release feed (`latest-mac.yml`). Free of Electron imports.
 *
 * The published file lists a .zip and a .dmg per architecture with a base64 sha512 and the size in bytes. The top-level
 * `path` / `sha512` belong to one architecture only (x64), so the asset is always chosen by name from `files`.
 */

export interface MacAsset { name: string; sha512: string; size: number }
export interface MacFeed { version: string; files: MacAsset[] }

export const MAC_FEED_URL = 'https://github.com/adamejzak/ajzakomator/releases/latest/download/latest-mac.yml';
export const macAssetBase = (version: string): string => `https://github.com/adamejzak/ajzakomator/releases/download/v${version}/`;

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** Only plain file names are accepted: a feed can never point the download at another place. */
const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*-mac-(arm64|x64)\.zip$/;

const unquote = (value: string): string => {
  const text = value.trim();
  return /^(['"]).*\1$/.test(text) && text.length >= 2 ? text.slice(1, -1) : text;
};

/** Parses the small subset of YAML that electron-builder writes (top-level scalars plus a `files` list of flat maps). */
export function parseLatestMacYml(text: string): MacFeed {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let version = '';
  const raw: Array<Record<string, string>> = [];
  let inFiles = false;
  let current: Record<string, string> | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    let body = trimmed;
    let keyIndent = indent;
    if (indent === 0) {
      inFiles = false; current = undefined;
      const top = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(body);
      if (!top) continue;
      if (top[1] === 'version') version = unquote(top[2]);
      else if (top[1] === 'files') inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (body.startsWith('- ')) { current = {}; raw.push(current); body = body.slice(2).trim(); keyIndent = indent + 2; }
    if (!current) continue;
    const pair = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(body);
    if (!pair) continue;
    let value = pair[2];
    if (/^[>|][+-]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const nextIndent = next.length - next.trimStart().length;
        if (next.trim() && nextIndent <= keyIndent) break;
        if (next.trim()) parts.push(next.trim());
        i++;
      }
      value = parts.join(value.startsWith('|') ? '\n' : ' ');
    }
    current[pair[1]] = unquote(value);
  }
  if (!VERSION.test(version)) throw new Error('Nieprawidłowy plik informacji o aktualizacji.');
  const files: MacAsset[] = [];
  for (const entry of raw) {
    const size = Number(entry.size);
    if (!entry.url || !entry.sha512 || !Number.isSafeInteger(size) || size <= 0) continue;
    files.push({ name: entry.url, sha512: entry.sha512.replace(/\s+/g, ''), size });
  }
  return { version, files };
}

/** The .zip of this version for the given Node architecture ('arm64' or 'x64'); undefined when the feed has none. */
export function selectMacAsset(feed: MacFeed, arch: string): MacAsset | undefined {
  if (arch !== 'arm64' && arch !== 'x64') return undefined;
  return feed.files.find((file) => {
    const match = ASSET_NAME.exec(file.name);
    return !!match && match[1] === arch && file.name.includes(`-${feed.version}-`);
  });
}
