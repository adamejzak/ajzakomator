import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshCoordinator, type SshHostCommand } from '../src/main/ssh/coordinator';
import { KnownHostsStore } from '../src/main/ssh/knownHosts';
import { parsePrivateKey } from '../src/main/ssh/keys';
import { SshVault } from '../src/main/ssh/vault';
import { layoutForCount } from '../src/shared/layout';
import { addProject, addSshHost, addTab, defaultState, removeSshHost } from '../src/shared/state';
import type { SshPrompt, SshSessionState } from '../src/shared/ssh';
import type { AppState } from '../src/shared/types';
import { fakeCipher, readableKeyPair, sshString } from './helpers/sshKeys';

// Counts the (slow, bcrypt) passphrase checks the coordinator runs (preflight M2).
const checks = vi.hoisted(() => ({ count: 0 }));
vi.mock('../src/main/ssh/keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/ssh/keys')>();
  return { ...actual, checkPassphrase: (key: string, passphrase: string) => { checks.count++; return actual.checkPassphrase(key, passphrase); } };
});

const HOST = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'unimux-coord-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const blobA = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 1))]);
const blobB = Buffer.concat([sshString('ssh-ed25519'), sshString(Buffer.alloc(32, 2))]);
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(opts: { encryptedKey?: boolean; savePassphrase?: boolean; promptTimeoutMs?: number; debug?: boolean; hostDown?: () => boolean } = {}) {
  const vault = new SshVault(join(dir, 'vault.json'), fakeCipher());
  const knownHosts = new KnownHostsStore(join(dir, 'known_hosts.json'));
  let keyId: string | undefined;
  if (opts.encryptedKey) {
    const pair = readableKeyPair('ed25519', { passphrase: 'right', cipher: 'aes256-ctr', rounds: 16 });
    const parsed = parsePrivateKey(pair.private, 'right');
    if (!parsed.ok) throw new Error('fixture');
    const added = vault.addKey({ label: 'laptop', ...parsed.meta, encrypted: true, privateKey: pair.private, passphrase: 'right', savePassphrase: opts.savePassphrase === true, source: 'generated' });
    keyId = added.ok ? added.key.id : undefined;
  }
  let state: AppState = addProject(defaultState(), { name: 'p', path: dir });
  state = addSshHost(state, { id: HOST, label: 'web', address: 'web.example', port: 2222, username: 'deploy', keyId, createdAt: 0, updatedAt: 0 });
  state = addSshHost(state, { id: OTHER, label: 'db', address: 'db.example', port: 22, username: 'deploy', createdAt: 0, updatedAt: 0 });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(4), cells: [
    { profileId: 'shell', ssh: { hostId: HOST } }, { profileId: 'shell', ssh: { hostId: HOST } }, { profileId: 'shell', ssh: { hostId: HOST } }, { profileId: 'shell', ssh: { hostId: OTHER } },
  ] });
  const [a, b, c, d] = state.projects[0].tabs[0].cells.map((cell) => cell.id);
  const sent: SshHostCommand[] = [];
  const prompts: Array<{ cellId: string; prompt: SshPrompt | null }> = [];
  const sessions: SshSessionState[] = [];
  const coordinator = new SshCoordinator({
    state: () => state, vault, knownHosts, host: (m) => { if (opts.hostDown?.()) return false; sent.push(m); return true; },
    events: { session: (s) => sessions.push(s), prompt: (cellId, prompt) => prompts.push({ cellId, prompt }), vaultChanged: () => undefined },
    promptTimeoutMs: opts.promptTimeoutMs, debug: opts.debug,
  });
  const open = (cellId: string) => [...prompts].reverse().find((p) => p.cellId === cellId)?.prompt ?? null;
  return { coordinator, vault, knownHosts, sent, prompts, sessions, open, cells: { a, b, c, d }, keyId, setState: (s: AppState) => { state = s; }, getState: () => state };
}
const connect = (f: ReturnType<typeof setup>, cellId: string, hostId = HOST) => f.coordinator.connect({ cellId, hostId, cols: 80, rows: 24 });

