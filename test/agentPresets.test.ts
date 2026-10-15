import { describe, expect, it } from 'vitest';
import { commandPreview, hasFlag, toggleFlag } from '../src/shared/agentPresets';

describe('agent presets', () => {
  it('switches an option on and off without touching the rest', () => {
    const on = toggleFlag('--verbose', 'claude', '--dangerously-skip-permissions', true);
    expect(on).toBe('--verbose --dangerously-skip-permissions');
    expect(hasFlag(on, '--dangerously-skip-permissions')).toBe(true);
    expect(toggleFlag(on, 'claude', '--dangerously-skip-permissions', false)).toBe('--verbose');
  });
  it('does not match a flag inside another word', () => {
    expect(hasFlag('--yolo-extra', '--yolo')).toBe(false);
    expect(hasFlag('a --yolo b', '--yolo')).toBe(true);
  });
  it('keeps grouped options exclusive', () => {
    const opus = toggleFlag('', 'claude', '--model opus', true);
    expect(toggleFlag(opus, 'claude', '--model sonnet', true)).toBe('--model sonnet');
  });
  it('shows the command a cell starts with', () => {
    expect(commandPreview('codex', ' --yolo ')).toBe('codex --yolo');
    expect(commandPreview('claude', '')).toBe('claude');
    expect(commandPreview('shell', '--x')).toBe('');
  });
});
