# Agents and local MCP

MCP is optional. New grids default to **No MCP**, running ordinary terminals and agents with their original startup prompts. Existing grids do not acquire roles automatically.

## Enable selected cells

Choose a role for each agent in **New grid**:

| Role | Access |
| --- | --- |
| No MCP | Ordinary agent session without ajzakomator tools |
| Worker | Its own tasks, result reporting, project messages and snippets |
| Coordinator | Worker tools, plus background grids, team presets and tasks assigned to other cells |

You can mix roles in one grid and save them in presets. Ordinary shell profiles do not use MCP. Claude Code and Codex receive local server configuration when a cell with a role starts.

Change a role later in **AI → Agents** or the cell's context menu. The app offers to apply it and restart the agent in the same action, resuming the saved conversation when a session is known. If no session is saved yet, it explains that a new conversation will start. You can also apply the role later and restart when ready. Choosing **No MCP** revokes tool access when the role is applied; restarting also removes the configuration from the client.

The Agents panel distinguishes **Restart required**, **MCP configured · waiting for agent** and **MCP connected**. A running local MCP server alone does not mean the selected agent has loaded its configuration or called a tool.

## Work with a team

The **AI** button opens agents, tasks, messages and activity. Tasks move through queued, in-progress, blocked, completed and cancelled states. Completed results can include a summary, changed files, branch, commit and tests. Messages have read acknowledgements. The app persists these records with its local state.

Tasks and messages always enter a durable MCP inbox. Agents use `read_inbox` to retrieve their open tasks and unread messages together (`closed: true` adds closed tasks); `acknowledge: true` also marks the returned messages as read. When idle, agents call `wait_for` instead of polling: it blocks up to `timeoutSec` (max 45 s) and returns at once when an unread message or a startable task arrives. With `taskIds`, a coordinator waits until any (`all: true`: every) listed task is completed, blocked or cancelled, so it does not loop on `get_tasks`. Inbox delivery does not guarantee that a running model will wake up or begin work. Verified running Codex sessions can also receive content through `codex queue`, if their CLI supports it. Verification requires explicitly selecting a session from history; transcript timestamp matching alone is insufficient.

For Claude and unverified Codex sessions, use **Copy prompt** and paste into the terminal. A delivery failure does not delete the task; delivery can be retried. Cancelling a task changes its record but does not interrupt the model.

A startup prompt on a cell with a role becomes a tracked task with reporting instructions. Without a role, it stays ordinary prompt text. Agent-created grids run in the background without switching your active tab. Creating agents can consume model usage; the MCP instructions require an explicit user request to delegate work.

**Pause automation** blocks new agent mutations and automatic delivery. Agents can still read inboxes and report results for existing tasks. You can still create a grid directly in the UI.

## Example: implement, hand off, review

Use an existing grid and enable roles for selected cells, or start a new grid from a team preset. Give the cells recognizable names and colors, and choose a CLI profile per cell. Model choices come from that profile's CLI flags, not from the MCP role.

Ask the coordinator to delegate a feature to a backend worker, a frontend worker and a reviewer. The backend worker reports a completed result with the API contract, changed files and tests, then messages the frontend worker. The frontend worker integrates the contract and reports its result. The reviewer receives a separate task referencing both results, checks the diff and tests, and messages the coordinator with any findings.

An example prompt for the coordinator:

> Add a Backend worker and a Reviewer to this grid. Give them distinct names and colors. Assign Backend the catalog validation change, and make Review depend on that task. Require changed files and test results in the completion report. Use the existing checkout, with separate file ownership. Do not create another grid.

For an existing backend change, create the review or frontend task in the current team instead of spawning another grid. Coordinators can use `create_grid` with `gridId` to expand an existing grid, or with `name` to open a new background team. It accepts per-cell names, colors, profiles, model identifiers and startup prompts. `update_grid` changes a grid's name/color; `update_agent` changes an agent's name/color/profile/model. Model identifiers must be supported by your installed CLI. Profile/model changes apply on launch; inspect `needsRestart` and `restartReason` in the result. A requested restart is attempted only when the runtime can do it safely.

Keep the handoff in the task result so another agent can continue without reconstructing the terminal conversation. In a shared checkout, agree on file ownership; use worktrees if the work should happen on independent branches.

Coordinators can close another finished grid with `close_grid({ "gridId": "..." })`. This stops its agents and archives the grid in History, preserving its conversations and worktrees. If unfinished tasks remain, closing requires `cancelTasks: true`; those tasks are cancelled. A coordinator cannot close its own grid through MCP.

## Task dependencies

Create prerequisite tasks first, then pass their IDs in `dependsOn` when creating downstream work. For example, the frontend task depends on the backend task, and the review task depends on both implementation tasks:

