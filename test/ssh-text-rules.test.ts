import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sshMessages } from '../src/shared/sshMessages';

const EM_DASH = String.fromCharCode(0x2014);
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
}
const sshFiles = () => [...walk('src'), ...walk('test'), ...walk('scripts')]
  .filter((p) => /ssh/i.test(p.replace(/\\/g, '/').split('/').slice(-2).join('/')));

describe('SSH text rules', () => {
  it('has no em dash in any SSH source, test or script', () => {
    const files = sshFiles();
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) expect(readFileSync(file, 'utf8').includes(EM_DASH), file).toBe(false);
  });

  it('defines no key that another message file already defines', () => {
    const others = walk('src/shared').filter((p) => /(Messages|[\\/]messages)\.ts$/.test(p) && !p.endsWith('sshMessages.ts'));
    const keys = new Set(others.flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/^\s*'((?:[^'\\]|\\.)+)':\s*\[/gm)].map((m) => m[1])));
    for (const key of Object.keys(sshMessages)) expect(keys.has(key), key).toBe(false);
  });
});
