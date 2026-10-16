import { describe, expect, it } from 'vitest';
import { isRecoverableAuthError, mapSshError, sshDebugFilter } from '../src/ptyhost/sshErrors';

const err = (code?: string, level?: string, message = '') => Object.assign(new Error(message), { code, level });

describe('mapSshError', () => {
  it.each([
    [err('ENOTFOUND'), 'dns'], [err('EAI_AGAIN'), 'dns'], [err('ECONNREFUSED'), 'refused'], [err('ETIMEDOUT'), 'timeout'],
    [err(undefined, 'client-timeout', 'Keepalive timeout'), 'timeout'], [err('EHOSTUNREACH'), 'unreachable'], [err('ENETUNREACH'), 'unreachable'],
    [err('ECONNRESET'), 'reset'], [err(undefined, 'client-authentication', 'All configured authentication methods failed'), 'auth'],
    [err(undefined, 'handshake', 'Handshake failed: no matching cipher'), 'protocol'], [err(undefined, undefined, 'no matching key exchange algorithm'), 'protocol'],
    [err('EWHATEVER'), 'unknown'], [null, 'unknown'], ['text', 'unknown'],
  ] as const)('%o -> %s', (input, expected) => expect(mapSshError(input)).toBe(expected));

  it('lets the reason main or the manager decided win', () => {
    expect(mapSshError(err('ECONNRESET'), 'hostKeyChanged')).toBe('hostKeyChanged');
  });

  it('drops every debug line from the start of user authentication on', () => {
    const keep = sshDebugFilter();
    expect(['Outbound: KEXINIT', 'Inbound: NEWKEYS', 'Outbound: Sending USERAUTH_REQUEST (password)', 'Inbound: USERAUTH_SUCCESS', 'CHANNEL_DATA'].map(keep)).toEqual([true, true, false, false, false]);
  });
});

describe('isRecoverableAuthError', () => {
  it('accepts ssh2 key signing failures only', () => {
    const e = (message: string, level = 'client-authentication') => Object.assign(new Error(message), { level });
    expect(isRecoverableAuthError(e('Error signing data with key: agent refused'))).toBe(true);
    expect(isRecoverableAuthError(e('Error while signing with key: bad hash'))).toBe(true);
    expect(isRecoverableAuthError(e('All configured authentication methods failed'))).toBe(false);
    expect(isRecoverableAuthError(e('Error signing data with key: x', 'protocol'))).toBe(false);
    expect(isRecoverableAuthError(null)).toBe(false);
  });
});
