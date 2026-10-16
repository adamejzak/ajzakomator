import { describe, expect, it } from 'vitest';
import { mapSshError, sshDebugFilter } from '../src/ptyhost/sshErrors';

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