```json
{
  "cellId": "frontend-cell-id",
  "title": "Connect the catalog UI",
  "prompt": "Use the API contract from the backend task result. Report files and tests.",
  "dependsOn": ["backend-task-id"]
}
```

`get_tasks` returns `ready` and `blockedBy`; `get_tasks({ "readyOnly": true })` lists queued work whose prerequisites are all completed. A task cannot be claimed `in_progress` while prerequisites remain unfinished. A cancelled or blocked prerequisite does not count as completed. Dependencies govern readiness and delivery, not whether a model wakes up automatically. Use messages for clarification and task results for the durable handoff.

The worker should call `get_context` first, mark its assigned task `in_progress` before editing, and report `completed` with a summary and evidence. If it cannot proceed, it should report `blocked` with a reason. Workers call `read_inbox` when starting or finishing work and use `wait_for` while idle, rather than polling; `acknowledge: true` batches acknowledgements of the messages returned.

## Tool reference

| Tools | Purpose | Who |
| --- | --- | --- |
| `get_context`, `list_agents` | Cell identity and inbox counts; compact agent list (`verbose` adds details) | all |
| `read_inbox`, `wait_for` | Open tasks and unread messages together; bounded waiting instead of polling | all |
| `update_task`, `send_message` | Report a task result; message an agent | all |
| `snippets` | `action`: `list`, `get`, `save`, `apply` - prompt library and presets | all |
| `update_agent`, `help` | Name, color, profile, model (own; others coordinator only); longer guidance on demand | all |
| `create_task`, `get_tasks`, `deliver` | Assign tasks, project task view (paged with `next`), retry delivery | coordinator |
| `create_grid`, `update_grid`, `close_grid`, `save_preset` | Background teams (`gridId` appends cells), grid name/color, archive, presets | coordinator |

The tool list depends on the role: a worker receives neither the coordinator tools nor their schemas. The previous names (`list_library`, `get_snippet`, `save_snippet`, `apply_snippet`, `add_agents`, `get_messages`, `acknowledge_message`, `deliver_task`, `deliver_message`, `get_tasks`, `create_task`) stay callable but are not listed, so they cost no tokens. Permissions are enforced by the service, not by the tool list.

Results are compact: creating a task or message returns only `id` and delivery state, `update_task` returns `id` and status, long texts end with a `...[truncated N chars; full:true for all]` marker, and lists page with `next`. A reply is a single JSON text block without `structuredContent`, so a client never counts it twice.

## Token cost

Every MCP-enabled agent pays for the tool definitions and instructions in every conversation. Estimate (characters / 3.6): coordinator about 2200 tokens (was 4425), worker about 1260 (was 4425). Measure it and the latencies with `node scripts/mcp-bench.mjs`.

Agents are scoped to their own project. Workers see their own tasks and inbox; coordinators see project tasks. Agents can read global snippets, but write snippets in their project. Only the user changes roles or pauses automation.

The Streamable HTTP server listens on `127.0.0.1` on a random port. Each cell receives its own environment token, invalidated when it ends, restarts or loses its role. Foreign Host and Origin headers are rejected (DNS-rebinding protection), requests are rate limited and capped per token (429), and bodies are limited to 256 KB. Tokens are not placed in process arguments or persisted app state.

## Claude Code and Codex

Claude gets `--mcp-config` with a per-cell file (`type: http`, header `Authorization: Bearer ${AJZ_MCP_TOKEN}`); Codex gets `-c mcp_servers.ajzakomator.url=...` and `bearer_token_env_var="AJZ_MCP_TOKEN"`. Both connect to the local server and see the same tools. The schemas are flat (no `$ref`, `anyOf` or `null` types) because Codex passes them to the model unchanged. Tools that only change app state declare `openWorldHint: false`, so Codex does not ask for approval on every `update_task`; `create_grid` (starts agents) and `close_grid` (stops them) keep the approval prompt.

You can check the connection without a model: `node scripts/mcp-serve.mjs` starts the server with fake dependencies, then `claude mcp add --transport http ...` / `codex mcp add --url ... --bearer-token-env-var ...` with a temporary `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and `claude mcp list`, show the connection state.

## Verify the integration

```sh
npm run typecheck
npm test
npm run test:automation
```

The Electron automation smoke test uses temporary data and stub agent executables, without model calls. It exercises the actual MCP connection, forms, tasks, results, messages, pause controls and persistence. It requires Node.js 22 or newer and an Electron desktop environment. For README captures with real shell output, see [screenshots](screenshots/README.md).

[Polski](MCP.md) · [README](../README.md)
