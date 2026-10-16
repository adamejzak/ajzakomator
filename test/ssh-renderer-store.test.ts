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
