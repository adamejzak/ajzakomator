// The renderer SSH store with no DOM (R1): a reload restores sessions and open prompts from the snapshot (Review Focus 2).
import { beforeAll, describe, expect, it } from 'vitest';

let store: any;
beforeAll(async () => {
  const modulePath = '../src/renderer/src/sshStore';
  store = await import(/* @vite-ignore */ modulePath);
});

const s = (cellId: string, phase: string) => ({ cellId, hostId: 'h', phase, since: 0 });

describe('useSshStore', () => {
  it('loads a snapshot, follows session and prompt events and forgets closed cells', () => {
    const { useSshStore } = store;
    const prompt = { id: 'p1', kind: 'hostKey', endpoint: 'e', keyType: 'ssh-ed25519', fingerprint: 'SHA256:x', reason: 'unknown', knownFingerprints: [], knownTypes: [] };
    useSshStore.getState().load({ storage: 'dpapi', keys: [], savedPasswords: [], lockedPasswords: [], readOnly: false }, { sessions: [s('a', 'verifying')], prompts: [{ cellId: 'a', prompt }] });
    expect(useSshStore.getState().prompts.a.id).toBe('p1');
    useSshStore.getState().setPrompt('a', null);
    useSshStore.getState().setSession(s('a', 'connected'));
    expect(useSshStore.getState().prompts.a).toBeUndefined();
    expect(useSshStore.getState().sessions.a.phase).toBe('connected');
    useSshStore.getState().forgetCell('a');
    expect(useSshStore.getState().sessions.a).toBeUndefined();
    expect(useSshStore.getState().vault.storage).toBe('dpapi');
  });
});

describe('createInitGate (M7)', () => {
  it('holds events that arrive while the snapshot loads and applies them after load, in order', () => {
    const { useSshStore, createInitGate } = store;
    const gate = createInitGate();
    const onSession = gate.wrap((st: ReturnType<typeof s>) => useSshStore.getState().setSession(st));
    const vault = { storage: 'dpapi', keys: [], savedPasswords: [], lockedPasswords: [], readOnly: false };
    onSession(s('m7', 'authenticating'));
    onSession(s('m7', 'connected'));
    expect(useSshStore.getState().sessions.m7).toBeUndefined();
    useSshStore.getState().load(vault, { sessions: [s('m7', 'connecting')], prompts: [] });
    expect(useSshStore.getState().sessions.m7.phase).toBe('connecting');
    gate.open();
    expect(useSshStore.getState().sessions.m7.phase).toBe('connected');
    onSession(s('m7', 'closed'));
    expect(useSshStore.getState().sessions.m7.phase).toBe('closed');
  });
});
