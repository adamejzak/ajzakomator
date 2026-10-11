// src/main/auth/login.ts
import { randomUUID } from 'crypto';
import { isAccountId, type LoginRequest, type LoginState } from '../../shared/accounts';
import type { AccountsStore } from '../accounts/store';

export interface LoginDeps {
  store: AccountsStore;
  /** Starts the login command in a pty; `env` holds only the extra variables. */
  spawnPty(spec: { id: string; env: Record<string, string>; command: string }): void;
  killPty(id: string): void;
  /** Fingerprint (never the token) of the credentials the login writes, or null when there are none yet. */
  fingerprint(provider: 'claude' | 'codex', configDir: string | undefined): Promise<string | null>;
  identity(provider: 'claude' | 'codex', configDir: string | undefined): Promise<{ email?: string; org?: string }>;
  /** Lower-cased e-mails of the machine's own Claude login and of every managed account. */
  knownEmails(): Promise<string[]>;
  emit(state: LoginState): void;
  /** Called after a login succeeded so the usage service can refresh. */
  onChanged(): void;
  /** False where isolated Claude profiles cannot work (macOS keeps Claude tokens in the Keychain). Defaults to true. */
  profilesSupported?: boolean;
  pollMs?: number;
  settleMs?: number;
  timeoutMs?: number;
}

type Timer = ReturnType<typeof setTimeout>;

interface Session {
  id: string;
  ptyId: string;
  provider: 'claude' | 'codex';
  target: LoginRequest['target'];
  configDir: string | undefined;
  pendingId?: string;
  initial: string | null;
  settled: boolean;
  ended: boolean;
  polling: boolean;
  poll?: Timer;
  settle?: Timer;
  timeout?: Timer;
  sleeps: Set<Timer>;
}

const IDENTITY_TRIES = 5;
const IDENTITY_GAP_MS = 1000;

export class LoginManager {
  private current: Session | null = null;

  constructor(private readonly deps: LoginDeps) {}

  async start(request: LoginRequest): Promise<{ ok: true; sessionId: string; ptyId: string } | { ok: false; error: string }> {
    const invalid = { ok: false as const, error: 'invalid request' };
    const provider = (request as { provider?: unknown } | null)?.provider;
    const target = (request as { target?: { type?: unknown; id?: unknown } } | null)?.target;
    if ((provider !== 'claude' && provider !== 'codex') || typeof target !== 'object' || target === null) return invalid;
    if (provider === 'codex' && target.type !== 'main') return invalid;
    if (this.deps.profilesSupported === false && (target.type === 'new' || target.type === 'account')) return { ok: false, error: 'unsupported' };
    if (target.type === 'account') {
      if (!isAccountId(target.id) || !this.deps.store.list().some((account) => account.id === target.id)) return invalid;
    } else if (target.type !== 'new' && target.type !== 'main') {
      return invalid;
    }

    if (this.current) this.cancel(this.current.id);

    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      ptyId: `auth:${sessionId}`,
      provider,
      target: request.target,
      configDir: undefined,
      initial: null,
      settled: false,
      ended: false,
      polling: false,
      sleeps: new Set(),
    };
    if (target.type === 'new') {
      try {
        const pending = this.deps.store.prepare();
        session.pendingId = pending.id;
        session.configDir = pending.dir;
      } catch {
        return { ok: false, error: 'spawn' };
      }
    } else if (target.type === 'account') {
      session.configDir = this.deps.store.dirOf(target.id as string);
    }
    this.current = session;

    try {
      session.initial = await this.deps.fingerprint(provider, session.configDir);
    } catch {
      session.initial = null;
    }
    if (session.ended) return { ok: false, error: 'cancelled' };

    try {
      this.deps.spawnPty({
        id: session.ptyId,
        // A user-level token or API key must not override the profile's own login.
        env: session.configDir ? { CLAUDE_CONFIG_DIR: session.configDir, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' } : {},
        command: provider === 'claude' ? 'claude auth login --claudeai' : 'codex login',
      });
    } catch {
      this.end(session);
      this.discard(session);
      return { ok: false, error: 'spawn' };
    }

    session.poll = setInterval(() => void this.tick(session), this.deps.pollMs ?? 1500);
    session.timeout = setTimeout(() => this.onTimeout(session), this.deps.timeoutMs ?? 600000);
    this.deps.emit({ sessionId, status: 'waiting' });
    return { ok: true, sessionId, ptyId: session.ptyId };
  }

