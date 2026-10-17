// MCP inbox retention (per project, finished items make room), user removal, and team calls that a client gave up on or repeated.
import { describe, expect, it } from 'vitest';
import { pruneAutomation, PROJECT_ITEM_LIMIT, RETENTION_MS, type AgentMessage, type AgentTask, type AutomationState } from '../src/shared/automation';
import { normalizeState, removeProject } from '../src/shared/state';
import { automationFixture } from './helpers/automationFixture';

const NOW = Date.UTC(2026, 9, 17);
const DAY = 24 * 60 * 60 * 1000;
const task = (id: string, projectId: string, status: AgentTask['status'], updatedAt: number, dependsOn?: string[]): AgentTask => ({
  id, projectId, cellId: 'cell', title: id, prompt: 'p', status, delivery: 'startup', createdAt: updatedAt, updatedAt, ...(dependsOn ? { dependsOn } : {}),
});
const message = (id: string, projectId: string, createdAt: number, readAt?: number): AgentMessage => ({
  id, projectId, toCellId: 'cell', text: 't', delivery: 'pending', createdAt, ...(readAt !== undefined ? { readAt } : {}),
});
const automation = (tasks: AgentTask[], messages: AgentMessage[] = []): AutomationState => ({ paused: false, tasks, messages, events: [] });

