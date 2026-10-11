import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { HookServer, parseSessionStart } from '../src/main/hooks';
import { sessionSearchPaths, shouldUpdateCellSession } from '../src/shared/sessionTrack';

const ID = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('SessionStart hook', () => {
  it('emits a session event, never a status event, and rejects bad requests', async () => {
    const s = new HookServer();
    await s.start();
    const sessions: string[] = [];
    const status: string[] = [];
    s.on('session', (cell, id, source) => sessions.push(`${cell}:${id}:${source}`));
    s.on('hook', (cell, ev) => status.push(`${cell}:${ev}`));
    const base = `http://127.0.0.1:${s.port}/h/${s.token}/c1/session`;

    expect((await post(base, { session_id: ID, source: 'resume' })).status).toBe(204);
    expect(await post(base, { session_id: 'short' })).toBeTruthy();
    await post(base, { session_id: '../../etc/passwd-aaaa' });
    await post(base, { session_id: 42 });
    await post(base, 'not json');
    await post(`http://127.0.0.1:${s.port}/h/wrongtoken/c1/session`, { session_id: ID }).catch(() => {});
    await post(base, 'x'.repeat(200_000)).catch(() => {});
    expect((await fetch(base)).status).toBe(403);
    await new Promise((r) => setTimeout(r, 50));

    expect(sessions).toEqual([`c1:${ID}:resume`]);
    expect(status).toEqual([]);
    s.stop();
  });

  it('writes a SessionStart hook that posts its payload', async () => {
    const s = new HookServer();
    await s.start();
    const dir = mkdtempSync(join(tmpdir(), 'mc-hooks-'));
    try {
      const json = JSON.parse(readFileSync(s.writeClaudeSettings(dir, 'c5'), 'utf8'));
      const cmd = json.hooks.SessionStart[0].hooks[0].command as string;
      expect(cmd).toContain('--data-binary @-');
      expect(cmd).toContain('-m 2');
      expect(cmd).toContain(`/h/${s.token}/c5/session`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      s.stop();
    }
  });

  it('parses payloads strictly', () => {
    expect(parseSessionStart(JSON.stringify({ session_id: ID, source: 'clear' }))).toEqual({ sessionId: ID, source: 'clear' });
    expect(parseSessionStart(JSON.stringify({ session_id: ID, source: 'weird' }))).toEqual({ sessionId: ID, source: undefined });
    expect(parseSessionStart(JSON.stringify({ session_id: 'a b c d e f g h' }))).toBeNull();
    expect(parseSessionStart('[]')).toBeNull();
    expect(parseSessionStart('null')).toBeNull();
  });
});

describe('shouldUpdateCellSession', () => {
  const base = { known: true, isClaude: true, alive: true, currentId: 'old-session-id', reportedId: ID };
  it('updates a live Claude cell whose conversation changed', () => {
    expect(shouldUpdateCellSession(base)).toBe(true);
    expect(shouldUpdateCellSession({ ...base, currentId: undefined })).toBe(true);
  });
  it('ignores unknown, non-claude, not alive, unchanged and invalid ids', () => {
    expect(shouldUpdateCellSession({ ...base, known: false })).toBe(false);
    expect(shouldUpdateCellSession({ ...base, isClaude: false })).toBe(false);
    expect(shouldUpdateCellSession({ ...base, alive: false })).toBe(false);
    expect(shouldUpdateCellSession({ ...base, currentId: ID })).toBe(false);
    expect(shouldUpdateCellSession({ ...base, reportedId: 'bad id' })).toBe(false);
  });
});

describe('sessionSearchPaths', () => {
  it('returns the project path plus distinct worktree paths of its cells', () => {
    const cell = (id: string, wt?: string) => ({ id, worktree: wt ? { path: wt } : undefined });
    const state = { projects: [{ path: 'P', archive: [{ cells: [cell('d', 'W2')] }], tabs: [{ cells: [cell('a'), cell('b', 'W1'), cell('c', 'W1')] }] }] };
    expect(sessionSearchPaths('P', state as never)).toEqual(['P', 'W1', 'W2']);
    expect(sessionSearchPaths('other', state as never)).toEqual(['other']);
  });
});
