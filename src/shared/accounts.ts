// src/shared/accounts.ts

/** A Claude account added inside the app, kept in its own isolated profile directory. */
export interface ManagedAccount {
  id: string;
  email?: string;
  org?: string;
  addedAt: number;
}

export type LoginTarget = { type: 'new' } | { type: 'main' } | { type: 'account'; id: string };

export interface LoginRequest {
  provider: 'claude' | 'codex';
  target: LoginTarget;
}

export type LoginStatus = 'waiting' | 'success' | 'failed' | 'duplicate';

export interface LoginState {
  sessionId: string;
  status: LoginStatus;
  email?: string;
  error?: 'timeout' | 'spawn' | 'identity';
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Account ids arrive over IPC and become path segments, so only UUIDs are accepted. */
export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

/** Why making a managed account the main one was refused or failed (see `swapMainAccount` in the main process). */
export const SWAP_ERRORS = ['unsupported', 'invalid', 'busy', 'envToken', 'noMain', 'noTarget', 'sameAccount', 'duplicate', 'dead', 'transient', 'write', 'manual', 'pending'] as const;
export type SwapError = (typeof SWAP_ERRORS)[number];

export type SwapResult = { ok: true; email?: string } | { ok: false; error: SwapError };

export function isSwapError(value: unknown): value is SwapError {
  return typeof value === 'string' && (SWAP_ERRORS as readonly string[]).includes(value);
}

/** Outcome of `recoverInterruptedSwap`: nothing to do, state repaired, or ambiguous (nothing modified; backup kept; tell the user to check). */
export type SwapRecovery = 'none' | 'recovered' | 'manual';

/** Outcome of restoring the pre-swap backup: done, refused (a swap runs) or not possible (nothing was changed, or check the accounts). */
