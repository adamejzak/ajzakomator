import { automationSchemas, taskPrompt, type AgentMessage, type AgentRuntimeStatus, type AgentTask, type AutomationOperation } from '../shared/automation';
import { closeTab, addTab, findCell, getProfile, setActiveTab, uid, updateCell, upsertPreset, upsertSnippet } from '../shared/state';
import { layoutForCount, layoutFromRows } from '../shared/layout';
import type { AppState, Cell, Tab, Worktree } from '../shared/types';
import type { StateController } from './stateController';

export interface AutomationDependencies {
  createWorktree(path: string, name: string): Promise<Worktree>;
  removeWorktree(path: string, worktree: Worktree): Promise<void>;
  startCells(ids: string[]): void;
  stopCells?(ids: string[]): Promise<void>;
  isCellRunning?(cellId: string): boolean;
  /** Runtime must verify a confirmed, compatible session before killing and relaunching; never type a shell command. */
  restartAgent?(cellId: string): Promise<{ restarted: boolean; reason?: string }>;
  deliver(cellId: string, text: string): Promise<void>;
}
const READS = new Set<AutomationOperation>(['get_context', 'read_inbox', 'list_agents', 'list_library', 'get_snippet', 'get_tasks', 'get_messages']);
const UI_ONLY = new Set<AutomationOperation>(['set_paused', 'set_role', 'mark_pasted']);
const DELIVERY_LIMIT = 500;
const TEAM_COLORS = ['#60a5fa', '#a78bfa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc', '#a3e635',
  '#818cf8', '#2dd4bf', '#f472b6', '#fb923c', '#38bdf8', '#4ade80', '#e879f9', '#facc15', '#93c5fd', '#6ee7b7', '#fda4af', '#d8b4fe'];

export class AutomationService {
  readonly statuses = new Map<string, AgentRuntimeStatus>();
  private pendingRestart = new Set<string>();
  /** Call on a confirmed runtime spawn so a user-initiated restart clears deferred launch settings. */
  runtimeStarted(cellId: string): void { this.pendingRestart.delete(cellId); }
  private delivering = new Set<string>();
  constructor(readonly state: StateController, private readonly deps: AutomationDependencies) {}

