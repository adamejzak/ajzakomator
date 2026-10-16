// Maps ssh2 and socket errors to the fixed codes the UI shows (spec 8.2). Raw messages never leave the Pty Host.
import type { SshErrorCode } from '../shared/ssh';

export function mapSshError(err: unknown, override?: SshErrorCode): SshErrorCode {
  if (override) return override;
  const e = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; level?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const level = typeof e.level === 'string' ? e.level : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'EAI_NONAME') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ETIMEDOUT' || level === 'client-timeout') return 'timeout';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN' || code === 'ENETDOWN') return 'unreachable';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') return 'reset';
  if (level === 'client-authentication') return 'auth';
  if (level === 'handshake' || level === 'protocol' || /no matching|handshake failed/i.test(message)) return 'protocol';
  return 'unknown';
}

/**
 * ssh2 reports a key that could not sign (agent refused, unsupported hash) as a 'client-authentication' error and then
 * tries the next method by itself; only the final "All configured authentication methods failed" ends the session.
 */
export function isRecoverableAuthError(err: unknown): boolean {
  const e = (typeof err === 'object' && err !== null ? err : {}) as { level?: unknown; message?: unknown };
  return e.level === 'client-authentication' && typeof e.message === 'string' && /^Error (?:signing data|while signing) with key/.test(e.message);
}

/** ssh2 debug output is only wired in unpackaged runs; everything from user authentication on is dropped (it may name methods and users). */
export function sshDebugFilter(): (line: string) => boolean {
  let authStarted = false;
  return (line) => {
    if (/USERAUTH/i.test(line)) authStarted = true;
    return !authStarted;
  };
}
