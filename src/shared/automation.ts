import { z } from 'zod';

export type AgentRole = 'coordinator' | 'worker';
export type TaskStatus = 'queued' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export interface TaskResult {
  summary: string;
  files: string[];
  tests: string[];
  branch?: string;
  commit?: string;
}
export interface AgentTask {
  id: string;
  projectId: string;
  cellId: string;
  fromCellId?: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  dependsOn?: string[];
  delivery: 'pending' | 'startup' | 'native' | 'pasted';
  deliveryError?: string;
  blockedReason?: string;
  result?: TaskResult;
  createdAt: number;
  updatedAt: number;
}
export interface AgentMessage {
  id: string;
  projectId: string;
  toCellId: string;
  fromCellId?: string;
  text: string;
  readAt?: number;
  delivery: 'pending' | 'native' | 'pasted';
  deliveryError?: string;
  createdAt: number;
}
export interface AutomationEvent {
  id: string;
  projectId: string;
  cellId?: string;
  action: string;
  detail: string;
  createdAt: number;
}
export interface AutomationState {
  paused: boolean;
  tasks: AgentTask[];
  messages: AgentMessage[];
  events: AutomationEvent[];
}
export interface McpInfo { running: boolean; url?: string; error?: string; configuredCellIds?: string[]; connectedCellIds?: string[] }
export type AgentRuntimeStatus = 'starting' | 'working' | 'ready' | 'needs_attention' | 'unknown' | 'exited';

/** Longest bounded wait; below the default 60 s tool timeout of Codex and the HTTP stack. */
export const WAIT_MAX_SECONDS = 45;
const id = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(140);
const text = z.string().trim().min(1).max(32000);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const model = z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const role = z.enum(['coordinator', 'worker']);
export const taskResultSchema = z.object({
  summary: text,
  files: z.array(z.string().max(1000)).max(200).default([]),
  tests: z.array(z.string().max(2000)).max(100).default([]),
  branch: z.string().max(200).optional(),
  commit: z.string().max(128).optional(),
}).strict();
const gridCell = z.object({
  profileId: id, name: name.optional(), role: role.optional(), color: color.optional(), model: model.optional(),
  prompt: text.optional(), worktree: z.boolean().default(false),
}).strict();
const gridLayout = z.object({
  cols: z.number().int().min(1).max(60), rows: z.number().int().min(1).max(4),
  areas: z.array(z.object({ col: z.number().int().min(0).max(59), row: z.number().int().min(0).max(3),
    colSpan: z.number().int().min(1).max(60), rowSpan: z.number().int().min(1).max(4) }).strict()).min(1).max(20),
  rowCounts: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
}).strict();
export const automationSchemas = {
  get_context: z.object({}).strict(),
  read_inbox: z.object({ acknowledge: z.boolean().default(false), openOnly: z.boolean().default(false), ackMaxChars: z.number().int().min(1).max(32000).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  list_agents: z.object({ projectId: id.optional() }).strict(),
  list_library: z.object({ projectId: id.optional() }).strict(),
  get_snippet: z.object({ snippetId: id }).strict(),
  apply_snippet: z.object({ snippetId: id, cellId: id }).strict(),
  create_grid: z.object({
    projectId: id.optional(), name, color: color.optional(), cells: z.array(gridCell).min(1).max(20).optional(), presetId: id.optional(),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
    layout: gridLayout.optional(),
  }).strict(),
  close_grid: z.object({ gridId: id, cancelTasks: z.boolean().default(false) }).strict(),
  add_agents: z.object({ gridId: id, cells: z.array(gridCell).min(1).max(20),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(), layout: gridLayout.optional(), }).strict(),
  update_grid: z.object({ gridId: id, name: name.optional(), color: color.nullable().optional() }).strict(),
  update_agent: z.object({ cellId: id, name: name.optional(), color: color.nullable().optional(),
    profileId: id.optional(), model: model.nullable().optional(), restart: z.boolean().default(false) }).strict(),
  save_snippet: z.object({
    projectId: id.optional(), id: id.optional(), name, text,
    autoSend: z.boolean().default(false), icon: z.string().max(32).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }).strict(),
  save_preset: z.object({
    projectId: id.optional(), id: id.optional(), name, cells: z.array(gridCell).min(1).max(20),
    rows: z.array(z.number().int().min(1).max(5)).min(1).max(4).optional(),
  }).strict(),
  create_task: z.object({ cellId: id, title: name, prompt: text, dependsOn: z.array(id).max(50).optional() }).strict(),
  get_tasks: z.object({ readyOnly: z.boolean().default(false), projectId: id.optional(), cellId: id.optional(), ids: z.array(id).min(1).max(50).optional(), status: z.enum(['queued', 'in_progress', 'blocked', 'completed', 'cancelled']).optional(), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  update_task: z.object({ taskId: id, status: z.enum(['in_progress', 'blocked', 'completed', 'cancelled']), blockedReason: text.optional(), result: taskResultSchema.optional() }).strict(),
  send_message: z.object({ toCellId: id, text }).strict(),
  get_messages: z.object({ projectId: id.optional(), unreadOnly: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0) }).strict(),
  acknowledge_message: z.object({ messageId: id }).strict(),
  set_paused: z.object({ paused: z.boolean() }).strict(),
  set_role: z.object({ cellId: id, role: role.nullable() }).strict(),
  deliver_task: z.object({ taskId: id }).strict(),
  deliver_message: z.object({ messageId: id }).strict(),
  wait_for: z.object({ taskIds: z.array(id).min(1).max(50).optional(), all: z.boolean().default(false), timeoutSec: z.number().int().min(1).max(WAIT_MAX_SECONDS).default(30) }).strict(),
  mark_pasted: z.object({ kind: z.enum(['task', 'message']), id }).strict(),
} as const;
export type AutomationOperation = keyof typeof automationSchemas;
export type AutomationInput<K extends AutomationOperation> = z.input<(typeof automationSchemas)[K]>;

export const defaultAutomation = (): AutomationState => ({ paused: false, tasks: [], messages: [], events: [] });
export const taskPrompt = (task: AgentTask): string =>
  `[Unimux task ${task.id}] ${task.title}\n\n${task.prompt}\n\n` +
  'Unimux MCP: update_task in_progress before working; finish with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). ' +
  'read_inbox for new tasks and messages; wait_for instead of polling. Claim a task only after its dependsOn tasks completed. Do not create agents unless explicitly asked.';