  private actor(cellId: string) {
    const found = findCell(this.state.get(), cellId);
    if (!found || !found.cell.role || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent MCP integration is disabled or the cell is no longer available.');
    return found;
  }
  private role(cellId: string) {
    return this.actor(cellId).cell.role;
  }
  private project(projectId: string | undefined, actorId?: string) {
    const own = actorId ? this.actor(actorId).project : undefined;
    const id = projectId ?? own?.id;
    if (!id || (own && own.id !== id)) throw new Error('Project access denied.');
    const project = this.state.get().projects.find((p) => p.id === id);
    if (!project) throw new Error('Project not found.');
    return project;
  }
  private target(cellId: string, actorId?: string) {
    const found = findCell(this.state.get(), cellId);
    if (!found || !found.cell.role || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Target must be an active agent cell with MCP enabled.');
    this.project(found.project.id, actorId);
    return found;
  }
  private coordinator(actorId?: string) {
    if (actorId && this.role(actorId) !== 'coordinator') throw new Error('This operation requires the coordinator role.');
  }
  private log(state: AppState, projectId: string, action: string, detail: string, cellId?: string): AppState {
    return { ...state, automation: { ...state.automation, events: [...state.automation.events,
      { id: uid(), projectId, action, detail, cellId, createdAt: Date.now() }].slice(-200) } };
  }

  async execute<K extends AutomationOperation>(operation: K, input: unknown, actorId?: string): Promise<unknown> {
    const args = automationSchemas[operation].parse(input);
    if (actorId) {
      this.actor(actorId);
      if (UI_ONLY.has(operation)) throw new Error('This operation is controlled by the user.');
    }
    if (this.state.get().automation.paused && !READS.has(operation) && !['set_paused', 'set_role', 'update_task', 'acknowledge_message'].includes(operation) && !(operation === 'create_grid' && !actorId)) {
      throw new Error('Automation is paused by the user.');
    }
    switch (operation) {
      case 'get_context': {
        if (!actorId) return { paused: this.state.get().automation.paused };
        const { project, cell, tab } = this.actor(actorId);
        return { cellId: cell.id, role: this.role(actorId), projectId: project.id, projectName: project.name,
          cwd: cell.worktree?.path ?? project.path, gridId: tab.id, profileId: cell.profileId, model: cell.model, paused: this.state.get().automation.paused,
          profiles: this.state.get().profiles.map(({ id, name, cli }) => ({ id, name, cli })) };
      }
      case 'read_inbox': {
        if (!actorId) throw new Error('Inbox requires an authenticated agent.');
        const a = automationSchemas.read_inbox.parse(input);
        const { project } = this.actor(actorId);
        const snapshot = this.state.get();
        const tasks = snapshot.automation.tasks.filter((t) => t.projectId === project.id && t.cellId === actorId)
          .map((t) => ({ ...t, blockedBy: this.blockedBy(t), ready: t.status === 'queued' && this.blockedBy(t).length === 0 })).slice(a.offset, a.offset + a.limit);
        const unread = snapshot.automation.messages.filter((m) => m.projectId === project.id && m.toCellId === actorId && !m.readAt);
        const messages = unread.slice(a.offset, a.offset + a.limit);
        const acknowledgedMessageIds = a.acknowledge ? messages.map((m) => m.id) : [];
        const readAt = Date.now();
        if (acknowledgedMessageIds.length) {
          const ids = new Set(acknowledgedMessageIds);
          this.state.change((s) => ({ ...s, automation: { ...s.automation, messages: s.automation.messages.map((m) => ids.has(m.id) && m.toCellId === actorId ? { ...m, readAt } : m) } }));
        }
        return { tasks, messages: a.acknowledge ? messages.map((m) => ({ ...m, readAt })) : messages, acknowledgedMessageIds,
          hasMoreTasks: snapshot.automation.tasks.filter((t) => t.projectId === project.id && t.cellId === actorId).length > a.offset + a.limit,
          hasMoreMessages: unread.length > a.offset + a.limit };
      }
      case 'list_agents': {
        const a = args as { projectId?: string };
        const project = this.project(a.projectId, actorId);
        return project.tabs.flatMap((tab) => tab.cells.filter((cell) => getProfile(this.state.get(), cell.profileId).cli !== 'shell').map((cell) => ({
          cellId: cell.id, name: cell.name ?? getProfile(this.state.get(), cell.profileId).name,
          gridId: tab.id, gridName: tab.name, gridColor: tab.color, profileId: cell.profileId, model: cell.model, color: cell.color,
          role: cell.role ?? null,
          status: this.statuses.get(cell.id) ?? 'unknown', cwd: cell.worktree?.path ?? project.path,
          tasks: this.state.get().automation.tasks.filter((t) => t.cellId === cell.id && !['completed', 'cancelled'].includes(t.status)).map(({ id, title, status }) => ({ id, title, status })),
        })));
      }
      case 'list_library': {
        const project = this.project((args as { projectId?: string }).projectId, actorId);
        return { snippets: this.state.get().snippets.filter((s) => !s.projectId || s.projectId === project.id).map(({ id, name, autoSend, projectId }) => ({ id, name, autoSend, projectId })),
          presets: this.state.get().presets.filter((p) => !p.projectId || p.projectId === project.id) };
      }
      case 'get_snippet': {
        const { snippetId } = automationSchemas.get_snippet.parse(input);
        const snippet = this.state.get().snippets.find((s) => s.id === snippetId);
        if (!snippet) throw new Error('Snippet not found.');
        if (actorId && snippet.projectId) this.project(snippet.projectId, actorId);
        return snippet;
      }
      case 'apply_snippet': {
        const { snippetId, cellId } = automationSchemas.apply_snippet.parse(input);
        const found = this.target(cellId, actorId);
        const snippet = this.state.get().snippets.find((s) => s.id === snippetId);
        if (!snippet || (snippet.projectId && snippet.projectId !== found.project.id)) throw new Error('Snippet not found in this project.');
        return this.execute('create_task', { cellId, title: snippet.name, prompt: snippet.text }, actorId);
      }
      case 'close_grid': return this.closeGrid(automationSchemas.close_grid.parse(input), actorId);
      case 'add_agents': return this.createGrid({ ...automationSchemas.add_agents.parse(input), name: '' }, actorId);
      case 'update_grid': {
        this.coordinator(actorId);
        const a = automationSchemas.update_grid.parse(input);
        const { project, tab } = this.grid(a.gridId, actorId);
        const patch = { ...(a.name !== undefined ? { name: a.name } : {}), ...(a.color !== undefined ? { color: a.color ?? undefined } : {}) };
        this.state.change((s) => this.log({ ...s, projects: s.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((t) => t.id === tab.id ? { ...t, ...patch } : t) } : p) }, project.id, 'grid_updated', a.name ?? tab.name, actorId));
        return { gridId: tab.id, ...patch };
      }
      case 'update_agent': return this.updateAgent(automationSchemas.update_agent.parse(input), actorId);
      case 'create_grid': return this.createGrid(automationSchemas.create_grid.parse(input), actorId);
      case 'save_snippet': {
        const a = automationSchemas.save_snippet.parse(input);
        const project = this.project(a.projectId, actorId);
        const existing = this.state.get().snippets.find((s) => s.id === a.id);
        if (existing && existing.projectId !== project.id) throw new Error('Snippet belongs to another scope.');
        const snippet = { ...a, id: a.id ?? uid(), projectId: project.id };
        this.state.change((s) => this.log(upsertSnippet(s, snippet), project.id, 'snippet', snippet.name, actorId));
        return snippet;
      }
      case 'save_preset': {
        this.coordinator(actorId);
        const a = automationSchemas.save_preset.parse(input);
        const project = this.project(a.projectId, actorId);
        const existing = this.state.get().presets.find((p) => p.id === a.id);
        if (existing && existing.projectId !== project.id) throw new Error('Preset belongs to another scope.');
        this.validateCells(a.cells);
        const layout = this.layout(a.cells.length, a.rows);
        const preset = { id: a.id ?? uid(), name: a.name, projectId: project.id, layout, cells: a.cells };
        this.state.change((s) => this.log(upsertPreset(s, preset), project.id, 'preset', preset.name, actorId));
        return preset;
      }
      case 'create_task': {
        const a = automationSchemas.create_task.parse(input);
        const found = this.target(a.cellId, actorId);
        if (actorId && actorId !== a.cellId) this.coordinator(actorId);
        for (const dependencyId of a.dependsOn ?? []) {
          const dependency = this.state.get().automation.tasks.find((t) => t.id === dependencyId);
          if (!dependency || dependency.projectId !== found.project.id) throw new Error('Task dependencies must exist in this project.');
        }
        if (this.state.get().automation.tasks.length >= DELIVERY_LIMIT) throw new Error('Task limit reached (500).');
        const task: AgentTask = { ...a, ...(a.dependsOn ? { dependsOn: [...new Set(a.dependsOn)] } : {}), id: uid(), projectId: found.project.id, fromCellId: actorId,
          status: 'queued', delivery: 'pending', createdAt: Date.now(), updatedAt: Date.now() };
        this.state.change((s) => this.log({ ...s, automation: { ...s.automation, tasks: [...s.automation.tasks, task] } }, found.project.id, 'task_created', task.title, actorId));
        await this.deliver('task', task.id, actorId);
        return this.state.get().automation.tasks.find((t) => t.id === task.id);
      }
      case 'get_tasks': {
        const a = automationSchemas.get_tasks.parse(input);
        const project = this.project(a.projectId, actorId);
        return this.state.get().automation.tasks.filter((t) => t.projectId === project.id && (!a.cellId || t.cellId === a.cellId) &&
          (!a.status || t.status === a.status) && (!actorId || this.role(actorId) === 'coordinator' || t.cellId === actorId))
          .map((t) => ({ ...t, blockedBy: this.blockedBy(t), ready: t.status === 'queued' && this.blockedBy(t).length === 0 }))
          .filter((t) => !a.readyOnly || t.ready).slice(a.offset, a.offset + a.limit);
      }
      case 'update_task': {
        const a = automationSchemas.update_task.parse(input);
        const task = this.state.get().automation.tasks.find((t) => t.id === a.taskId);
        if (!task) throw new Error('Task not found.');
        this.project(task.projectId, actorId);
        if (actorId && task.cellId !== actorId) this.coordinator(actorId);
        if (['completed', 'cancelled'].includes(task.status)) throw new Error('Task is already closed.');
        if (a.status === 'in_progress' && this.blockedBy(task).length) throw new Error('Task dependencies have not completed.');
        if (a.status === 'completed' && !a.result) throw new Error('Completed tasks require a result.');
        if (a.status === 'blocked' && !a.blockedReason) throw new Error('Blocked tasks require a reason.');
        const next: AgentTask = { ...task, status: a.status, result: a.result, blockedReason: a.blockedReason, updatedAt: Date.now() };
        this.state.change((s) => this.log({ ...s, automation: { ...s.automation, tasks: s.automation.tasks.map((t) => t.id === task.id ? next : t) } }, task.projectId, `task_${a.status}`, task.title, actorId));
        if (a.status !== 'cancelled') this.statuses.set(task.cellId, a.status === 'in_progress' ? 'working' : a.status === 'blocked' ? 'needs_attention' : 'ready');
        return next;
      }
      case 'send_message': {
        const a = automationSchemas.send_message.parse(input);
        const found = this.target(a.toCellId, actorId);
        if (this.state.get().automation.messages.length >= DELIVERY_LIMIT) throw new Error('Message limit reached (500).');
        const message: AgentMessage = { ...a, id: uid(), projectId: found.project.id, fromCellId: actorId, delivery: 'pending', createdAt: Date.now() };
        this.state.change((s) => this.log({ ...s, automation: { ...s.automation, messages: [...s.automation.messages, message] } }, found.project.id, 'message', message.text.slice(0, 140), actorId));
        await this.deliver('message', message.id, actorId);
        return this.state.get().automation.messages.find((m) => m.id === message.id);
      }
      case 'get_messages': {
        const a = automationSchemas.get_messages.parse(input);
        const project = this.project(a.projectId, actorId);
        return this.state.get().automation.messages.filter((m) => m.projectId === project.id && (!actorId || m.toCellId === actorId) && (!a.unreadOnly || !m.readAt)).slice(a.offset, a.offset + a.limit);
      }
      case 'acknowledge_message': {
        const { messageId } = automationSchemas.acknowledge_message.parse(input);
        const message = this.state.get().automation.messages.find((m) => m.id === messageId);
        if (!message) throw new Error('Message not found.');
        this.project(message.projectId, actorId);
        if (actorId && message.toCellId !== actorId) throw new Error('Only the recipient can acknowledge a message.');
        this.state.change((s) => ({ ...s, automation: { ...s.automation, messages: s.automation.messages.map((m) => m.id === messageId ? { ...m, readAt: Date.now() } : m) } }));
        return { acknowledged: true };
      }
      case 'set_paused': {
        const { paused } = automationSchemas.set_paused.parse(input);
        this.state.change((s) => ({ ...s, automation: { ...s.automation, paused } }));
        return { paused };
      }
      case 'set_role': {
        const { cellId, role } = automationSchemas.set_role.parse(input);
        const found = findCell(this.state.get(), cellId);
        if (!found || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent cell not found.');
        const { project } = found;
        this.state.change((s) => this.log(updateCell(s, cellId, { role: role ?? undefined }), project.id, 'role', role ?? 'disabled', cellId));
        return { cellId, role };
      }
      case 'deliver_task': return this.deliver('task', automationSchemas.deliver_task.parse(input).taskId, actorId);
      case 'deliver_message': return this.deliver('message', automationSchemas.deliver_message.parse(input).messageId, actorId);
      case 'mark_pasted': {
        const a = automationSchemas.mark_pasted.parse(input);
        this.state.change((s) => ({ ...s, automation: { ...s.automation,
          tasks: a.kind === 'task' ? s.automation.tasks.map((t) => t.id === a.id ? { ...t, delivery: 'pasted', deliveryError: undefined } : t) : s.automation.tasks,
          messages: a.kind === 'message' ? s.automation.messages.map((m) => m.id === a.id ? { ...m, delivery: 'pasted', deliveryError: undefined } : m) : s.automation.messages,
        } }));
        return { pasted: true };
      }
    }
  }

  private grid(gridId: string, actorId?: string) {
    const project = this.state.get().projects.find((p) => p.tabs.some((t) => t.id === gridId));
    if (!project) throw new Error('Grid not found.');
    this.project(project.id, actorId);
    return { project, tab: project.tabs.find((t) => t.id === gridId)! };
  }
  private async closeGrid(a: ReturnType<typeof automationSchemas.close_grid.parse>, actorId?: string) {
    this.coordinator(actorId);
    const { project, tab } = this.grid(a.gridId, actorId);
    if (actorId && tab.cells.some((c) => c.id === actorId)) throw new Error('A coordinator cannot close its own grid.');
    const ids = tab.cells.map((c) => c.id);
    const unfinished = () => this.state.get().automation.tasks.filter((t) => ids.includes(t.cellId) && !['completed', 'cancelled'].includes(t.status));
    if (!a.cancelTasks && unfinished().length) throw new Error('Grid has unfinished tasks. Complete them or explicitly set cancelTasks:true.');
    if (!this.deps.stopCells) throw new Error('Runtime grid shutdown is unavailable.');
    await this.deps.stopCells(ids);
    this.coordinator(actorId);
    const latest = this.grid(a.gridId, actorId);
    if (latest.tab.cells.map((c) => c.id).join() !== ids.join()) throw new Error('Grid changed during shutdown; retry after reviewing its agents.');
    if (!a.cancelTasks && unfinished().length) throw new Error('Grid received new unfinished tasks during shutdown.');
    this.state.change((s) => {
      const next = closeTab(s, project.id, tab.id);
      const tasks = next.automation.tasks.map((t) => a.cancelTasks && ids.includes(t.cellId) && !['completed', 'cancelled'].includes(t.status) ? { ...t, status: 'cancelled' as const, updatedAt: Date.now() } : t);
      return this.log({ ...next, automation: { ...next.automation, tasks } }, project.id, 'grid_closed', tab.name, actorId);
    });
    for (const id of ids) { this.statuses.set(id, 'exited'); this.pendingRestart.delete(id); }
    return { archivedGridId: tab.id, stoppedCellIds: ids };
  }
  private async updateAgent(a: ReturnType<typeof automationSchemas.update_agent.parse>, actorId?: string) {
    if (actorId && actorId !== a.cellId) this.coordinator(actorId);
    const found = findCell(this.state.get(), a.cellId);
    if (!found || getProfile(this.state.get(), found.cell.profileId).cli === 'shell') throw new Error('Agent cell not found.');
    this.project(found.project.id, actorId);
    if (a.profileId !== undefined) {
      const profile = this.state.get().profiles.find((p) => p.id === a.profileId);
      if (!profile || profile.cli === 'shell') throw new Error('Choose an AI agent profile.');
    }
    const patch: Partial<Cell> = {};
    if (a.name !== undefined) patch.name = a.name;
    if (a.color !== undefined) patch.color = a.color ?? undefined;
    if (a.profileId !== undefined) patch.profileId = a.profileId;
    if (a.model !== undefined) patch.model = a.model ?? undefined;
    const launchChanged = (a.profileId !== undefined && a.profileId !== found.cell.profileId) || (a.model !== undefined && (a.model ?? undefined) !== found.cell.model);
    const running = this.deps.isCellRunning?.(a.cellId) ?? this.statuses.get(a.cellId) !== 'exited';
    this.state.change((s) => this.log(updateCell(s, a.cellId, patch), found.project.id, 'agent_updated', a.name ?? found.cell.name ?? a.cellId, actorId));
    if (launchChanged && running) this.pendingRestart.add(a.cellId);
    if (!running) this.pendingRestart.delete(a.cellId);
    let restarted = false, restartReason: string | undefined;
    if (a.restart && running) {
      if (!this.deps.restartAgent) restartReason = 'Safe runtime restart is unavailable.';
      else {
        try { const result = await this.deps.restartAgent(a.cellId); restarted = result.restarted; restartReason = result.reason; }
        catch (error) { restartReason = error instanceof Error ? error.message : String(error); }
      }
    }
    if (restarted) this.pendingRestart.delete(a.cellId);
    return { cellId: a.cellId, ...patch, restarted, needsRestart: running && !restarted && (this.pendingRestart.has(a.cellId) || a.restart), restartReason };
  }
  private validateCells(cells: Array<{ profileId: string; prompt?: string }>) {
    for (const cell of cells) {
      const profile = this.state.get().profiles.find((p) => p.id === cell.profileId);
      if (!profile) throw new Error(`Unknown profile: ${cell.profileId}`);
      if (profile.cli === 'shell' && cell.prompt) throw new Error('Startup tasks require an AI agent profile.');
    }
  }
  private layout(count: number, rows?: number[]) {
    if (rows && rows.reduce((a, b) => a + b, 0) !== count) throw new Error('Row sizes must match the number of cells.');
    return rows ? layoutFromRows(rows) : layoutForCount(count);
  }
  private async createGrid(a: ReturnType<typeof automationSchemas.create_grid.parse> & { gridId?: string }, actorId?: string) {
    this.coordinator(actorId);
    const existing = a.gridId ? this.grid(a.gridId, actorId) : undefined;
    const project = existing?.project ?? this.project(a.projectId, actorId);
    const preset = a.presetId ? this.state.get().presets.find((p) => p.id === a.presetId && (!p.projectId || p.projectId === project.id)) : undefined;
    if (a.presetId && !preset) throw new Error('Preset not found in this project.');
    if (a.presetId && a.cells) throw new Error('Specify either cells or presetId.');
    const cells = a.cells ?? preset?.cells;
    if (!cells?.length || cells.length > 20) throw new Error('Specify 1 to 20 cells or a presetId.');
    this.validateCells(cells);
    if (a.rows && a.layout) throw new Error('Specify rows or layout, not both.');
    const count = (existing?.tab.cells.length ?? 0) + cells.length;
    if (count > 20) throw new Error('Grid cell limit reached (20).');
    const layout = a.layout ?? (!a.rows && preset ? preset.layout : this.layout(count, a.rows));
    if (layout.areas.length !== count) throw new Error('Preset layout must match its cells.');
    const covered = new Set<string>();
    for (const area of layout.areas) {
      if (area.col + area.colSpan > layout.cols || area.row + area.rowSpan > layout.rows) throw new Error('Grid area is outside its bounds.');
      for (let r = area.row; r < area.row + area.rowSpan; r++) for (let c = area.col; c < area.col + area.colSpan; c++) {
        const key = `${c}:${r}`;
        if (covered.has(key)) throw new Error('Grid areas overlap.');
        covered.add(key);
      }
    }
    if (covered.size !== layout.cols * layout.rows) throw new Error('Grid areas must cover the full layout.');
    if (actorId && project.tabs.reduce((n, t) => n + t.cells.length, 0) + cells.length > 100) throw new Error('Agent-created grids are limited to 100 project cells.');
    if (this.state.get().automation.tasks.length + cells.filter((c) => c.prompt && c.role).length > DELIVERY_LIMIT) throw new Error('Task limit reached (500).');
    const created: Worktree[] = [];
    try {
      const specs: Parameters<typeof addTab>[2]['cells'] = [];
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        const worktree = cell.worktree ? await this.deps.createWorktree(project.path, `${a.name || existing?.tab.name}-${uid().slice(0, 8)}-${i + 1}`) : undefined;
        if (worktree) created.push(worktree);
        specs.push({ profileId: cell.profileId, role: cell.role, name: cell.name, color: cell.color ?? (actorId ? TEAM_COLORS[((existing?.tab.cells.length ?? 0) + i) % TEAM_COLORS.length] : undefined), model: cell.model, worktree });
      }
      let gridId = '';
      const cellIds: string[] = [];
      this.state.change((s) => {
        // Recheck permissions and project after asynchronous git operations.
        this.coordinator(actorId);
        const latest = this.project(project.id, actorId);
        this.validateCells(cells);
        if (s.automation.paused && actorId) throw new Error('Automation is paused by the user.');
        if (latest.path !== project.path) throw new Error('Project folder changed while creating worktrees.');
        if (actorId && latest.tabs.reduce((n, t) => n + t.cells.length, 0) + cells.length > 100) throw new Error('Project cell limit reached.');
        if (s.automation.tasks.length + cells.filter((c) => c.prompt && c.role).length > DELIVERY_LIMIT) throw new Error('Task limit reached (500).');
        let next: AppState;
        let grid: Tab;
        if (existing) {
          const current = latest.tabs.find((t) => t.id === existing.tab.id);
          if (!current || current.cells.length !== existing.tab.cells.length || current.cells.some((c, i) => c.id !== existing.tab.cells[i].id)) throw new Error('Grid changed while preparing agents; retry with the latest grid.');
          grid = { ...current, layout, cells: [...current.cells, ...specs.map((spec) => ({ ...spec, id: uid() }))] };
          next = { ...s, projects: s.projects.map((p) => p.id === project.id ? { ...p, tabs: p.tabs.map((t) => t.id === grid.id ? grid : t) } : p) };
        } else {
          next = addTab(s, project.id, { name: a.name, color: a.color ?? (actorId ? TEAM_COLORS[latest.tabs.length % TEAM_COLORS.length] : undefined), layout, cells: specs });
          grid = next.projects.find((p) => p.id === project.id)!.tabs.at(-1)!;
        }
        gridId = grid.id;
        const tasks: AgentTask[] = [];
        for (let i = 0; i < cells.length; i++) {
          const cell = grid.cells[(existing?.tab.cells.length ?? 0) + i];
          cellIds.push(cell.id);
          if (!cells[i].prompt) continue;
          if (!cell.role) {
            next = updateCell(next, cell.id, { startupPrompt: cells[i].prompt });
            continue;
          }
          const task: AgentTask = { id: uid(), projectId: project.id, cellId: cell.id, fromCellId: actorId,
            title: cells[i].name ?? `${a.name || grid.name} ${i + 1}`, prompt: cells[i].prompt!, status: 'queued', delivery: 'startup', createdAt: Date.now(), updatedAt: Date.now() };
          tasks.push(task);
          next = updateCell(next, cell.id, { startupPrompt: taskPrompt(task) });
        }
        next = { ...next, automation: { ...next.automation, tasks: [...next.automation.tasks, ...tasks] } };
        // Automation must preserve the user's active project/tab and keyboard focus.
        next = latest.activeTabId ? setActiveTab(next, project.id, latest.activeTabId) : { ...next,
          projects: next.projects.map((p) => p.id === project.id ? { ...p, activeTabId: null } : p) };
        return this.log(next, project.id, existing ? 'agents_added' : 'grid_created', a.name || grid.name, actorId);
      });
      this.deps.startCells(cellIds);
      return { gridId, cellIds };
    } catch (error) {
      for (const worktree of created.reverse()) await this.deps.removeWorktree(project.path, worktree).catch(() => undefined);
      throw error;
    }
  }
  private blockedBy(task: AgentTask): string[] {
    return (task.dependsOn ?? []).filter((id) => {
      const prerequisite = this.state.get().automation.tasks.find((t) => t.id === id && t.projectId === task.projectId);
      return !prerequisite || prerequisite.status !== 'completed';
    });
  }
  private async deliver(kind: 'task' | 'message', id: string, actorId?: string) {
    const item = kind === 'task' ? this.state.get().automation.tasks.find((t) => t.id === id) : this.state.get().automation.messages.find((m) => m.id === id);
    if (!item) throw new Error('Inbox item not found.');
    this.project(item.projectId, actorId);
    const cellId = 'cellId' in item ? item.cellId : item.toCellId;
    if (actorId && kind === 'task' && actorId !== cellId) this.coordinator(actorId);
    if (actorId && kind === 'message' && item.fromCellId !== actorId) throw new Error('Only the sender can retry delivery.');
    if (kind === 'task' && ['completed', 'cancelled'].includes((item as AgentTask).status)) throw new Error('Task is already closed.');
    if (kind === 'task' && this.blockedBy(item as AgentTask).length) return { delivery: item.delivery, blockedBy: this.blockedBy(item as AgentTask) };
    if (item.delivery !== 'pending' || this.delivering.has(id)) return { delivery: item.delivery };
    this.delivering.add(id);
    let deliveryError: string | undefined;
    try {
      if (this.state.get().automation.paused) throw new Error('Automation is paused by the user.');
      this.target(cellId, actorId);
      const prompt = kind === 'task' ? taskPrompt(item as AgentTask) : `[Ajzakomator message ${id} from ${item.fromCellId ?? 'user'}]\n${(item as AgentMessage).text}\nRead and acknowledge this message using acknowledge_message.`;
      await this.deps.deliver(cellId, prompt);
    } catch (error) { deliveryError = error instanceof Error ? error.message : String(error); }
    finally { this.delivering.delete(id); }
    this.state.change((s) => ({ ...s, automation: { ...s.automation,
      tasks: kind === 'task' ? s.automation.tasks.map((t) => t.id === id ? { ...t, delivery: deliveryError ? 'pending' : 'native', deliveryError } : t) : s.automation.tasks,
      messages: kind === 'message' ? s.automation.messages.map((m) => m.id === id ? { ...m, delivery: deliveryError ? 'pending' : 'native', deliveryError } : m) : s.automation.messages,
    } }));
    return { delivery: deliveryError ? 'pending' : 'native', deliveryError };
  }
}
