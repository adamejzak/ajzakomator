import { describe, expect, it } from 'vitest';
import { HookServer } from '../src/main/hooks';
import {
  CODEX_ATTENTION_TYPES, codexHookOverrides, codexNotifyArgv, CodexThreads, parseCodexNotify,
  type CodexNotice,
} from '../src/shared/codexHooks';
import { FailureScanner, normalizeOutput } from '../src/shared/outputFailure';
import { buildLaunchCommand, DEFAULT_PROFILES } from '../src/shared/profiles';

const A = '3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091';
const B = '0198aa11-2222-7333-8444-555566667777';
const C = '0198aa11-9999-7333-8444-555566667777';
const URL = 'http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/cell-1/codex/89abcdef01234567';
const codex = DEFAULT_PROFILES.find((p) => p.cli === 'codex')!;

const payload = (patch: Record<string, unknown> = {}) => JSON.stringify({
  type: 'agent-turn-complete', 'thread-id': A, 'turn-id': 'turn-1', cwd: 'D:\\bot-discord', client: 'codex-tui',
  'input-messages': ['hello'], 'last-assistant-message': 'done', ...patch,
});

describe('Codex notify payload', () => {
  it('reads the thread and turn of a completed turn and nothing else', () => {
    expect(parseCodexNotify(payload())).toEqual({ threadId: A, turnId: 'turn-1' });
    expect(parseCodexNotify(payload({ 'thread-id': A.toUpperCase() }))?.threadId).toBe(A);
    expect(Object.keys(parseCodexNotify(payload())!).sort()).toEqual(['threadId', 'turnId']);
  });

  it('drops malformed ids but still reports the turn end', () => {
    expect(parseCodexNotify(payload({ 'thread-id': '../../etc/passwd' }))).toEqual({ turnId: 'turn-1' });
    expect(parseCodexNotify(payload({ 'thread-id': 42, 'turn-id': { a: 1 } }))).toEqual({});
    expect(parseCodexNotify(payload({ 'turn-id': 'x'.repeat(500) }))).toEqual({ threadId: A });
    expect(parseCodexNotify(payload({ 'turn-id': 'a b; rm -rf /' }))).toEqual({ threadId: A });
  });

  it('rejects anything that is not a completed-turn object', () => {
    for (const body of ['', 'not json', '[]', 'null', '42', '"agent-turn-complete"', JSON.stringify({ type: 'something-else' }), JSON.stringify({}), '{"type":']) {
      expect(parseCodexNotify(body), body).toBeNull();
    }
  });

  it('survives hostile and huge payloads', () => {
    expect(parseCodexNotify(payload({ 'last-assistant-message': 'x'.repeat(2_000_000) }))).toEqual({ threadId: A, turnId: 'turn-1' });
    expect(parseCodexNotify('{"type":"agent-turn-complete","__proto__":{"threadId":"x"},"thread-id":"' + A + '"}')).toEqual({ threadId: A });
  });
});

