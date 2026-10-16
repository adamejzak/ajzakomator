// src/main/auth/login.ts
import { randomUUID } from 'crypto';
import { compareIdentity, identityFields, isAccountId, type AccountIdentity, type LoginRequest, type LoginState } from '../../shared/accounts';
import type { AccountsStore } from '../accounts/store';
import type { ProfileSnapshot } from './profileSnapshot';

/** An account the app knows: the live login (`live`) or a saved record. */
export interface KnownIdentity extends AccountIdentity { recordId?: string; live?: boolean }
/** What a finished login changed, so the usage panel reads exactly that account at once. */
export interface LoginChange { provider: 'claude' | 'codex'; recordId?: string; ownChange?: boolean }

export interface LoginDeps {
  store: AccountsStore;
  /** Starts the login command in a pty; `env` holds only the extra variables. */
  spawnPty(spec: { id: string; env: Record<string, string>; command: string }): void;
  killPty(id: string): void;
  /** Fingerprint (never the token) of the credentials the login writes, or null when there are none yet. */
  fingerprint(provider: 'claude' | 'codex', configDir: string | undefined): Promise<string | null>;
  /** Drops cached failed credential reads (macOS Keychain) so the login sees fresh credentials. Called before each fingerprint read. */
  resetCredentialCache?(): void;
  identity(provider: 'claude' | 'codex', configDir: string | undefined): Promise<AccountIdentity>;
  /** The live Claude login and every saved account that is not set aside. */
  knownIdentities(): Promise<KnownIdentity[]>;
  /** Login files of a saved profile, taken before it is signed in again (memory only). */
  snapshotProfile(dir: string): Promise<ProfileSnapshot>;
  /** Puts a snapshot back: the re-login signed in a different account, or one the app already has. */
  restoreProfile(dir: string, snapshot: ProfileSnapshot): Promise<void>;
  /**
   * Before a main Claude login: the outgoing live login is backed up into its record. Rejects when it could not be backed
   * up (or is not current), and the login is then refused with `busy`, so a live login is never replaced unsaved.
   */
  beforeMainLogin?(): Promise<void>;
  emit(state: LoginState): void;
  /** Called after a login succeeded. */
  onChanged(change: LoginChange): void;
  /** False where isolated Claude profiles cannot work (macOS keeps Claude tokens in the Keychain). Defaults to true. */
  profilesSupported?: boolean;
  /** True while the main account is being swapped; a login must not touch the same files meanwhile. */
  swapRunning?: () => boolean;
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
  snapshot?: ProfileSnapshot;
  initial: string | null;
  settled: boolean;
  ended: boolean;
  polling: boolean;
  poll?: Timer;
  settle?: Timer;
  timeout?: Timer;
  sleeps: Set<Timer>;
}

