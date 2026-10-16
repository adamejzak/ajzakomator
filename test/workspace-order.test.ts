import { expect, it } from 'vitest';
import { activeWorkspaceKey, workspaceOrder, reorderWorkspace } from '../src/shared/workspaceOrder';

it('preserves mixed card order while dropping closed cards and appending new ones', () => {
  expect(workspaceOrder(['file:a', 'settings', 'grid:a', 'closed'], ['grid:a', 'grid:b', 'file:a', 'settings']))
    .toEqual(['file:a', 'settings', 'grid:a', 'grid:b']);
});
it('moves files across grids and settings in either direction', () => {
  const cards = ['grid:a', 'file:a', 'settings', 'grid:b'];
  expect(reorderWorkspace(cards, 'file:a', 'grid:b', true)).toEqual(['grid:a', 'settings', 'grid:b', 'file:a']);
  expect(reorderWorkspace(cards, 'grid:b', 'grid:a', false)).toEqual(['grid:b', 'grid:a', 'file:a', 'settings']);
  expect(reorderWorkspace(cards, 'missing', 'grid:a', false)).toBe(cards);
});
it('picks the visible workspace: settings, then an SSH editor, then a file, then the grid (R10)', () => {
  const base = { settingsActive: false, sshEditorId: null, fileId: null, gridId: null };
  expect(activeWorkspaceKey({ ...base, settingsActive: true, sshEditorId: 'e', fileId: 'f', gridId: 'g' })).toBe('settings');
  expect(activeWorkspaceKey({ ...base, sshEditorId: 'e', fileId: 'f', gridId: 'g' })).toBe('ssh:e');
  expect(activeWorkspaceKey({ ...base, fileId: 'f', gridId: 'g' })).toBe('file:f');
  expect(activeWorkspaceKey({ ...base, gridId: 'g' })).toBe('grid:g');
  expect(activeWorkspaceKey(base)).toBeNull();
});