  cancel(sessionId: string): void {
    const session = this.current;
    if (!session || session.id !== sessionId) return;
    this.end(session);
    this.kill(session);
    this.discard(session);
  }

  /** The pty host died: ends the current session as failed. */
  failActive(error: 'spawn'): void {
    const session = this.current;
    if (!session) return;
    this.end(session);
    this.kill(session);
    this.discard(session);
    this.deps.emit({ sessionId: session.id, status: 'failed', error });
  }

  /** Cancels the active session when it targets this managed account. */
  cancelFor(accountId: string): void {
    const session = this.current;
    if (session && session.target.type === 'account' && session.target.id === accountId) this.cancel(session.id);
  }

  dispose(): void {
    if (this.current) this.cancel(this.current.id);
  }

  private async tick(session: Session): Promise<void> {
    if (session.ended || session.settled || session.polling || session.settle) return;
    session.polling = true;
    let fingerprint: string | null = null;
    try {
      fingerprint = await this.deps.fingerprint(session.provider, session.configDir);
    } catch {
      fingerprint = null;
    }
    session.polling = false;
    if (session.ended || session.settled || session.settle) return;
    if (fingerprint !== null && fingerprint !== session.initial) {
      session.settle = setTimeout(() => void this.finalize(session), this.deps.settleMs ?? 1500);
    }
  }

  private onTimeout(session: Session): void {
    if (session.ended || session.settled) return;
    session.settled = true;
    this.end(session);
    this.kill(session);
    this.discard(session);
    this.deps.emit({ sessionId: session.id, status: 'failed', error: 'timeout' });
  }

  private async finalize(session: Session): Promise<void> {
    try {
      await this.runFinalize(session);
    } catch {
      // a store failure must not leave the session half-finished
      if (!session.ended) this.finish(session, { sessionId: session.id, status: 'failed', error: 'identity' }, true);
    }
  }

  private async runFinalize(session: Session): Promise<void> {
    if (session.ended || session.settled) return;
    session.settled = true;
    this.clearTimers(session);
    this.kill(session);

    let identity: { email?: string; org?: string } = {};
    for (let attempt = 0; attempt < IDENTITY_TRIES; attempt++) {
      try {
        identity = await this.deps.identity(session.provider, session.configDir);
      } catch {
        identity = {};
      }
      if (session.ended) return;
      if (identity.email || attempt === IDENTITY_TRIES - 1) break;
      await this.sleep(session, IDENTITY_GAP_MS);
      if (session.ended) return;
    }
    const { email, org } = identity;
    const target = session.target;

    if (target.type === 'new') {
      if (!email) {
        this.finish(session, { sessionId: session.id, status: 'failed', error: 'identity' }, true);
        return;
      }
      let known: string[] = [];
      try {
        known = await this.deps.knownEmails();
      } catch {
        known = [];
      }
      if (session.ended) return;
      if (known.includes(email.toLowerCase())) {
        this.finish(session, { sessionId: session.id, status: 'duplicate', email }, true);
        return;
      }
      this.deps.store.commit({ id: session.pendingId as string, email, ...(org ? { org } : {}), addedAt: Date.now() });
      session.pendingId = undefined;
    } else if (target.type === 'account' && email) {
      this.deps.store.update(target.id, { email, ...(org ? { org } : {}) });
    }
    this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
    this.deps.onChanged();
  }

  private finish(session: Session, state: LoginState, discard: boolean): void {
    this.end(session);
    if (discard) this.discard(session);
    this.deps.emit(state);
  }

  private sleep(session: Session, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        session.sleeps.delete(timer);
        resolve();
      }, ms);
      session.sleeps.add(timer);
    });
  }

  private clearTimers(session: Session): void {
    if (session.poll) clearInterval(session.poll);
    if (session.settle) clearTimeout(session.settle);
    if (session.timeout) clearTimeout(session.timeout);
    session.poll = session.settle = session.timeout = undefined;
  }

  /** Clears every timer and forgets the session; the single place a session ends. */
  private end(session: Session): void {
    session.ended = true;
    this.clearTimers(session);
    for (const timer of session.sleeps) clearTimeout(timer);
    session.sleeps.clear();
    if (this.current === session) this.current = null;
  }

  private kill(session: Session): void {
    try {
      this.deps.killPty(session.ptyId);
    } catch {
      // the pty may already be gone
    }
  }

  private discard(session: Session): void {
    if (!session.pendingId) return;
    const id = session.pendingId;
    session.pendingId = undefined;
    try {
      this.deps.store.remove(id);
    } catch {
      // best effort; the directory is not listed anywhere
    }
  }
}