describe('pruneAutomation', () => {
  it('drops finished items older than the retention window and keeps open, unread and still needed ones', () => {
    const old = NOW - RETENTION_MS - DAY;
    const state = automation([
      task('done-old', 'p', 'completed', old),
      task('cancelled-old', 'p', 'cancelled', old),
      task('done-new', 'p', 'completed', NOW - DAY),
      task('open-old', 'p', 'queued', old),
      task('blocked-old', 'p', 'blocked', old),
      task('needed-old', 'p', 'completed', old),
      task('waits', 'p', 'queued', NOW, ['needed-old']),
    ], [message('read-old', 'p', old, old), message('read-new', 'p', old, NOW - DAY), message('unread-old', 'p', old)]);
    const pruned = pruneAutomation(state, new Set(['p']), NOW);
    expect(pruned.tasks.map((t) => t.id)).toEqual(['done-new', 'open-old', 'blocked-old', 'needed-old', 'waits']);
    expect(pruned.messages.map((m) => m.id)).toEqual(['read-new', 'unread-old']);
    // Nothing to drop: the same object comes back (no state change, no save).
    expect(pruneAutomation(pruned, new Set(['p']), NOW)).toBe(pruned);
  });

  it('drops the items of removed projects and their activity', () => {
    const state: AutomationState = { ...automation([task('a', 'gone', 'queued', NOW), task('b', 'p', 'queued', NOW)], [message('m', 'gone', NOW)]),
      events: [{ id: 'e1', projectId: 'gone', action: 'x', detail: 'x', createdAt: NOW }, { id: 'e2', projectId: 'p', action: 'x', detail: 'x', createdAt: NOW }] };
    const pruned = pruneAutomation(state, new Set(['p']), NOW);
    expect(pruned.tasks.map((t) => t.id)).toEqual(['b']);
    expect(pruned.messages).toEqual([]);
    expect(pruned.events.map((e) => e.id)).toEqual(['e2']);
  });

  it('caps each project on its own: the oldest finished items make room first', () => {
    const tasks = [
      ...Array.from({ length: PROJECT_ITEM_LIMIT - 10 }, (_, i) => task(`open-${i}`, 'p', 'queued', NOW)),
      ...Array.from({ length: 20 }, (_, i) => task(`done-${i}`, 'p', 'completed', NOW - (20 - i) * 1000)),
      ...Array.from({ length: PROJECT_ITEM_LIMIT }, (_, i) => task(`other-${i}`, 'q', 'queued', NOW)),
    ];
    const pruned = pruneAutomation(automation(tasks), new Set(['p', 'q']), NOW, { tasks: { p: 1 } });
    const p = pruned.tasks.filter((t) => t.projectId === 'p');
    expect(p).toHaveLength(PROJECT_ITEM_LIMIT - 1); // one place left for the task about to be added
    expect(p.filter((t) => t.status === 'completed').map((t) => t.id)).toEqual(Array.from({ length: 9 }, (_, i) => `done-${i + 11}`));
    expect(pruned.tasks.filter((t) => t.projectId === 'q')).toHaveLength(PROJECT_ITEM_LIMIT); // another full project does not count
  });

  it('runs on load and when a project is removed', () => {
    const f = automationFixture();
    const s = f.controller.get();
    const withItems = { ...s, automation: automation([task('t1', f.project.id, 'queued', NOW), task('t2', s.projects[1].id, 'queued', NOW), task('orphan', 'nowhere', 'queued', NOW)]) };
    expect(normalizeState(JSON.parse(JSON.stringify(withItems)))!.automation.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(removeProject(withItems, s.projects[1].id).automation.tasks.map((t) => t.id)).toEqual(['t1']);
  });
});

describe('inbox limits and removal through the service', () => {
  it('a full project frees finished tasks instead of refusing, and refuses only when every task is open', async () => {
    const f = automationFixture();
    const old = Date.now() - 1000;
    f.controller.change((s) => ({ ...s, automation: automation([
      ...Array.from({ length: PROJECT_ITEM_LIMIT - 1 }, (_, i) => task(`open-${i}`, f.project.id, 'queued', old)),
      task('done', f.project.id, 'completed', old),
    ]) }));
    await f.service.execute('create_task', { cellId: f.worker.id, title: 'New', prompt: 'Do it' }, f.coordinator.id);
    const tasks = f.controller.get().automation.tasks;
    expect(tasks).toHaveLength(PROJECT_ITEM_LIMIT);
    expect(tasks.some((t) => t.id === 'done')).toBe(false);
    await expect(f.service.execute('create_task', { cellId: f.worker.id, title: 'More', prompt: 'Do it' }, f.coordinator.id)).rejects.toThrow(/Task limit reached \(500 open tasks in this project\)/);
    // Another project is not affected by this one's limit.
    await expect(f.service.execute('create_task', { cellId: f.outsider.id, title: 'Elsewhere', prompt: 'Do it' }, f.outsider.id)).resolves.toBeTruthy();
  });

  it('the user removes finished tasks and read messages, never open ones or a task another one waits for', async () => {
    const f = automationFixture();
    const pid = f.project.id;
    f.controller.change((s) => ({ ...s, automation: automation(
      [task('done', pid, 'completed', NOW), task('needed', pid, 'completed', NOW), task('waits', pid, 'queued', NOW, ['needed']), task('open', pid, 'in_progress', NOW), task('else', f.outsider.id, 'completed', NOW)],
      [message('read', pid, NOW, NOW), message('unread', pid, NOW)],
    ) }));
    await expect(f.service.execute('remove_items', { projectId: pid, kind: 'task' }, f.coordinator.id)).rejects.toThrow('controlled by the user');
    expect(await f.service.execute('remove_items', { projectId: pid, kind: 'task', ids: ['open', 'needed'] })).toEqual({ removed: 0 });
    expect(await f.service.execute('remove_items', { projectId: pid, kind: 'task' })).toEqual({ removed: 1 });
    expect(f.controller.get().automation.tasks.map((t) => t.id)).toEqual(['needed', 'waits', 'open', 'else']);
    await f.service.execute('set_paused', { paused: true });
    expect(await f.service.execute('remove_items', { projectId: pid, kind: 'message' })).toEqual({ removed: 1 });
    expect(f.controller.get().automation.messages.map((m) => m.id)).toEqual(['unread']);
  });
});

describe('wait_for', () => {
  it('wakes on the state change itself, not on a polling tick', async () => {
    const f = automationFixture();
    const started = Date.now();
    const waiting = f.service.execute('wait_for', { timeoutSec: 10 }, f.worker.id);
    await new Promise((r) => setTimeout(r, 20));
    await f.service.execute('send_message', { toCellId: f.worker.id, text: 'ping' }, f.coordinator.id);
    expect(await waiting).toEqual({ event: 'inbox', unreadMessages: 1, queuedTasks: 0 });
    expect(Date.now() - started).toBeLessThan(500); // the safety tick is 1 s
  });
});

describe('team calls a client gave up on or repeated', () => {
  it('rolls back the worktrees and creates nothing when the request ends while worktrees are made', async () => {
    const f = automationFixture();
    const abort = new AbortController();
    f.deps.createWorktree.mockImplementationOnce(async (path: string, name: string) => { abort.abort(); return { path: `${path}-wt-${name}`, branch: `mc/${name}` }; });
    const tabsBefore = f.controller.get().projects[0].tabs.length;
    await expect(f.service.execute('create_grid', { name: 'Slow', cells: [{ profileId: 'codex', worktree: true }, { profileId: 'claude', worktree: true }] }, f.coordinator.id, abort.signal))
      .rejects.toThrow(/nothing was kept/);
    expect(f.deps.createWorktree).toHaveBeenCalledTimes(1); // stopped before the second one
    expect(f.deps.removeWorktree).toHaveBeenCalledTimes(1);
    expect(f.controller.get().projects[0].tabs).toHaveLength(tabsBefore);
    expect(f.deps.startCells).not.toHaveBeenCalled();
  });

  it('answers a repeated identical call with the first result instead of a second team', async () => {
    const f = automationFixture();
    const args = { name: 'Team B', cells: [{ profileId: 'codex', role: 'worker' as const, prompt: 'Work', worktree: true }] };
    let release!: () => void;
    f.deps.createWorktree.mockImplementationOnce(async (path: string, name: string) => { await new Promise<void>((r) => { release = r; }); return { path: `${path}-wt-${name}`, branch: `mc/${name}` }; });
    const first = new AbortController();
    const running = f.service.execute('create_grid', args, f.coordinator.id, first.signal);
    await new Promise((r) => setTimeout(r, 0));
    // The client timed out and retried: the first request is gone, but the retry joins the running call, so it is not cancelled.
    const retry = f.service.execute('create_grid', args, f.coordinator.id, new AbortController().signal);
    first.abort();
    release();
    const [a, b] = await Promise.all([running, retry]) as Array<{ gridId: string }>;
    expect(a.gridId).toBe(b.gridId);
    expect(f.controller.get().projects[0].tabs.filter((t) => t.name === 'Team B')).toHaveLength(1);
    // Later, the same call again still answers with the first result; another call (or another agent) is a new grid.
    expect(((await f.service.execute('create_grid', args, f.coordinator.id)) as { gridId: string }).gridId).toBe(a.gridId);
    const other = await f.service.execute('create_grid', { ...args, name: 'Team C' }, f.coordinator.id) as { gridId: string };
    expect(other.gridId).not.toBe(a.gridId);
    expect(f.deps.createWorktree).toHaveBeenCalledTimes(2);
  });

  it('a failed call is not remembered', async () => {
    const f = automationFixture();
    f.deps.createWorktree.mockRejectedValueOnce(new Error('git failed'));
    const args = { name: 'Retry me', cells: [{ profileId: 'codex', worktree: true }] };
    await expect(f.service.execute('create_grid', args, f.coordinator.id)).rejects.toThrow('git failed');
    await expect(f.service.execute('create_grid', args, f.coordinator.id)).resolves.toMatchObject({ cellIds: [expect.any(String)] });
  });
});
