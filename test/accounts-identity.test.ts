// test/accounts-identity.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readManagedIdentity } from '../src/main/accounts/identity';
import type { CredentialSource } from '../src/main/usage/credentials';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ajza-ident-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const source: CredentialSource = {
  env: { PATH: 'p' }, home: join(tmpdir(), 'ajza-nonexistent-home'), platform: 'win32', keychain: async () => null,
  readFile: (path) => readFile(path, 'utf8').catch(() => null),
};

describe('readManagedIdentity', () => {
  it('prefers .claude.json and skips the CLI', async () => {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com', organizationName: 'Org' } }));
    const exec = vi.fn(async () => null);
    expect(await readManagedIdentity(dir, { source, exec })).toEqual({ email: 'a@x.com', org: 'Org' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to the CLI with CLAUDE_CONFIG_DIR set to the profile', async () => {
    mkdirSync(dir, { recursive: true });
    const exec = vi.fn(async () => JSON.stringify({ loggedIn: true, email: 'c@x.com', orgName: 'O', subscriptionType: 'max' }));
    const result = await readManagedIdentity(dir, { source, exec });
    expect(result).toEqual({ email: 'c@x.com', org: 'O', plan: 'max' });
    expect(exec).toHaveBeenCalledTimes(1);
    const [command, args, env] = exec.mock.calls[0] as unknown as [string, string[], NodeJS.ProcessEnv];
    expect(command).toBe('claude');
    expect(args).toEqual(['auth', 'status', '--json']);
    expect(env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(env.PATH).toBe('p');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(env.ANTHROPIC_API_KEY).toBe('');
  });

  it('gives {} for logged out, bad JSON, null and throwing exec', async () => {
    const run = (exec: (c: string, a: string[], e: NodeJS.ProcessEnv) => Promise<string | null>) => readManagedIdentity(dir, { source, exec });
    expect(await run(async () => JSON.stringify({ loggedIn: false, email: 'x@x.com' }))).toEqual({});
    expect(await run(async () => 'nope')).toEqual({});
    expect(await run(async () => null)).toEqual({});
    expect(await run(async () => { throw new Error('boom'); })).toEqual({});
  });
});
