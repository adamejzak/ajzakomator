import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { claudeProjectDirName, findRecentCodexSession, listClaudeSessions, listCodexSessions } from '../src/main/sessions';

const PROJECT = 'D:\\Projekty\\bot-discord';
const jsonl = (rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'mc-home-'));
  const cdir = join(home, '.claude', 'projects', claudeProjectDirName(PROJECT));
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, 'aaa.jsonl'), jsonl([
    { type: 'mode', sessionId: 'aaa' },
    'this is not json',
    { type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'meta stuff' }] }, sessionId: 'aaa', cwd: PROJECT, timestamp: '2026-10-01T10:00:00Z' },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' }, sessionId: 'aaa' },
    { type: 'user', message: { content: 'napraw   logowanie\nw bocie' }, sessionId: 'aaa' },
  ]));
  writeFileSync(join(cdir, 'bbb.jsonl'), jsonl([
    { type: 'user', message: { content: 'pierwszy prompt' }, sessionId: 'bbb', cwd: PROJECT, timestamp: '2026-10-02T10:00:00Z' },
    { type: 'ai-title', aiTitle: 'Refaktor sidebaru', sessionId: 'bbb' },
  ]));
  writeFileSync(join(cdir, 'empty.jsonl'), jsonl([{ type: 'mode', sessionId: 'empty' }]));

  const xdir = join(home, '.codex', 'sessions', '2026', '10', '06');
  mkdirSync(xdir, { recursive: true });
  const meta = (id: string, cwd: string) => ({ type: 'session_meta', payload: { id, cwd, timestamp: '2026-10-06T10:00:00Z', base_instructions: { text: 'x'.repeat(90000) } } });
  const user = (text: string) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeFileSync(join(xdir, 'rollout-2026-10-06T10-00-00-c1.jsonl'), jsonl([
    meta('c1', PROJECT), user('# AGENTS.md instructions'), user('<environment_context>'), user('dodaj testy'),
  ]));
  writeFileSync(join(xdir, 'rollout-2026-10-06T11-00-00-c2.jsonl'), jsonl([meta('c2', 'D:\\Other'), user('inny projekt')]));
  return home;
}

describe('sessions', () => {
  it('encodes claude project dir names', () => {
    expect(claudeProjectDirName('C:\\Users\\x\\a.b c')).toBe('C--Users-x-a-b-c');
  });

  it('lists claude sessions with titles, skipping meta/command lines, junk and empty sessions', () => {
    const list = listClaudeSessions(fakeHome(), PROJECT);
    expect(list.map((s) => s.id).sort()).toEqual(['aaa', 'bbb']);
    expect(list.find((s) => s.id === 'aaa')!.title).toBe('napraw logowanie w bocie');
    expect(list.find((s) => s.id === 'bbb')!.title).toBe('Refaktor sidebaru');
  });

  it('lists codex sessions for the project only, skipping injected context', () => {
    const list = listCodexSessions(fakeHome(), PROJECT.toLowerCase() + '\\');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ cli: 'codex', id: 'c1', title: 'dodaj testy' });
  });

  it('finds a recently written codex session not bound elsewhere', () => {
    const home = fakeHome();
    expect(findRecentCodexSession(home, PROJECT, 60000, new Set())).toBe('c1');
    expect(findRecentCodexSession(home, PROJECT, 60000, new Set(['c1']))).toBeNull();
    expect(findRecentCodexSession(home, 'D:\Nowhere', 60000, new Set())).toBeNull();
  });
});
