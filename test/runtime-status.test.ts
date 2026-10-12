import { describe, expect, it } from 'vitest';
import { automationHintForHook, automationStatusFor } from '../src/shared/runtimeStatus';

describe('automationStatusFor', () => {
  it('maps working for hooked and heuristic cells', () => {
    expect(automationStatusFor('working', 'done', true, 'ready')).toBe('working');
    expect(automationStatusFor('working', 'done', false, 'unknown')).toBe('working');
  });
  it('hooked waiting is precise: done = ready, attention / error = needs_attention', () => {
    expect(automationStatusFor('waiting', 'done', true, 'working')).toBe('ready');
    expect(automationStatusFor('waiting', 'attention', true, 'ready')).toBe('needs_attention');
    expect(automationStatusFor('waiting', 'error', true, 'working')).toBe('needs_attention');
  });
  it('heuristic waiting never becomes ready and does not overwrite ready', () => {
    expect(automationStatusFor('waiting', 'done', false, 'working')).toBe('needs_attention');
    expect(automationStatusFor('waiting', 'done', false, 'ready')).toBeNull();
  });
  it('idle keeps ready, otherwise unknown; exited is left to the pty lifecycle', () => {
    expect(automationStatusFor('idle', 'done', true, 'ready')).toBeNull();
    expect(automationStatusFor('idle', 'done', false, 'working')).toBe('unknown');
    expect(automationStatusFor('exited', 'done', true, 'working')).toBeNull();
  });
});

describe('automationHintForHook', () => {
  it('hints only events the tracker always applies, never busy', () => {
    expect(automationHintForHook('prompt')).toBe('working');
    expect(automationHintForHook('stopbg')).toBe('working');
    expect(automationHintForHook('stop')).toBe('ready');
    expect(automationHintForHook('notify')).toBe('needs_attention');
    expect(automationHintForHook('fail')).toBe('needs_attention');
    expect(automationHintForHook('busy')).toBeNull();
  });
});
