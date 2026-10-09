import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjzakomatorMcpServer } from '../src/main/mcp';
import { AutomationService } from '../src/main/automation';
import { StateController } from '../src/main/stateController';
import { addProject, addTab, defaultState } from '../src/shared/state';
import { layoutForCount } from '../src/shared/layout';

const running: AjzakomatorMcpServer[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())); });
async function setup() {
  let state = addProject(defaultState(), { name: 'Project', path: 'D:/project' });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(2), cells: [{ profileId: 'codex', role: 'coordinator' }, { profileId: 'claude', role: 'worker' }] });
  const controller = new StateController(state, () => {});
  const service = new AutomationService(controller, {
    createWorktree: vi.fn(), removeWorktree: vi.fn(), startCells: vi.fn(), deliver: vi.fn(async () => { throw new Error('Not running'); }),
  });
  const server = new AjzakomatorMcpServer(service);
  running.push(server);
  await server.start();
  const [coordinator, worker] = state.projects[0].tabs[0].cells;
  return { server, controller, coordinator, worker, url: server.getInfo().url! };
}
describe('local MCP over Streamable HTTP', () => {
  it('connects a real MCP client, exposes tools and persists results from agent calls', async () => {
    const f = await setup();
    const token = f.server.issueToken(f.coordinator.id);
    const client = new Client({ name: 'integration-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(f.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain('create_grid');
      expect(tools).toContain('add_agents');
      expect(tools).toContain('read_inbox');
      expect(tools).toContain('update_grid');
      expect(tools).toContain('update_agent');
      expect(tools).toContain('apply_snippet');
      expect(tools).not.toContain('set_role');
      expect(tools).not.toContain('set_paused');
      const context = await client.callTool({ name: 'get_context', arguments: {} });
      expect(context.structuredContent).toMatchObject({ result: { cellId: f.coordinator.id, role: 'coordinator' } });
      const created = await client.callTool({ name: 'create_task', arguments: { cellId: f.worker.id, title: 'Review', prompt: 'Review changes' } });
      expect(created.isError).not.toBe(true);
      expect(f.controller.get().automation.tasks[0]).toMatchObject({ title: 'Review', delivery: 'pending' });
      const task = f.controller.get().automation.tasks[0];
      const reported = await client.callTool({ name: 'update_task', arguments: { taskId: task.id, status: 'completed', result: { summary: 'Reviewed', tests: ['passed'] } } });
      expect(reported.isError).not.toBe(true);
      expect(f.controller.get().automation.tasks[0].result?.tests).toEqual(['passed']);
    } finally { await client.close(); }
  });
  it('rejects missing credentials, foreign origins and invalid hosts before handling tools', async () => {
    const f = await setup();
    expect((await fetch(f.url, { method: 'POST' })).status).toBe(401);
    const authorization = `Bearer ${f.server.issueToken(f.worker.id)}`;
    expect((await fetch(f.url, { method: 'POST', headers: { Authorization: authorization, Origin: 'https://untrusted.example' } })).status).toBe(403);
    // Fetch normalizes Host; use Node HTTP to exercise the actual inbound header check.
    const badHost = await new Promise<number>((resolve, reject) => {
      const req = request(f.url, { method: 'POST', headers: { Authorization: authorization, Host: 'untrusted.example' } }, (res) => {
        res.resume(); resolve(res.statusCode!);
      });
      req.on('error', reject); req.end();
    });
    expect(badHost).toBe(403);
    expect((await fetch(f.url, { method: 'GET', headers: { Authorization: authorization } })).status).toBe(405);
    expect(f.controller.get().automation.events).toEqual([]);
  });
  it('enforces the token owner role and revokes credentials when its cell restarts', async () => {
    const f = await setup();
    const token = f.server.issueToken(f.worker.id);
    const client = new Client({ name: 'worker-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(f.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const peerEdit = await client.callTool({ name: 'update_agent', arguments: { cellId: f.coordinator.id, name: 'Denied' } });
      expect(peerEdit.isError).toBe(true);
      const ownEdit = await client.callTool({ name: 'update_agent', arguments: { cellId: f.worker.id, name: 'Worker label', model: 'gpt-5.4' } });
      expect(ownEdit.structuredContent).toMatchObject({ result: { needsRestart: true, restarted: false } });
      const inbox = await client.callTool({ name: 'read_inbox', arguments: { acknowledge: true } });
      expect(inbox.structuredContent).toMatchObject({ result: { tasks: [], messages: [], acknowledgedMessageIds: [] } });
      const forbidden = await client.callTool({ name: 'create_grid', arguments: { name: 'Denied', cells: [{ profileId: 'codex' }] } });
      expect(forbidden.isError).toBe(true);
      expect(f.controller.get().projects[0].tabs).toHaveLength(1);
      f.server.issueToken(f.worker.id);
      await expect(client.callTool({ name: 'get_context', arguments: {} })).rejects.toThrow();
    } finally { await client.close(); }
  });
  it('limits request bodies without modifying application state', async () => {
    const f = await setup();
    const response = await fetch(f.url, { method: 'POST', headers: {
      Authorization: `Bearer ${f.server.issueToken(f.coordinator.id)}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'save_snippet', arguments: { name: 'Too large', text: 'x'.repeat(300000) } } }) });
    expect(response.status).toBe(413);
    expect(f.controller.get().snippets).toEqual([]);
  });
});


describe('MCP connection indicators', () => {
  it('distinguishes configured tokens from authenticated connections and clears on revoke/stop', async () => {
    const f = await setup();
    const token = f.server.issueToken(f.worker.id);
    expect(f.server.getInfo()).toMatchObject({ configuredCellIds: [f.worker.id], connectedCellIds: [] });
    await fetch(f.url, { method: 'POST', headers: { Authorization: 'Bearer bad' } });
    expect(f.server.getInfo().connectedCellIds).toEqual([]);
    const client = new Client({ name: 'status-test', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(f.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      expect(f.server.getInfo().connectedCellIds).toEqual([f.worker.id]);
      const copy = f.server.getInfo();
      copy.connectedCellIds!.length = 0;
      expect(f.server.getInfo().connectedCellIds).toEqual([f.worker.id]);
      f.server.issueToken(f.worker.id);
      expect(f.server.getInfo()).toMatchObject({ configuredCellIds: [f.worker.id], connectedCellIds: [] });
      f.server.revokeCell(f.worker.id);
      expect(f.server.getInfo()).toMatchObject({ configuredCellIds: [], connectedCellIds: [] });
      f.server.issueToken(f.coordinator.id);
      await f.server.stop();
      expect(f.server.getInfo()).toMatchObject({ running: false, configuredCellIds: [], connectedCellIds: [] });
    } finally { await client.close(); }
  });
});
