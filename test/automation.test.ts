import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from '../src/main/automation';
import { StateController } from '../src/main/stateController';
import { addProject, addTab, defaultState, normalizeState, updateCell, upsertPreset, upsertSnippet } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';
import type { AgentTask } from '../src/shared/automation';

export function automationFixture() {
  let state = addProject(defaultState(), { name: 'Own project', path: 'D:/own' });
  state = addTab(state, state.projects[0].id, { name: 'Team', layout: layoutForCount(2), cells: [{ profileId: 'codex', role: 'coordinator' }, { profileId: 'claude', role: 'worker' }] });
  const project = state.projects[0], [coordinator, worker] = project.tabs[0].cells;
  state = addProject(state, { name: 'Other project', path: 'D:/other' });
  state = addTab(state, state.projects[1].id, { layout: layoutForCount(1), cells: [{ profileId: 'codex', role: 'coordinator' }] });
  const outsider = state.projects[1].tabs[0].cells[0];
  const controller = new StateController(state, vi.fn());
  const deps = {
    createWorktree: vi.fn(async (path: string, name: string) => ({ path: `${path}-wt-${name}`, branch: `mc/${name}` })),
    removeWorktree: vi.fn(async () => {}), startCells: vi.fn(), deliver: vi.fn(async () => {}),
  };
  return { service: new AutomationService(controller, deps), controller, deps, project, coordinator, worker, outsider };
}
describe('automation service', () => {
  it('keeps roles and MCP optional, preserves plain prompts and revokes access when disabled', async () => {
    const f = automationFixture();
    await f.service.execute('set_paused', { paused: true });
    const created = await f.service.execute('create_grid', { projectId: f.project.id, name: 'Plain', cells: [
      { profileId: 'claude', prompt: 'Just my original prompt' }, { profileId: 'codex' },
    ] }) as { cellIds: string[] };
    const grid = f.controller.get().projects[0].tabs.at(-1)!;
    expect(grid.cells.every((cell) => cell.role === undefined)).toBe(true);
    expect(grid.cells[0].startupPrompt).toBe('Just my original prompt');
    expect(f.controller.get().automation.tasks).toEqual([]);
    await expect(f.service.execute('get_context', {}, created.cellIds[0])).rejects.toThrow('disabled');
    await f.service.execute('set_role', { cellId: created.cellIds[0], role: 'worker' });
    expect(await f.service.execute('get_context', {}, created.cellIds[0])).toMatchObject({ role: 'worker' });
    await f.service.execute('set_role', { cellId: created.cellIds[0], role: null });
    await expect(f.service.execute('get_context', {}, created.cellIds[0])).rejects.toThrow('disabled');
    const saved = normalizeState(JSON.parse(JSON.stringify(f.controller.get())))!;
    expect(saved.projects[0].tabs.at(-1)!.cells[0].role).toBeUndefined();
  });
  it('migrates existing app data without losing snippets, projects or language', () => {
    const old = defaultState();
    const { automation: _, ...legacy } = old;
    const restored = normalizeState({ ...legacy, settings: { ...legacy.settings, language: 'pl' } });
    expect(restored?.automation).toEqual({ paused: false, tasks: [], messages: [], events: [] });
    expect(restored?.settings.language).toBe('pl');
  });
  it('identifies the actor and scopes reads and writes to its project', async () => {
    const f = automationFixture();
    expect(await f.service.execute('get_context', {}, f.worker.id)).toMatchObject({ cellId: f.worker.id, projectId: f.project.id, role: 'worker' });
    await expect(f.service.execute('list_agents', { projectId: f.outsider.id }, f.worker.id)).rejects.toThrow('access denied');
    await expect(f.service.execute('send_message', { toCellId: f.outsider.id, text: 'outside' }, f.worker.id)).rejects.toThrow('access denied');
    await expect(f.service.execute('set_role', { cellId: f.worker.id, role: 'coordinator' }, f.worker.id)).rejects.toThrow('controlled by the user');
    await expect(f.service.execute('create_grid', { name: 'Unrequested', cells: [{ profileId: 'codex' }] }, f.worker.id)).rejects.toThrow('coordinator');
    await expect(f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Other', prompt: 'Do work' }, f.worker.id)).rejects.toThrow('coordinator');
  });
  it('creates a team in the background with tracked startup tasks and no selection changes', async () => {
    const f = automationFixture();
    const oldSelection = f.controller.get().activeProjectId;
    const oldTab = f.project.activeTabId;
    const created = await f.service.execute('create_grid', { name: 'Feature', rows: [2, 1], cells: [
      { profileId: 'codex', role: 'worker', name: 'Backend', prompt: 'Implement backend', worktree: true },
      { profileId: 'claude', role: 'worker', name: 'Frontend', prompt: 'Implement frontend', worktree: true },
      { profileId: 'codex', name: 'Review', role: 'worker' },
    ] }, f.coordinator.id) as { gridId: string; cellIds: string[] };
    expect(f.controller.get().activeProjectId).toBe(oldSelection);
    expect(f.controller.get().projects[0].activeTabId).toBe(oldTab);
    expect(f.deps.startCells).toHaveBeenCalledWith(created.cellIds);
    expect(f.deps.createWorktree).toHaveBeenCalledTimes(2);
    const grid = f.controller.get().projects[0].tabs.find((t) => t.id === created.gridId)!;
    expect(grid.cells).toHaveLength(3);
    expect(grid.cells[0].startupPrompt).toContain('update_task');
    expect(f.controller.get().automation.tasks).toHaveLength(2);
    expect(f.controller.get().automation.tasks[0]).toMatchObject({ status: 'queued', delivery: 'startup' });
  });
  it('rolls back only newly created worktrees when preparation fails', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockRejectedValueOnce(new Error('git failed'));
    await expect(f.service.execute('create_grid', { name: 'Broken', cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow('git failed');
    expect(f.controller.get().projects[0].tabs).toHaveLength(1);
    expect(f.deps.startCells).not.toHaveBeenCalled();
    f.deps.createWorktree.mockImplementationOnce(async () => ({ path: 'D:/own-wt-new', branch: 'mc/new' }));
    f.deps.createWorktree.mockRejectedValueOnce(new Error('second failed'));
    await expect(f.service.execute('create_grid', { name: 'Broken', cells: [{ profileId: 'codex', worktree: true }, { profileId: 'claude', worktree: true }] }, f.coordinator.id)).rejects.toThrow('second failed');
    expect(f.deps.removeWorktree).toHaveBeenCalledWith(f.project.path, { path: 'D:/own-wt-new', branch: 'mc/new' });
    expect(f.controller.get().projects[0].tabs).toHaveLength(1);
  });
  it('rechecks pause and project permissions after asynchronous worktree creation', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockImplementationOnce(async () => {
      await f.service.execute('set_paused', { paused: true });
      return { path: 'D:/own-wt-new', branch: 'mc/new' };
    });
    await expect(f.service.execute('create_grid', { name: 'Paused', cells: [{ profileId: 'codex', worktree: true }] }, f.coordinator.id)).rejects.toThrow('paused');
    expect(f.deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(f.deps.startCells).not.toHaveBeenCalled();
  });
  it('retains undelivered work, accepts results from the recipient and protects closed tasks', async () => {
    const f = automationFixture();
    f.deps.deliver.mockRejectedValue(new Error('Native delivery unavailable'));
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Fix login', prompt: 'Fix the login flow' }, f.coordinator.id) as AgentTask;
    expect(task).toMatchObject({ delivery: 'pending', status: 'queued', deliveryError: 'Native delivery unavailable' });
    expect(await f.service.execute('get_tasks', {}, f.worker.id)).toHaveLength(1);
    await f.service.execute('update_task', { taskId: task.id, status: 'in_progress' }, f.worker.id);
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'completed' }, f.worker.id)).rejects.toThrow('require a result');
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'blocked' }, f.worker.id)).rejects.toThrow('require a reason');
    await f.service.execute('set_paused', { paused: true });
    await expect(f.service.execute('send_message', { toCellId: f.coordinator.id, text: 'new' }, f.worker.id)).rejects.toThrow('paused');
    await f.service.execute('update_task', { taskId: task.id, status: 'completed', result: { summary: 'Fixed', files: ['login.ts'], tests: ['login tests passed'], branch: 'mc/login' } }, f.worker.id);
    expect(f.controller.get().automation.tasks[0].result?.files).toEqual(['login.ts']);
    await expect(f.service.execute('update_task', { taskId: task.id, status: 'in_progress' }, f.worker.id)).rejects.toThrow('already closed');
  });
  it('does not resend items already accepted by a native queue', async () => {
    const f = automationFixture();
    const task = await f.service.execute('create_task', { cellId: f.worker.id, title: 'Task', prompt: 'Work' }, f.coordinator.id) as AgentTask;
    expect(task.delivery).toBe('native');
    await f.service.execute('deliver_task', { taskId: task.id }, f.coordinator.id);
    expect(f.deps.deliver).toHaveBeenCalledTimes(1);
  });
  it('makes messages visible only to their recipient and requires recipient acknowledgment', async () => {
    const f = automationFixture();
    const message = await f.service.execute('send_message', { toCellId: f.worker.id, text: 'The API is ready' }, f.coordinator.id) as { id: string };
    expect(await f.service.execute('get_messages', {}, f.worker.id)).toHaveLength(1);
    expect(await f.service.execute('get_messages', {}, f.coordinator.id)).toEqual([]);
    await expect(f.service.execute('acknowledge_message', { messageId: message.id }, f.coordinator.id)).rejects.toThrow('recipient');
    await f.service.execute('acknowledge_message', { messageId: message.id }, f.worker.id);
    expect(await f.service.execute('get_messages', {}, f.worker.id)).toEqual([]);
    expect(await f.service.execute('get_messages', { unreadOnly: false }, f.worker.id)).toHaveLength(1);
  });
  it('creates snippets, uses them as tracked tasks and protects other scopes', async () => {
    const f = automationFixture();
    f.controller.change((s) => upsertSnippet(s, { id: 'global', name: 'Global', text: 'global prompt', autoSend: true }));
    const snippet = await f.service.execute('save_snippet', { name: 'Review', text: 'Review files' }, f.worker.id) as { id: string; autoSend: boolean };
    expect(snippet.autoSend).toBe(false);
    expect(await f.service.execute('get_snippet', { snippetId: snippet.id }, f.worker.id)).toMatchObject({ text: 'Review files' });
    await expect(f.service.execute('save_snippet', { id: 'global', name: 'Overwrite', text: 'new' }, f.worker.id)).rejects.toThrow('another scope');
    const task = await f.service.execute('apply_snippet', { snippetId: snippet.id, cellId: f.worker.id }, f.coordinator.id) as AgentTask;
    expect(task).toMatchObject({ title: 'Review', prompt: 'Review files' });
    expect((await f.service.execute('list_library', {}, f.worker.id) as { snippets: unknown[] }).snippets).toHaveLength(2);
  });
  it('starts saved team presets and validates custom layouts before worktree side effects', async () => {
    const f = automationFixture();
    f.controller.change((s) => upsertPreset(s, { id: 'team', name: 'Saved', layout: layoutForCount(2), cells: [{ profileId: 'codex', worktree: false, prompt: 'Backend' }, { profileId: 'claude', worktree: false }] }));
    const created = await f.service.execute('create_grid', { name: 'From preset', presetId: 'team' }, f.coordinator.id) as { cellIds: string[] };
    expect(created.cellIds).toHaveLength(2);
    await expect(f.service.execute('create_grid', { name: 'Invalid', cells: [{ profileId: 'codex', worktree: true }, { profileId: 'claude' }], layout: {
      cols: 2, rows: 1, areas: [{ col: 0, row: 0, colSpan: 1, rowSpan: 1 }, { col: 0, row: 0, colSpan: 1, rowSpan: 1 }],
    } }, f.coordinator.id)).rejects.toThrow('overlap');
    expect(f.deps.createWorktree).not.toHaveBeenCalled();
  });
  it('applies role changes immediately and blocks workers from reading other task inboxes', async () => {
    const f = automationFixture();
    await f.service.execute('create_task', { cellId: f.coordinator.id, title: 'Own', prompt: 'Work' }, f.coordinator.id);
    expect(await f.service.execute('get_tasks', { cellId: f.coordinator.id }, f.worker.id)).toEqual([]);
    f.controller.change((s) => updateCell(s, f.coordinator.id, { role: 'worker' }));
    await expect(f.service.execute('create_grid', { name: 'Forbidden', cells: [{ profileId: 'codex' }] }, f.coordinator.id)).rejects.toThrow('coordinator');
  });
});