describe('SshCoordinator', () => {
  it('coalesces the passphrase prompt of cells that use one key and remembers the answer', async () => {
    const f = setup({ encryptedKey: true });
    const first = connect(f, f.cells.a);
    const second = connect(f, f.cells.b);
    await tick();
    const pa = f.open(f.cells.a), pb = f.open(f.cells.b);
    checks.count = 0;
    expect(pa?.kind).toBe('passphrase');
    expect(pb?.id).toBe(pa?.id);
    expect(f.coordinator.answer({ cellId: f.cells.b, promptId: pb!.id, values: ['right'], remember: true })).toEqual({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: true });
    const connects = f.sent.filter((m) => m.t === 'sshConnect');
    expect(connects).toHaveLength(2);
    expect(connects[0]).toMatchObject({ req: { host: 'web.example', port: 2222, username: 'deploy', passphrase: 'right', allowPasswordPrompt: true } });
    expect(f.vault.remembered(f.keyId!)).toBe('right');
    expect(checks.count).toBe(1); // one bcrypt check for both cells of the coalesced prompt (M2)
    await connect(f, f.cells.c);
    expect(f.open(f.cells.c)).toBeNull();
  });

  it('asks again after a wrong passphrase and gives up after three tries', async () => {
    const f = setup({ encryptedKey: true });
    const result = connect(f, f.cells.a);
    for (let i = 0; i < 3; i++) {
      await tick();
      const p = f.open(f.cells.a);
      expect(p).toMatchObject({ kind: 'passphrase', retry: i > 0 });
      f.coordinator.answer({ cellId: f.cells.a, promptId: p!.id, values: ['wrong'] });
    }
    expect(await result).toEqual({ ok: false, error: 'passphrase' });
    expect(f.sent).toEqual([]);
    expect(f.sessions.at(-1)).toMatchObject({ cellId: f.cells.a, phase: 'error', error: 'passphrase' });
  });

  it('withdraws a killed cell from a coalesced prompt, the others keep waiting (Review Focus 1)', async () => {
    const f = setup({ encryptedKey: true });
    const first = connect(f, f.cells.a);
    const second = connect(f, f.cells.b);
    await tick();
    f.coordinator.killed(f.cells.a);
    expect(f.open(f.cells.a)).toBeNull();
    expect(await first).toEqual({ ok: false, error: 'cancelled' });
    const p = f.open(f.cells.b)!;
    f.coordinator.answer({ cellId: f.cells.b, promptId: p.id, values: ['right'] });
    expect(await second).toEqual({ ok: true });
    expect(f.sent.filter((m) => m.t === 'sshConnect').map((m) => m.t === 'sshConnect' && m.req.id)).toEqual([f.cells.b]);
  });

  it('returns open prompts with the sessions snapshot (Review Focus 2)', async () => {
    const f = setup({ encryptedKey: true });
    void connect(f, f.cells.a);
    await tick();
    const snap = f.coordinator.sessions();
    expect(snap.sessions.find((s) => s.cellId === f.cells.a)).toMatchObject({ phase: 'connecting', hostId: HOST });
    expect(snap.prompts).toEqual([{ cellId: f.cells.a, prompt: f.open(f.cells.a) }]);
  });

  it('coalesces host key prompts per host and port, saves trust and accepts known keys silently', async () => {
    const f = setup();
    await connect(f, f.cells.a);
    await connect(f, f.cells.b);
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.a, promptId: 'pa', key: blobA.toString('base64') });
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.b, promptId: 'pb', key: blobA.toString('base64') });
    await tick();
    const p = f.open(f.cells.a)!;
    expect(p).toMatchObject({ kind: 'hostKey', endpoint: 'web.example:2222', keyType: 'ssh-ed25519', reason: 'unknown' });
    expect(f.open(f.cells.b)!.id).toBe(p.id);
    f.coordinator.answer({ cellId: f.cells.a, promptId: p.id, hostKey: 'save' });
    await tick();
    expect(f.sent.filter((m) => m.t === 'sshHostKeyAnswer')).toEqual([
      { t: 'sshHostKeyAnswer', id: f.cells.a, promptId: 'pa', accept: true },
      { t: 'sshHostKeyAnswer', id: f.cells.b, promptId: 'pb', accept: true },
    ]);
    expect(f.knownHosts.list()).toHaveLength(1);
    await connect(f, f.cells.c);
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.c, promptId: 'pc', key: blobA.toString('base64') });
    await tick();
    expect(f.open(f.cells.c)).toBeNull();
    expect(f.sent.at(-1)).toEqual({ t: 'sshHostKeyAnswer', id: f.cells.c, promptId: 'pc', accept: true });
  });

  it('allows only "replace" for a changed key and reports hostKeyChanged on cancel', async () => {
    const f = setup();
    f.knownHosts.trust('web.example', 2222, blobA, 'save');
    await connect(f, f.cells.a);
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.a, promptId: 'pa', key: blobB.toString('base64') });
    await tick();
    const p = f.open(f.cells.a)!;
    expect(p).toMatchObject({ reason: 'changed', knownFingerprints: [f.knownHosts.list()[0].fingerprint] });
    expect(f.coordinator.answer({ cellId: f.cells.a, promptId: p.id, hostKey: 'once' })).toEqual({ ok: false });
    expect(f.coordinator.answer({ cellId: f.cells.a, promptId: p.id, cancel: true })).toEqual({ ok: true });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshHostKeyAnswer', id: f.cells.a, promptId: 'pa', accept: false, error: 'hostKeyChanged' });
  });

  it('saves a typed password only after the session connected', async () => {
    const f = setup();
    await connect(f, f.cells.d, OTHER);
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: f.cells.d, promptId: 'auth1', kind: 'password', fields: [], retry: false });
    await tick();
    const p = f.open(f.cells.d)!;
    expect(p).toMatchObject({ kind: 'password', user: 'deploy', endpoint: 'db.example', canSave: true, retry: false });
    f.coordinator.answer({ cellId: f.cells.d, promptId: p.id, values: ['typed-secret'], remember: true });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshAuthAnswer', id: f.cells.d, promptId: 'auth1', values: ['typed-secret'] });
    expect(f.vault.password(OTHER)).toEqual({ ok: false, error: 'none' });
    f.coordinator.onHostMessage({ t: 'sshStatus', id: f.cells.d, phase: 'connected' });
    expect(f.vault.password(OTHER)).toEqual({ ok: true, password: 'typed-secret' });
  });

  it('does not save a wrong remembered password when the retry is answered without remember (I1)', async () => {
    const f = setup();
    await connect(f, f.cells.d, OTHER);
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: f.cells.d, promptId: 'auth1', kind: 'password', fields: [], retry: false });
    await tick();
    f.coordinator.answer({ cellId: f.cells.d, promptId: f.open(f.cells.d)!.id, values: ['wrong'], remember: true });
    await tick();
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: f.cells.d, promptId: 'auth2', kind: 'password', fields: [], retry: true });
    await tick();
    f.coordinator.answer({ cellId: f.cells.d, promptId: f.open(f.cells.d)!.id, values: ['right'], remember: false });
    await tick();
    expect(f.sent.at(-1)).toEqual({ t: 'sshAuthAnswer', id: f.cells.d, promptId: 'auth2', values: ['right'] });
    f.coordinator.onHostMessage({ t: 'sshStatus', id: f.cells.d, phase: 'connected' });
    expect(f.vault.password(OTHER)).toEqual({ ok: false, error: 'none' });
  });

  it('fails a connect the Pty Host could not take (restarting or fatal) and lets a later one through (M1)', async () => {
    let down = true;
    const f = setup({ hostDown: () => down });
    expect(await connect(f, f.cells.d, OTHER)).toEqual({ ok: false, error: 'ptyHostCrashed' });
    expect(f.sessions.at(-1)).toMatchObject({ cellId: f.cells.d, phase: 'error', error: 'ptyHostCrashed' });
    down = false;
    expect(await connect(f, f.cells.d, OTHER)).toEqual({ ok: true });
    expect(f.sent.filter((m) => m.t === 'sshConnect')).toHaveLength(1);
    expect(f.sessions.at(-1)).toMatchObject({ cellId: f.cells.d, phase: 'connecting' });
  });

  it('cancels an unanswered prompt after the timeout', async () => {
    const f = setup({ promptTimeoutMs: 30 });
    await connect(f, f.cells.d, OTHER);
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.d, promptId: 'k', key: blobA.toString('base64') });
    await new Promise((r) => setTimeout(r, 80));
    expect(f.sent.at(-1)).toEqual({ t: 'sshHostKeyAnswer', id: f.cells.d, promptId: 'k', accept: false, error: 'cancelled' });
    expect(f.open(f.cells.d)).toBeNull();
  });

  it('validates cells and hosts and refuses messages for unknown cells', async () => {
    const f = setup();
    expect(await connect(f, f.cells.d, HOST)).toEqual({ ok: false, error: 'hostMissing' });
    expect(await connect(f, '00000000-0000-4000-8000-0000000000ff')).toEqual({ ok: false, error: 'hostMissing' });
    f.setState(removeSshHost(f.getState(), HOST));
    expect(await connect(f, f.cells.a)).toEqual({ ok: false, error: 'hostMissing' });
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: 'stranger', promptId: 'x', key: blobA.toString('base64') });
    expect(f.sent.at(-1)).toEqual({ t: 'sshHostKeyAnswer', id: 'stranger', promptId: 'x', accept: false, error: 'cancelled' });
    expect(f.sent.some((m) => m.t === 'sshConnect')).toBe(false);
  });

  it('ignores a second connect for a live cell (R13) and ends every live session when the Pty Host crashes', async () => {
    const f = setup();
    await connect(f, f.cells.d, OTHER);
    await connect(f, f.cells.d, OTHER);
    expect(f.sent.filter((m) => m.t === 'sshConnect')).toHaveLength(1);
    f.coordinator.hostCrashed();
    expect(f.sessions.at(-1)).toMatchObject({ cellId: f.cells.d, phase: 'error', error: 'ptyHostCrashed' });
  });

  it('passes the startup command through startupInput and prunes passwords of deleted hosts', async () => {
    const f = setup();
    f.setState({ ...f.getState(), sshHosts: f.getState().sshHosts.map((h) => (h.id === OTHER ? { ...h, startupCommand: 'cd /srv\nls\n' } : h)) });
    f.vault.setPassword(OTHER, 'saved');
    await connect(f, f.cells.d, OTHER);
    expect(f.sent[0]).toMatchObject({ t: 'sshConnect', req: { startup: 'cd /srv\rls\r', password: 'saved' } });
    f.setState(removeSshHost(f.getState(), OTHER));
    f.coordinator.stateChanged(f.getState());
    expect(f.vault.info().savedPasswords).toEqual([]);
  });

  it('trusts a remembered passphrase without checking it again (M2)', async () => {
    const f = setup({ encryptedKey: true });
    f.vault.remember(f.keyId!, 'remembered-value');
    checks.count = 0;
    expect(await connect(f, f.cells.a)).toEqual({ ok: true });
    expect(checks.count).toBe(0);
    expect(f.open(f.cells.a)).toBeNull();
    expect(f.sent[0]).toMatchObject({ t: 'sshConnect', req: { passphrase: 'remembered-value' } });
  });

  it('checks a saved passphrase once and again only after the key changed (M2)', async () => {
    const f = setup({ encryptedKey: true, savePassphrase: true });
    checks.count = 0;
    expect(await connect(f, f.cells.a)).toEqual({ ok: true });
    expect(await connect(f, f.cells.b)).toEqual({ ok: true });
    expect(checks.count).toBe(1);
    expect(f.sent.filter((m) => m.t === 'sshConnect').map((m) => m.t === 'sshConnect' && m.req.passphrase)).toEqual(['right', 'right']);
    expect(f.vault.updateKey(f.keyId!, { passphrase: { save: 'right' } }).ok).toBe(true);
    expect(await connect(f, f.cells.c)).toEqual({ ok: true });
    expect(checks.count).toBe(2);
  });

  it('asks for the passphrase when the saved one no longer opens the key', async () => {
    const f = setup({ encryptedKey: true, savePassphrase: true });
    expect(f.vault.updateKey(f.keyId!, { passphrase: { save: 'stale' } }).ok).toBe(true);
    const result = connect(f, f.cells.a);
    await tick();
    const p = f.open(f.cells.a)!;
    expect(p).toMatchObject({ kind: 'passphrase', retry: false });
    f.coordinator.answer({ cellId: f.cells.a, promptId: p.id, values: ['right'] });
    expect(await result).toEqual({ ok: true });
    expect(f.sent[0]).toMatchObject({ req: { passphrase: 'right' } });
  });

  it('cancels a connect whose passphrase prompt timed out', async () => {
    const f = setup({ encryptedKey: true, promptTimeoutMs: 30 });
    expect(await connect(f, f.cells.a)).toEqual({ ok: false, error: 'cancelled' });
    expect(f.open(f.cells.a)).toBeNull();
    expect(f.sent).toEqual([]);
  });

  it('asks the Pty Host for debug lines only when main says so', async () => {
    const plain = setup();
    await connect(plain, plain.cells.d, OTHER);
    expect(plain.sent[0].t === 'sshConnect' && 'debug' in plain.sent[0].req).toBe(false);
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'unimux-coord-'));
    const debug = setup({ debug: true });
    await connect(debug, debug.cells.d, OTHER);
    expect(debug.sent[0]).toMatchObject({ t: 'sshConnect', req: { debug: true } });
  });

  it('rejects the host key with a fixed code when saving the trust fails', async () => {
    const f = setup();
    vi.spyOn(f.knownHosts, 'trust').mockImplementation(() => { throw new Error('EACCES D:\private\known_hosts.json'); });
    await connect(f, f.cells.a);
    await connect(f, f.cells.b);
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.a, promptId: 'pa', key: blobA.toString('base64') });
    f.coordinator.onHostMessage({ t: 'sshHostKey', id: f.cells.b, promptId: 'pb', key: blobA.toString('base64') });
    await tick();
    const p = f.open(f.cells.a)!;
    expect(f.coordinator.answer({ cellId: f.cells.a, promptId: p.id, hostKey: 'save' })).toEqual({ ok: true });
    await tick();
    expect(f.sent.filter((m) => m.t === 'sshHostKeyAnswer')).toEqual([
      { t: 'sshHostKeyAnswer', id: f.cells.a, promptId: 'pa', accept: false, error: 'unknown' },
      { t: 'sshHostKeyAnswer', id: f.cells.b, promptId: 'pb', accept: false, error: 'unknown' },
    ]);
    expect(JSON.stringify(f.sent)).not.toContain('EACCES');
  });

  it('keeps going when the vault cannot write a password or prune', async () => {
    const f = setup();
    vi.spyOn(f.vault, 'setPassword').mockImplementation(() => { throw new Error('disk full'); });
    vi.spyOn(f.vault, 'prunePasswords').mockImplementation(() => { throw new Error('disk full'); });
    await connect(f, f.cells.d, OTHER);
    f.coordinator.onHostMessage({ t: 'sshAuthPrompt', id: f.cells.d, promptId: 'auth1', kind: 'password', fields: [], retry: false });
    await tick();
    f.coordinator.answer({ cellId: f.cells.d, promptId: f.open(f.cells.d)!.id, values: ['typed-secret'], remember: true });
    await tick();
    expect(() => f.coordinator.onHostMessage({ t: 'sshStatus', id: f.cells.d, phase: 'connected' })).not.toThrow();
    expect(f.sessions.at(-1)).toMatchObject({ cellId: f.cells.d, phase: 'connected' });
    expect(() => f.coordinator.stateChanged(removeSshHost(f.getState(), OTHER))).not.toThrow();
  });

  it('checks a typed answer once for a 3-cell prompt and keeps no copy unless remembered (D7, fix round 1)', async () => {
    const f = setup({ encryptedKey: true });
    const results = [connect(f, f.cells.a), connect(f, f.cells.b), connect(f, f.cells.c)];
    await tick();
    const p = f.open(f.cells.a)!;
    expect(f.open(f.cells.b)!.id).toBe(p.id);
    expect(f.open(f.cells.c)!.id).toBe(p.id);
    checks.count = 0;
    f.coordinator.answer({ cellId: f.cells.c, promptId: p.id, values: ['right'] });
    expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(checks.count).toBe(1);
    expect(f.vault.remembered(f.keyId!)).toBeUndefined();
    expect(f.vault.isVerified(f.keyId!, 'right')).toBe(false);
    // A reconnect asks again: nothing of the typed passphrase was kept.
    f.coordinator.killed(f.cells.a);
    void connect(f, f.cells.a);
    await tick();
    expect(f.open(f.cells.a)).toMatchObject({ kind: 'passphrase', retry: false });
  });

  it('saves a coalesced host key once per group, so all cells get the same outcome (fix round 1)', async () => {
    const f = setup();
    const trust = vi.spyOn(f.knownHosts, 'trust').mockImplementationOnce(() => { throw new Error('EBUSY'); });
    await connect(f, f.cells.a);
    await connect(f, f.cells.b);
    await connect(f, f.cells.c);
    for (const [cell, pid] of [[f.cells.a, 'pa'], [f.cells.b, 'pb'], [f.cells.c, 'pc']] as const) {
      f.coordinator.onHostMessage({ t: 'sshHostKey', id: cell, promptId: pid, key: blobA.toString('base64') });
    }
    await tick();
    f.coordinator.answer({ cellId: f.cells.b, promptId: f.open(f.cells.b)!.id, hostKey: 'save' });
    await tick();
    expect(trust).toHaveBeenCalledTimes(1);
    const answers = f.sent.filter((m) => m.t === 'sshHostKeyAnswer');
    expect(answers).toHaveLength(3);
    expect(answers.every((m) => m.t === 'sshHostKeyAnswer' && !m.accept && m.error === 'unknown')).toBe(true);
  });
});
