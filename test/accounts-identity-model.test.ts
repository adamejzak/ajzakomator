import { describe, expect, it } from 'vitest';
import { compareIdentity, custodyOf, familyOf, fillMissingIdentity, identityFields, identityFromOauthAccount, identityKey } from '../src/shared/accounts';

describe('account identity', () => {
  it('compares by accountUuid (+ organizationUuid) first', () => {
    expect(compareIdentity({ accountUuid: 'u1', email: 'a@x.com' }, { accountUuid: 'u1', email: 'other@x.com' })).toBe('same');
    expect(compareIdentity({ accountUuid: 'u1' }, { accountUuid: 'u2' })).toBe('different');
    expect(compareIdentity({ accountUuid: 'u1', organizationUuid: 'o1' }, { accountUuid: 'u1', organizationUuid: 'o2' })).toBe('different');
    expect(compareIdentity({ accountUuid: 'u1', organizationUuid: 'o1' }, { accountUuid: 'u1' })).toBe('same');
  });
  it('falls back to the e-mail with the organisation, never to the organisation name alone', () => {
    expect(compareIdentity({ email: 'A@x.com' }, { email: 'a@X.com ' })).toBe('same');
    expect(compareIdentity({ email: 'a@x.com', org: 'Acme' }, { email: 'a@x.com', org: 'Other' })).toBe('different');
    expect(compareIdentity({ email: 'a@x.com', organizationUuid: 'o1' }, { email: 'a@x.com', organizationUuid: 'o2' })).toBe('different');
    expect(compareIdentity({ email: 'a@x.com' }, { email: 'b@x.com' })).toBe('different');
    expect(compareIdentity({ org: 'Acme' }, { org: 'Acme' })).toBe('unknown');
    expect(compareIdentity({}, { email: 'a@x.com' })).toBe('unknown');
  });
  it('keys cache entries by identity', () => {
    expect(identityKey({ accountUuid: 'u1', organizationUuid: 'o1', email: 'a@x.com' })).toBe('uuid:u1:o1');
    expect(identityKey({ accountUuid: 'u1' })).toBe('uuid:u1:-');
    expect(identityKey({ email: 'A@x.com', org: 'Acme' })).toBe('email:a@x.com:acme');
    expect(identityKey({ org: 'Acme' })).toBeUndefined();
  });
  it('reads oauthAccount of a .claude.json and keeps only non-empty strings', () => {
    expect(identityFromOauthAccount({ emailAddress: 'a@x.com', organizationName: 'Acme', accountUuid: 'u1', organizationUuid: 'o1', displayName: 'A' }))
      .toEqual({ email: 'a@x.com', org: 'Acme', accountUuid: 'u1', organizationUuid: 'o1' });
    expect(identityFromOauthAccount(null)).toEqual({});
    expect(identityFields({ email: '', org: 'x', accountUuid: 7 as unknown as string })).toEqual({ org: 'x' });
  });
  it('fills only the identity fields a record lacks', () => {
    expect(fillMissingIdentity({ email: 'a@x.com', org: 'Acme' }, { email: 'b@x.com', org: 'Other', accountUuid: 'u1', organizationUuid: 'o1' }))
      .toEqual({ accountUuid: 'u1', organizationUuid: 'o1' });
    expect(fillMissingIdentity({ accountUuid: 'u1' }, {})).toEqual({});
  });
  it('defaults: custody app, family live (unknown provenance)', () => {
    expect(custodyOf({})).toBe('app');
    expect(familyOf({})).toBe('live');
  });
});