/** `--claudeai` is not in the public CLI reference but is what the existing login flow has used and verified; plain `claude auth login` would show an interactive method menu on some versions. */
export const loginCommand = (provider: 'claude' | 'codex'): string => (provider === 'claude' ? 'claude auth login --claudeai' : 'codex login');

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
    if (this.deps.swapRunning?.()) return { ok: false, error: 'busy' };
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
      // The card's current login is kept so a wrong account can be undone; the outgoing live login is backed up first.
      if (provider === 'claude' && target.type === 'account') session.snapshot = await this.deps.snapshotProfile(session.configDir as string);
      if (provider === 'claude' && target.type === 'main') await this.deps.beforeMainLogin?.();
    } catch {
      // No snapshot: a wrong account could not be undone. No backup: the live login would be lost. Either way, nothing starts.
      this.end(session);
      return { ok: false, error: target.type === 'main' ? 'busy' : 'spawn' };
    }
    if (session.ended) return { ok: false, error: 'cancelled' };

    try {
      this.deps.resetCredentialCache?.();
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
        command: loginCommand(provider),
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

  /** True while a login session is in progress. */
  isActive(): boolean {
    return this.current !== null;
  }

  cancel(sessionId: string): void {
    const session = this.current;
    if (!session || session.id !== sessionId) return;
    const written = this.loginWritten(session);
    this.end(session);
    this.kill(session);
    this.undo(session, written);
    this.discard(session);
  }

  /** The pty host died: ends the current session as failed. */
  failActive(error: 'spawn'): void {
    const session = this.current;
    if (!session) return;
    const written = this.loginWritten(session);
    this.end(session);
    this.kill(session);
    this.undo(session, written);
    this.discard(session);
    this.deps.emit({ sessionId: session.id, status: 'failed', error });
  }

  /** Cancels the active session when it targets this managed account. */
  cancelFor(accountId: string): void {
    const session = this.current;
    if (!session || session.target.type !== 'account' || session.target.id !== accountId) return;
    // The account is being removed: its profile goes away, nothing is put back.
    session.snapshot = undefined;
    this.cancel(session.id);
  }

  dispose(): void {
    if (this.current) this.cancel(this.current.id);
  }

  private async tick(session: Session): Promise<void> {
    if (session.ended || session.settled || session.polling || session.settle) return;
    session.polling = true;
    let fingerprint: string | null = null;
    try {
      this.deps.resetCredentialCache?.();
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
    const written = this.loginWritten(session);
    session.settled = true;
    this.end(session);
    this.kill(session);
    this.undo(session, written);
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

    let identity: AccountIdentity = {};
    for (let attempt = 0; attempt < IDENTITY_TRIES; attempt++) {
      try {
        identity = await this.deps.identity(session.provider, session.configDir);
      } catch {
        identity = {};
      }
      if (session.ended) return;
      if (identity.email || identity.accountUuid || attempt === IDENTITY_TRIES - 1) break;
      await this.sleep(session, IDENTITY_GAP_MS);
      if (session.ended) return;
    }
    const { email } = identity;
    const target = session.target;
    if (session.provider === 'codex' || target.type === 'main') {
      this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
      this.deps.onChanged({ provider: session.provider, ...(session.provider === 'claude' ? { ownChange: true } : {}) });
      return;
    }
    if (!email && !identity.accountUuid) {
      await this.restore(session);
      this.finish(session, { sessionId: session.id, status: 'failed', error: 'identity' }, true);
      return;
    }
    let known: KnownIdentity[] = [];
    try { known = await this.deps.knownIdentities(); } catch { known = []; }
    if (session.ended) return;
    const self = target.type === 'account' ? target.id : undefined;
    if (known.some((k) => k.recordId !== self && compareIdentity(k, identity) === 'same')) {
      await this.restore(session);
      this.finish(session, { sessionId: session.id, status: 'duplicate', ...(email ? { email } : {}) }, true);
      return;
    }
    if (target.type === 'new') {
      const recordId = session.pendingId as string;
      this.deps.store.commit({ id: recordId, addedAt: Date.now(), ...identityFields(identity), custody: 'app', family: 'own' });
      session.pendingId = undefined;
      this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
      this.deps.onChanged({ provider: 'claude', recordId });
      return;
    }
    // A card is signed in again only as the account it belongs to; another account never relabels it (R10).
    const record = this.deps.store.get(target.id);
    if (!record || compareIdentity(identity, record) !== 'same') {
      await this.restore(session);
      this.finish(session, { sessionId: session.id, status: 'mismatch', ...(email ? { email } : {}), ...(record?.email ? { expected: record.email } : {}) }, true);
      return;
    }
    // A fresh token family of the card's own account: the app holds it alone (custody app, family own), also for a card
    // that another tool had switched out (foreign).
    this.deps.store.updateIdentity(target.id, identity);
    this.deps.store.setCustody(target.id, 'app');
    this.deps.store.setFamily(target.id, 'own');
    this.finish(session, { sessionId: session.id, status: 'success', ...(email ? { email } : {}) }, false);
    this.deps.onChanged({ provider: 'claude', recordId: target.id });
  }

  /** Puts the card's previous login back; a failure leaves the new login, which the next poll shows under its real identity. */
  private async restore(session: Session): Promise<void> {
    const { snapshot, configDir } = session;
    session.snapshot = undefined;
    if (!snapshot || !configDir) return;
    try { await this.deps.restoreProfile(configDir, snapshot); } catch { /* see above */ }
  }

  /** The login has already written new files into the card's profile (its identity is checked only when it settles). */
  private loginWritten(session: Session): boolean {
    return session.settled || session.settle !== undefined;
  }

  /** A session that ends without a verdict puts the card's previous login back once the login wrote new files. */
  private undo(session: Session, written: boolean): void {
    if (written) void this.restore(session);
    else session.snapshot = undefined;
  }

  private finish(session: Session, state: LoginState, discard: boolean): void {
    session.snapshot = undefined;
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