describe('Codex launch overrides', () => {
  it('builds a curl notify argv whose last flag takes the appended payload', () => {
    const argv = codexNotifyArgv(URL);
    expect(argv[0]).toBe('curl');
    expect(argv).toContain(URL);
    expect(argv[argv.length - 1]).toBe('--data-raw');
    expect(argv).toEqual(expect.arrayContaining(['--noproxy', '*', '-m', '2']));
  });

  it('uses TOML literal strings only: no double quote reaches any shell', () => {
    const overrides = codexHookOverrides(URL);
    expect(overrides[0]).toBe(`notify=['curl','-s','--noproxy','*','-m','2','${URL}','--data-raw']`);
    expect(overrides[1]).toBe(`tui.notifications=[${CODEX_ATTENTION_TYPES.map((t) => `'${t}'`).join(',')}]`);
    expect(overrides[2]).toBe("tui.notification_condition='always'");
    for (const o of overrides) expect(o).not.toContain('"');
  });

  it('refuses a URL that could break out of the TOML value', () => {
    for (const bad of ["http://127.0.0.1:1/h/abc/x'],evil=['/codex/ab", 'http://evil.example/h/0123456789abcdef/cell/codex/0123456789abcdef', `${URL}'`, `${URL} --x`, '']) {
      expect(() => codexNotifyArgv(bad), bad).toThrow('Invalid hook URL');
    }
  });

  it('quotes the overrides for PowerShell, bash/zsh and cmd', () => {
    const [notify, tui, cond] = codexHookOverrides(URL);
    const ps = buildLaunchCommand(codex, { mode: 'new', shell: 'pwsh', codexNotifyUrl: URL })!;
    expect(ps).toBe(`codex -c '${notify.replace(/'/g, "''")}' -c '${tui.replace(/'/g, "''")}' -c '${cond.replace(/'/g, "''")}'`);
    const posix = buildLaunchCommand(codex, { mode: 'new', shell: 'bash', codexNotifyUrl: URL })!;
    expect(posix).toBe(`codex -c ${posixQuoted(notify)} -c ${posixQuoted(tui)} -c ${posixQuoted(cond)}`);
    expect(buildLaunchCommand(codex, { mode: 'new', shell: 'zsh', codexNotifyUrl: URL })).toBe(posix);
    const cmd = buildLaunchCommand(codex, { mode: 'new', shell: 'cmd', codexNotifyUrl: URL })!;
    expect(cmd).toBe(`codex -c "${notify}" -c "${tui}" -c "${cond}"`);
    // cmd metacharacters never occur in the generated overrides
    expect(notify.replace(/[A-Za-z0-9'\[\],:/.*=_%-]/g, '')).toBe('');
  });

  it('resumes the saved conversation of the cell with its own hook and keeps profile args and model', () => {
    const command = buildLaunchCommand({ ...codex, args: '--no-alt-screen' }, { mode: 'resume', sessionId: B, shell: 'bash', codexNotifyUrl: URL, model: 'gpt-5' })!;
    expect(command.startsWith(`codex resume ${B} -c `)).toBe(true);
    expect(command).toContain(URL);
    expect(command.endsWith(`--no-alt-screen --model 'gpt-5'`)).toBe(true);
    expect(command).not.toContain('tui.notifications=true');
  });

  it('keeps the plain terminal notifications when no hook url is given', () => {
    expect(buildLaunchCommand(codex, { mode: 'new' })).toBe('codex -c tui.notifications=true');
  });
});

const posixQuoted = (s: string) => "'" + s.replace(/'/g, "'\"'\"'") + "'";

describe('HookServer codex events', () => {
  const post = (url: string, body: string) => fetch(url, { method: 'POST', body });
  const wait = () => new Promise((r) => setTimeout(r, 60));

  it('emits a notice per valid request of the current process and drops every other one', async () => {
    const s = new HookServer();
    await s.start();
    const seen: Array<[string, CodexNotice]> = [];
    const status: string[] = [];
    s.on('codex', (cell: string, notice: CodexNotice) => seen.push([cell, notice]));
    s.on('hook', (cell: string, event: string) => status.push(`${cell}:${event}`));
    try {
      const old = s.prepareCodex('c1');
      const url = s.prepareCodex('c1'); // a respawn invalidates the previous process
      expect(url).toContain(`/h/${s.token}/c1/codex/`);
      expect((await post(old, payload())).status).toBe(204);
      expect((await post(url, payload())).status).toBe(204);
      await post(url, 'not json');
      await post(url, JSON.stringify({ type: 'other' }));
      await post(`http://127.0.0.1:${s.port}/h/wrong/c1/codex/x`, payload()).catch(() => {});
      await post(url.replace('/c1/', '/c2/'), payload());
      expect((await fetch(url)).status).toBe(403);
      await wait();
      expect(seen).toEqual([['c1', { threadId: A, turnId: 'turn-1' }]]);
      expect(status).toEqual([]);
    } finally {
      s.stop();
    }
  });

  it('accepts a large payload and counts an oversized one as a turn end without ids', async () => {
    const s = new HookServer();
    await s.start();
    const seen: CodexNotice[] = [];
    s.on('codex', (_cell: string, notice: CodexNotice) => seen.push(notice));
    try {
      const url = s.prepareCodex('c1');
      await post(url, payload({ 'last-assistant-message': 'y'.repeat(200_000) }));
      await post(url, 'x'.repeat(1_200_000));
      await wait();
      expect(seen).toEqual([{ threadId: A, turnId: 'turn-1' }, {}]);
    } finally {
      s.stop();
    }
  });
});

describe('thread bookkeeping of Codex cells', () => {
  it('binds the first committed thread unconfirmed and confirms it when the same thread commits again', () => {
    const t = new CodexThreads();
    t.begin();
    expect(t.commit(A)).toEqual({ id: A, confirmed: false });
    expect(t.commit(A)).toEqual({ id: A, confirmed: true });
    expect(t.commit(A)).toBeNull();
  });

  it('keeps two cells of one folder apart', () => {
    const one = new CodexThreads();
    const two = new CodexThreads();
    one.begin();
    two.begin();
    expect(two.commit(B)).toEqual({ id: B, confirmed: false });
    expect(one.commit(A)).toEqual({ id: A, confirmed: false });
    expect(one.commit(A)?.confirmed).toBe(true);
    expect(two.commit(B)?.confirmed).toBe(true);
  });

  it('starts from the stored session and never rebinds it for the same thread', () => {
    const t = new CodexThreads();
    t.begin({ id: B, confirmed: true });
    expect(t.commit(B)).toBeNull();
    const unconfirmed = new CodexThreads();
    unconfirmed.begin({ id: B });
    expect(unconfirmed.commit(B)).toBeNull();
    expect(unconfirmed.commit(B)).toEqual({ id: B, confirmed: true });
  });

  it('never binds a thread seen as a sub-agent, and never marks the own thread of the cell as one', () => {
    const t = new CodexThreads();
    t.begin({ id: A, confirmed: true });
    expect(t.markSecondary(C)).toBe(true);
    expect(t.isSecondary(C)).toBe(true);
    expect(t.commit(C)).toBeNull();
    expect(t.commit(C)).toBeNull();
    expect(t.markSecondary(A)).toBe(false);
    expect(t.isSecondary(A)).toBe(false);
    const fresh = new CodexThreads();
    fresh.begin();
    fresh.markSecondary(C);
    expect(fresh.commit(C)).toBeNull();
    expect(fresh.commit(A)).toEqual({ id: A, confirmed: false });
  });

  it('follows a conversation switch (/new, /resume) only after the new thread committed twice without the old one in between', () => {
    const t = new CodexThreads();
    t.begin({ id: A, confirmed: true });
    expect(t.commit(C)).toBeNull();
    expect(t.commit(A)).toBeNull(); // the old thread reports again: the candidate starts over
    expect(t.commit(C)).toBeNull();
    expect(t.commit(C)).toEqual({ id: C, confirmed: true });
    expect(t.commit(C)).toBeNull();
  });

  it('ignores payloads without a thread', () => {
    const t = new CodexThreads();
    t.begin();
    expect(t.commit(undefined)).toBeNull();
  });

  it('uses the stored id only when it is a thread id', () => {
    const t = new CodexThreads();
    t.begin({ id: 'not-a-uuid', confirmed: true });
    expect(t.commit(A)).toEqual({ id: A, confirmed: false });
  });
});

describe('resume of two Codex cells in one folder', () => {
  it('resumes each cell with its own saved conversation, in every shell', () => {
    for (const [cell, id] of [['c1', A], ['c2', B]] as const) {
      for (const shell of ['pwsh', 'bash', 'cmd'] as const) {
        const command = buildLaunchCommand(codex, { mode: 'resume', sessionId: id, shell, codexNotifyUrl: URL.replace('cell-1', cell) })!;
        expect(command.startsWith(`codex resume ${id} -c `), `${cell} ${shell}`).toBe(true);
        expect(command).toContain(`/${cell}/codex/`);
      }
    }
  });
});

describe('failure line of Codex output', () => {
  const line = (text: string) => `\x1b[31m■ ${text}\x1b[0m\r\n`;

  it('recognizes the usage limit however the terminal draws it', () => {
    expect(new FailureScanner().feed(line('You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:45 PM.'))).toBe('usage-limit');
    expect(new FailureScanner().feed(line("You've hit your usage limit. Try again later."))).toBe('usage-limit');
    expect(new FailureScanner().feed(line('You’ve hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now.'))).toBe('usage-limit');
    expect(new FailureScanner().feed(line('Quota exceeded. Check your plan and billing details.'))).toBe('usage-limit');
    expect(new FailureScanner().feed('\x1b[5;1H\x1b[31m■\x1b[1CYou’ve\x1b[1Chit\x1b[1Cyour\x1b[1Cusage\x1b[1Climit.')).toBe('usage-limit');
    expect(new FailureScanner().feed('   \x1b[31m■ You’ve hit your usage limit.\r\n')).toBe('usage-limit'); // leading blanks are fine
  });

  it('finds a message split over several chunks and wrapped over lines, and reports it once', () => {
    const s = new FailureScanner();
    expect(s.feed('\x1b[31m■ You’ve hit your us')).toBeNull();
    expect(s.feed('age li')).toBeNull();
    expect(s.feed('mit.\r\n')).toBe('usage-limit');
    expect(s.feed('prompt >')).toBeNull();
    const wrapped = new FailureScanner();
    expect(wrapped.feed('■ You’ve hit your\r\n  usage\r\n  limit. Try again later.')).toBe('usage-limit');
    const once = new FailureScanner();
    expect(once.feed('■ You’ve hit your usage limit.')).toBe('usage-limit');
    expect(once.feed(' Try again later.\r\n')).toBeNull();
  });

  it('does not fire for a line that merely contains the text (grep results, diffs, listings, source, an answer quoting it)', () => {
    const s = new FailureScanner();
    // the reviewer's repro: an rg result line of a test file, with the literal escape text and with a real escape
    expect(s.feed("test/codex-status.test.ts:16:const LIMIT_LINE = '\\x1b[31m■ You’ve hit your usage limit. Try again later.\\x1b[0m\\r\\n';\r\n")).toBeNull();
    expect(s.feed("\x1b[35mtest/codex-status.test.ts\x1b[0m:16:const LIMIT_LINE = '\x1b[31m■ You’ve hit your usage limit.\x1b[0m';\r\n")).toBeNull();
    expect(s.feed('+  const message = "■ You’ve hit your usage limit";\r\n')).toBeNull();
    expect(s.feed('  16 │ ■ You’ve hit your usage limit.\r\n')).toBeNull();
    expect(s.feed('• The CLI prints “■ You’ve hit your usage limit” when the plan is exhausted.\r\n')).toBeNull();
    expect(s.feed('• Fixed: the line "You’ve hit your usage limit" is shown in red\r\n')).toBeNull();
    expect(s.feed("  - 'You’ve hit your usage limit' is shown in red\r\n")).toBeNull();
    expect(s.feed('■ stream disconnected before completion: Idle timeout\r\n')).toBeNull();
    expect(s.feed('')).toBeNull();
  });

  it('a bullet line that wraps into an unrelated text is not a hit', () => {
    const s = new FailureScanner();
    expect(s.feed('■ Selected model is at capacity.\r\nYou’ve hit your usage limit in another place\r\n')).toBeNull();
  });

  it('is cheap on hostile input', () => {
    const started = Date.now();
    const s = new FailureScanner();
    expect(s.feed('\x1b['.repeat(100_000) + 'x'.repeat(5_000_000))).toBeNull();
    expect(s.feed('\r\n'.repeat(200_000))).toBeNull();
    expect(normalizeOutput('a\x1b]0;title\x07 b\x1b[?25l')).toBe('ab');
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
