<div align="center">

<img src="resources/logo.svg" width="96" alt="ajzakomator logo" />

# ajzakomator

**A terminal grid for running many Claude Code and Codex agents side by side on Windows and macOS.**

Keep projects, agent conversations, source files and reusable prompts in one workspace.
Switch projects while your terminals keep running in the background.

[![Release](https://img.shields.io/github/v/release/adamejzak/ajzakomator?style=flat-square&color=f4f4f5&labelColor=18181b)](https://github.com/adamejzak/ajzakomator/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/adamejzak/ajzakomator/total?style=flat-square&color=f4f4f5&labelColor=18181b)](https://github.com/adamejzak/ajzakomator/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/adamejzak/ajzakomator/ci.yml?branch=main&style=flat-square&label=tests&labelColor=18181b)](https://github.com/adamejzak/ajzakomator/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-f4f4f5?style=flat-square&labelColor=18181b)](#install)
[![License](https://img.shields.io/github/license/adamejzak/ajzakomator?style=flat-square&color=f4f4f5&labelColor=18181b)](LICENSE)

[**Download**](https://github.com/adamejzak/ajzakomator/releases/latest) · [Features](#features) · [Shortcuts](#keyboard-shortcuts) · [MCP guide](docs/MCP.en.md) · [Po polsku](README.pl.md)

<br />

<img src="docs/screenshots/main.png" alt="English ajzakomator workspace with projects, four real demo terminals and reusable prompts" width="100%" />

</div>

<br />

## Why

Running one AI coding agent is easy. Running six of them across three repos is not: terminals pile up,
you lose track of which one is waiting for you, and closing a window means losing the conversation.

ajzakomator gives every project its own set of terminal grids, keeps every agent running in the
background, tells you which one needs you, and brings any grid or conversation back with one click.

## Features

**Grids that fit the work**

- 1, 2, 2×2 up to 5×4, plus row layouts like `3+2` or `2+2+1`, and merged cells
- Several grids per project as tabs; **+ Add** grows the current grid one agent at a time
- Every cell can have its own name, color, startup prompt and an isolated `git worktree`
- Presets for setups you use often, global or per project

**Built for agents**

- Profiles for **Claude Code**, **Codex** and a shell: **PowerShell** on Windows, **zsh / bash** on macOS, with your own CLI flags
- Live status per cell, tab and project: ◐ working, ● waiting for you
- Desktop notification when a background agent finishes or asks for permission; click it to jump there
- Cells are named after the conversation automatically
- Optional local **MCP** gives selected Claude Code and Codex cells coordinator or worker roles, tracked tasks, structured results and messages. Ordinary grids start with **No MCP**. See the [English guide](docs/MCP.en.md) or [Polish guide](docs/MCP.md).

**Never lose a conversation**

- Restart the app and every grid comes back with its conversations resumed
- Closed grids go to History and return with one click
- Browse past Claude and Codex conversations of a project, including ones started outside the app

**Prompts at your fingertips**

- Snippet library with icons and colors: click to paste into the focused cell, Shift+click to send to the whole grid, or drag onto any cell
- `Ctrl+K` (`Cmd+K` on macOS) command palette over projects, grids, snippets, presets, history and actions

**Edit without leaving the workspace**

- Open text files from **Files** into editor tabs and switch back to the running grid
- Line numbers, syntax colors for common code/config formats, bracket matching, code folding, search and undo/redo
- Save with `Ctrl+S` / `Cmd+S`, insert indentation with Tab and toggle line wrapping
- Unsaved changes are marked; closing a modified file offers save, discard or cancel
- Drafts survive a renderer reload; a file changed on disk is checked before saving

**Native terminals on both platforms**

- Windows uses ConPTY; macOS uses PTYs with interactive login shells, including your shell's agent `PATH`
- macOS supports `Cmd+C` / `Cmd+V` for terminal copy and paste
- On Windows: agent colors, mouse clicks inside TUIs, AltGr characters and clipboard images
- Windows key release events support **hold Space to dictate** in agents that provide voice input
- GPU rendering, smooth with a 4×3 grid of busy agents

**Small things that add up**

- Project icons (emoji or your own image), drag to reorder projects and snippets
- Resize both side panels by dragging their inner edge; double click to reset. Widths and list order are saved
- Browse the active project's file tree in **Files**, edit source in the integrated code editor, or open it in your external editor
- Right-click projects, grids, snippets, files, or empty panel space for their actions; click the project editor's avatar to choose an image
- Auto updates for the installed Windows app; macOS and portable Windows builds link to the download page
- Polish, English, German, Spanish, French and Portuguese UI: choose on first launch, change anytime in Settings
- Dark, minimal UI in the spirit of Cursor

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/grid-dialog.png" alt="New grid dialog with a review-team preset, profiles, MCP roles and startup prompts" /></td>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="Ctrl+K command palette" /></td>
  </tr>
  <tr>
    <td align="center"><sub>New grid: layout, names, profiles and startup prompts per cell</sub></td>
    <td align="center"><sub><code>Ctrl+K</code> palette over everything</sub></td>
  </tr>
</table>

<img src="docs/screenshots/editor.png" alt="Atlas catalog source open in an editor tab beside the project file tree" width="100%" />

*These screenshots show the English UI with disposable demo projects and real shell output. They do not contain live AI conversations. [Reproduce the screenshots](docs/screenshots/README.md).*

## Install

**Windows**

1. Download **`ajzakomator-Setup-x.y.z.exe`** from the [latest release](https://github.com/adamejzak/ajzakomator/releases/latest)
2. Run it. Windows SmartScreen may warn about an unsigned app: choose *More info* and *Run anyway*
3. Choose the app language on first launch
4. Add a project (any folder) and open a grid

`ajzakomator-Portable-x.y.z.exe` runs without installing. See [Updating](#updating) for the differences between builds.

**macOS (Apple Silicon and Intel)**

1. Download **`ajzakomator-x.y.z-mac-arm64.dmg`** for Apple Silicon or **`ajzakomator-x.y.z-mac-x64.dmg`** for Intel from the [latest release](https://github.com/adamejzak/ajzakomator/releases/latest).
2. Open the DMG and drag **ajzakomator** to **Applications**. ZIP packages are also available.
3. Open the app, choose a language, then add a project and open a grid.

Mac builds use an ad-hoc signature without an Apple Developer certificate and are not notarized; macOS may require **Open Anyway** in **System Settings → Privacy & Security**. Updates are installed manually from the download page; automatic updates need a publisher signing identity. See [Electron's signing requirements](https://www.electronjs.org/docs/latest/tutorial/code-signing#macos-apis-that-require-code-signing).

**Requirements:** Windows 10 1809+ or Windows 11 ([PowerShell 7](https://aka.ms/powershell) recommended), or macOS with zsh/bash. Install the agents you want to use on your shell's `PATH` (`claude`, `codex`). `git` is needed only for worktrees.

**Languages:** English, Polish, German, Spanish, French and Portuguese. First launch suggests your system language and asks you to confirm it. Use **Settings → App language** to change it immediately. Existing installations keep Polish until you change it.

## First project

1. Add the folder you want to work in. Agent commands run in that project folder.
2. Open a terminal or create a grid, choosing a profile for each cell. Add names and startup prompts if useful.
3. Keep MCP disabled for ordinary sessions, or explicitly choose worker/coordinator roles for a managed team.
4. Use **Files** to inspect and edit source, and save frequently used instructions as snippets.

## Updating

The installed Windows app checks GitHub Releases and downloads updates in the background. The header shows download progress, transferred size and speed. When a download is ready, click **New version … · restart**, or quit normally to apply it without relaunching. Save your editor changes before restarting; agent conversations are restored through their CLI resume support.

To check manually, right-click the **ajzakomator** name/version and choose **Check for updates**. If checking or downloading fails, the header offers a retry and shows the error.

Portable Windows and macOS builds open the release download page instead of installing updates automatically. Replace the app with the new download; your local app data is kept separately. Development builds do not install updates.

## Why enable MCP?

Use ordinary grids when you want independent conversations. Enable MCP when several agents need a shared record of who owns each task, what changed and what is ready for review. The **AI** panel lets you inspect tasks and results without searching terminal scrollback.

For a feature spanning an API and UI, name and color the cells **Coordinator**, **Backend**, **Frontend** and **Reviewer**. Choose Claude Code or Codex per cell; configure CLI flags in profiles for the model and options supported by your installed CLI. Coordinators can also choose per-cell model overrides through MCP. Reuse an existing grid by enabling roles in **AI → Agents**, or create a new grid with roles and startup prompts. When changing a role, the app offers to apply it and restart/resume the agent, or defer the restart.

1. Ask the coordinator to split the feature into scoped tasks and delegate to the chosen workers. Shared checkout teams should agree on file ownership; use worktrees when independent branches suit the work.
2. Ask the coordinator to create the frontend task with `dependsOn` pointing to the backend task. Have the backend worker report the API contract, changed files and test results, then send a handoff message.
3. Have the frontend worker report its implementation, then give the reviewer a task with both results. The reviewer checks the diff and tests and reports findings to the coordinator.
4. Review the records in **AI → Tasks**, fix any gaps and decide when to integrate. Save the team as a preset for the next feature.

MCP tasks and messages are persisted handoffs, not a promise of automatic model execution. For agents without verified native delivery, copy the task prompt into the intended terminal. Read the [MCP guide](docs/MCP.en.md) for roles, delivery and pause controls.

## Keyboard shortcuts

On macOS, replace **Ctrl** with **Cmd** and **Alt** with **Option** in the app shortcuts below.

| Shortcut | Action |
|---|---|
| `Ctrl+K` / `Ctrl+Shift+P` | Command palette |
| `Ctrl+Shift+T` | New tab with a single terminal |
| `Ctrl+Shift+G` | New grid or preset |
| `Ctrl+Shift+N` | Add an agent to the current grid |
| `Ctrl+Shift+W` | Close the grid (it goes to History) |
| `Ctrl+Shift+H` | History of conversations and grids |
| `Ctrl+Shift+M` | Maximize or restore the cell (or double click its header) |
| `Ctrl+Alt+Arrows` | Move between cells |
| `Ctrl+Tab` | Next grid |
| `Ctrl+Shift+B` / `Ctrl+Shift+E` | Toggle snippets / projects panel |
| `Ctrl+Wheel` | Zoom a single cell |

Plain `Ctrl+T`, `Ctrl+B` and `Ctrl+W` in terminals are left alone on purpose: Claude Code and Codex use them.

In an editor tab, `Ctrl+S` / `Cmd+S` saves the file and **Tab** inserts indentation. The editor toolbar offers line wrapping and a close button with unsaved-change protection.

## How it works

```mermaid
flowchart LR
  R["Renderer<br/>React + xterm.js (WebGL)"] <-- "MessagePort<br/>terminal data" --> H["Pty Host<br/>utilityProcess + node-pty"]
  M["Main process<br/>state, git, notifications,<br/>hook server, updater"] <-- IPC --> R
  M <-- control --> H
  H --> T["Native PTY<br/>Windows: pwsh / ConPTY<br/>macOS: zsh / bash<br/>→ claude / codex"]
```

- **Pty Host.** All terminals live in a separate process and stream straight to the window, so a dozen chatty agents never freeze the UI. Reloading the window keeps every agent alive and replays its output.
- **Terminal fidelity.** On Windows, node-pty runs with the bundled, newer ConPTY, and ajzakomator implements Windows Terminal's `win32-input-mode`. That delivers real key release events, which is what makes hold Space to talk work. macOS uses native POSIX PTYs.
- **Status.** Claude Code reports through per-cell hooks passed with `--settings` (your own `settings.json` is never touched). Codex is read from its terminal notifications, with an activity heuristic as a fallback.
- **Resume.** Claude cells start with a known `--session-id` and resume with `--resume`. Codex sessions are matched to their cell from `~/.codex/sessions` and resumed with `codex resume`.
- **Local app state.** Projects, layouts, snippets and MCP inboxes live in `%APPDATA%\ajzakomator\state.json` on Windows and `~/Library/Application Support/ajzakomator/state.json` on macOS. Update checks contact GitHub Releases. Agents run their own CLIs and use the services configured for those CLIs.

## Development

```powershell
git clone https://github.com/adamejzak/ajzakomator
cd ajzakomator
npm install          # .npmrc sets legacy-peer-deps
npm run dev          # app with hot reload
npm test             # unit tests + integration tests against a real native PTY
npm run dist:win     # Windows installer + portable build in release/
npm run dist:mac     # macOS DMG + ZIP in release/ (run on a Mac)
npm run test:packaged # verify node-pty using the packaged Electron runtime
```

Built with Electron, TypeScript, React, Zustand, xterm.js, node-pty, electron-vite and Vitest.

To refresh the README images after building, run `node scripts/capture-readme.mjs`. It launches a separate offscreen Electron instance with temporary data and captures the actual UI via CDP. See the [capture instructions](docs/screenshots/README.md).

**CI builds:** [`.github/workflows/ci.yml`](.github/workflows/ci.yml) tests and packages Windows x64, macOS ARM64 (`macos-15`) and macOS x64 (`macos-15-intel`) on their native runners. Pushes to `main`, `v*` tags, pull requests and manual runs upload installer artifacts. macOS builds rebuild native dependencies for Electron and run a packaged terminal smoke test. You can trigger Mac builds from Windows with **Actions → CI → Run workflow** after the workflow is pushed.

| Path | What lives there |
|---|---|
| `src/shared` | Pure logic: layouts, state model, launch commands, status tracking, key encoding |
| `src/ptyhost` | The terminal process (node-pty) |
| `src/main` | Electron main: persistence, sessions index, hooks, worktrees, updater |
| `src/renderer` | The UI |
| `test` | Vitest suites |

Windows releases: `npm run release` bumps the version, runs the tests, builds and publishes to GitHub Releases
(set `NOTES="what changed"` for release notes).
To publish all platforms together, push a version tag, wait for CI to pass, and run **Actions → Publish release** with the tag and successful CI run ID. Add notes in `docs/releases/x.y.z.md` first. The workflow checks that the build matches the tag, verifies package hashes, combines both Mac update manifests, and publishes all installers in one release.

## Roadmap

- Linux builds
- Split view across projects
- Per-grid environment variables

Ideas and bug reports are welcome in [Issues](https://github.com/adamejzak/ajzakomator/issues).

## License

[MIT](LICENSE). Not affiliated with Anthropic or OpenAI. Claude Code and Codex are their respective owners' products.
