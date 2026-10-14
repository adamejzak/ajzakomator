import { UnimuxMcpServer, type McpServerOptions } from '../../src/main/mcp';
import { AutomationService } from '../../src/main/automation';
import { StateController } from '../../src/main/stateController';
import { addProject, addTab, defaultState } from '../../src/shared/state';
import { layoutForCount } from '../../src/shared/layout';

/** An in-process MCP server with fake automation dependencies: one project, one coordinator and one worker. */
export async function startMcpHarness(deliver: (cellId: string, text: string) => Promise<void> = async () => { throw new Error('Not running'); }, options: McpServerOptions = {}) {
  let state = addProject(defaultState(), { name: 'Project', path: 'D:/project' });
  state = addTab(state, state.projects[0].id, { layout: layoutForCount(3), cells: [
    { profileId: 'claude', role: 'coordinator', name: 'Lead' }, { profileId: 'codex', role: 'worker', name: 'Backend' }, { profileId: 'claude', role: 'worker', name: 'Review' },
  ] });
  const controller = new StateController(state, () => {});
  const service = new AutomationService(controller, {
    createWorktree: async () => { throw new Error('no worktrees in the harness'); }, removeWorktree: async () => undefined, startCells: () => undefined, stopCells: async () => undefined, deliver,
  });
  const server = new UnimuxMcpServer(service, options);
  await server.start();
  const [coordinator, worker, reviewer] = controller.get().projects[0].tabs[0].cells;
  return { server, service, controller, coordinator, worker, reviewer, url: server.getInfo().url!, project: controller.get().projects[0] };
}
