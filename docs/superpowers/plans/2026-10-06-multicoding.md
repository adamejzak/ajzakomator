# MultiCoding Implementation Plan

> **For agentic workers:** executed natively (superpowers:executing-plans) in the authoring session.
> User waived plan/spec review ("nie muszę tego przejrzeć, po prostu to zrób"), so this plan is
> condensed: files, interfaces and test cases per task; code lives in the commits.

**Goal:** Windows desktop app: projects sidebar, per-project tabs of terminal grids running Claude/Codex,
profiles/presets, snippets, Ctrl+K, statuses + notifications, archive/session resume.

**Architecture:** Electron (main) + utilityProcess Pty Host (node-pty, bundled ConPTY) + React renderer
with xterm.js WebGL. Pure logic in `src/shared` (unit tested), side effects in main/ptyhost/renderer.

**Tech Stack:** electron 44, electron-vite, TypeScript, React 19, Zustand, @xterm/xterm 6, node-pty 1.1,
Vitest, electron-builder.

**Spec:** `docs/superpowers/specs/2026-10-06-multicoding-design.md`

## Global Constraints

- Windows only; shell `pwsh.exe -NoLogo` with fallback `powershell.exe -NoLogo`.
- node-pty spawn: `useConpty: true, useConptyDll: true`, `name: 'xterm-256color'`, env = cleanEnv + `COLORTERM=truecolor`, `TERM_PROGRAM=MultiCoding`.
- xterm: `windowsPty: {backend:'conpty', buildNumber}`, Cascadia Mono 13, Campbell palette, bg `#0d0d0d`.
- win32-input-mode encoder active when the pty requested `?9001h`.
- State file `%APPDATA%\MultiCoding\state.json`, atomic write, `.bak` on successful load.
- Max grid 5×4; auto-grow sequence 1, 2(2×1), 2×2, 3×2, 3×3, 4×3, 5×4.
- UI copy in Polish.

## Review Focus

1. Polish keyboard AltGr chars (ą ę ł ż) in win32 mode → typed correctly (encoder test: AltGr+a → Uc=261, Cs has RIGHT_ALT|LEFT_CTRL).
2. Closing the app with live agents → no crash, state saved (ptyhost shutdown test: kill-all resolves after all exits).
3. Project path with spaces / Polish chars → shell starts in it, launch command quoted (profiles test with `D:\Moje Projekty\źródło`).
4. Corrupted / missing state.json → app starts with `.bak` or defaults (store tests).
5. Session files with unknown/garbage lines → indexer skips them, no throw (sessions test with junk line).

---

### Task 1: Scaffold
Files: `package.json`, `electron.vite.config.ts`, `tsconfig*.json`, `vitest.config.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/src/main.tsx`, `src/renderer/src/App.tsx`.
Main build has two inputs: `index` and `ptyhost` (`src/ptyhost/index.ts`). node-pty external.
Verify: `npm run build` succeeds, `npx vitest run` runs (0 tests ok), `npm run dev` opens a dark window. Commit.

### Task 2: Grid layout (`src/shared/layout.ts`, test `test/layout.test.ts`)
Produces:
- `type Area = {col:number,row:number,colSpan:number,rowSpan:number}`; `type GridLayout = {cols:number,rows:number,areas:Area[]}`
- `createLayout(cols, rows): GridLayout` (one area per field, row-major)
- `mergeRect(layout, rect: Area): GridLayout` — areas fully inside rect replaced by rect; areas partially overlapping → returns layout unchanged
- `unmergeAll(layout): GridLayout`
- `layoutForCount(n): GridLayout` — auto-grow sequence; n>20 → 5×4
- `growLayout(layout): GridLayout | null` — next step in sequence with one more area (null at 20)
- `removeArea(layout, index): GridLayout` — shrinks via layoutForCount(count-1) when layout is unmerged, else drops area
Tests: createLayout(2,2) has 4 areas; merge top row of 2×2 → 3 areas, first spans 2; partial overlap unchanged; layoutForCount(5) is 3×2 with 6 areas? → no: exactly n areas: 3×2 grid with 5 areas (last area spans 2 cols? keep simple: last row's final area extends to fill remaining columns). layoutForCount(1) 1×1.

### Task 3: App state model (`src/shared/types.ts`, `src/shared/state.ts`, test `test/state.test.ts`)
Produces types `Project, Tab, Cell, Profile, Preset, Snippet, ArchivedTab, AppState, CellSession, Settings` (as spec) and pure functions returning new state:
`defaultState()`, `addProject(s, {name,path})`, `updateProject(s,id,patch)`, `removeProject(s,id)`, `setActiveProject(s,id)`,
`addTab(s, projectId, {name?, layout, cells: Array<{profileId, worktree?}>})`, `renameTab`, `setActiveTab`, `closeTab(s, projectId, tabId)` (→archive, max 50),
`restoreTab(s, projectId, archivedId)`, `addCell(s, projectId, tabId, profileId)` (grows layout), `removeCell(s, projectId, tabId, cellId)`,
`updateCell(s, ids, patch)`, `upsertProfile/removeProfile`, `upsertPreset/removePreset`, `upsertSnippet/removeSnippet`, `updateSettings`.
`findCell(s, cellId) → {project, tab, cell} | null`.
Tests: add project+tab; close→archive→restore keeps cells' session ids; addCell grows 2×2→3×2; removing active project picks next; defaultState has 5 profiles.

### Task 4: Launch commands + env (`src/shared/profiles.ts`, `src/shared/env.ts`, tests)
`DEFAULT_PROFILES`; `psQuote(s)` single-quote escaping; `buildLaunchCommand(profile, {mode:'new'|'resume', sessionId?, claudeSettingsPath?}) → string | null` (shell profile → null).
claude new: `claude --session-id <id> --settings '<path>' <args>`; resume: `claude --resume <id> --settings '<path>' <args>`; codex new: `codex -c tui.notifications=true <args>`; resume: `codex resume <id> -c tui.notifications=true <args>`.
`cleanEnv(env) → env` removes session vars from spec.
Tests: quoting path with space and `'`; resume variants; cleanEnv keeps PATH, drops CLAUDE_CODE_CHILD_SESSION and CLAUDECODE, keeps CLAUDE_CODE_ENABLE_TELEMETRY.

### Task 5: win32 key encoder (`src/shared/win32input.ts`, test)
Port spike encoder to TS: `encodeWin32Key(ev: KeyLike): string | null`.
Tests: Space down → `\x1b[32;57;32;1;0;1_`, up Kd=0; Ctrl+C → Uc=3 Cs=8; AltGr+a (key 'ą') → Uc=261, Cs&0x09; ArrowUp has ENHANCED 0x100; unknown code → null.

### Task 6: Status tracker (`src/shared/status.ts`, test)
`type CellStatus = 'idle'|'working'|'waiting'|'exited'`.
`class StatusTracker { constructor(quietMs=1500); input(now); output(now, bytes); hook(event:'prompt'|'stop'|'notify'); osc9(); exited(); tick(now): CellStatus; get status }` — output after input → working; quiet ≥ quietMs while working → waiting; hook prompt → working, stop/notify → waiting (hook mode disables quiet heuristic for 'waiting' only after first hook received); osc9 → waiting.
`aggregate(list): {working:number, waiting:number, exited:number}`.
Tests for each transition.

### Task 7: Fuzzy search (`src/shared/fuzzy.ts`, test)
`fuzzyScore(query, text): number | null` (subsequence, bonuses for word starts/consecutive), `fuzzyFilter(items, query, getText, limit)`.
Tests: "bd" matches "bot-discord" higher than "abcd"; no match → null; empty query returns all.

### Task 8: Pty Host (`src/ptyhost/index.ts`, `src/main/ptyHostClient.ts`, `src/shared/ipc.ts`, test `test/ptyhost.int.test.ts`)
Host protocol over `process.parentPort` (control) + transferred MessagePort to renderer (data):
control msgs `{t:'spawn', id, cwd, cols, rows, env, command?}`, `{t:'kill', id}`, `{t:'killAll'}`; host→main `{t:'exit', id, code}`, `{t:'spawned', id, pid}`, `{t:'killedAll'}`.
data port msgs renderer→host `{t:'write', id, data}`, `{t:'resize', id, cols, rows}`; host→renderer `{t:'data', id, data}` (4 ms coalescing), `{t:'exit', id, code}`.
Core class `PtyManager` (in `src/ptyhost/manager.ts`) independent of Electron, so integration test runs it in Node: spawn pwsh, write `echo mc-ok`, receive output containing `mc-ok`, resize, killAll resolves.
`command` is written to the shell after first output.
Main `PtyHostClient`: forks utilityProcess, restarts on crash (emits 'crashed'), `connectRenderer(webContents)` creates MessageChannelMain and sends port1 to host, port2 to renderer, `shutdown()` → killAll then exit.

### Task 9: Store (`src/main/store.ts`, test with tmp dir)
`loadState(dir): AppState` (state.json → validate shape → copy to .bak; invalid → .bak → defaultState), `createSaver(dir, debounceMs)` with `save(state)` and `flush()`; atomic tmp+rename.
Tests: roundtrip; garbage json → bak used; both missing → default; flush writes immediately.

### Task 10: Session index (`src/main/sessions.ts`, test with fixtures)
`claudeProjectDirName(path)` (non-alphanumerics → '-'); `listClaudeSessions(home, projectPath)`; `listCodexSessions(home, projectPath)`; returns `SessionInfo {cli, id, cwd, startedAt, updatedAt, firstPrompt}` sorted desc; reads at most first 64 KB per file; skips bad lines.
`findNewCodexSession(home, cwd, sinceMs)` for capturing codex ids.
Tests with fixture jsonl incl. junk line.

### Task 11: Hook server (`src/main/hooks.ts`, test)
HTTP server on 127.0.0.1:0 with random token; route `POST /h/<token>/<cellId>/<event>`; emits `('hook', cellId, event)`; wrong token → 403.
`writeClaudeSettings(dir, cellId, port, token) → path` with hooks UserPromptSubmit→prompt, Stop→stop, Notification→notify using `curl -s -m 2 -X POST http://127.0.0.1:<port>/h/<token>/<cellId>/<event>`.
Tests: fetch route triggers event; bad token 403; settings JSON shape.

### Task 12: Worktrees (`src/main/worktree.ts`, test with temp git repo)
`isGitRepo(path)`, `createWorktree(projectPath, name) → {path, branch}` (`..\<base>-wt-<name>`, branch `mc/<name>`; name collision → suffix), `removeWorktree(projectPath, wtPath)`.
Test in temp repo.

### Task 13: Main wiring + preload
`src/main/index.ts`: window (frameless w/ titleBarOverlay), load state, ptyhost, hooks, ipc handlers: `state:load`, `state:save`, `pty:spawnCell` (builds cwd/env/command incl. MC settings), `pty:kill`, `dialog:pickFolder`, `sessions:list`, `worktree:create/remove`, `notify:show`, `shell:openPath`, `shell:openInCursor`; forwards hook events + ptyhost restarts to renderer; codex session capture after spawn (poll findNewCodexSession for 60 s). Graceful quit: flush state, ptyhost shutdown.
`src/preload/index.ts`: `window.mc` typed API + receives MessagePort (`ipcRenderer.on('pty-port')` → `window.postMessage` transfer).
Verify: build + dev launches, one terminal works.

### Task 14: Terminal manager (`src/renderer/src/terminals/TerminalManager.ts`)
Registry `cellId → {term, fit, webgl?, host div, tracker}`; `ensure(cell, spawnOpts)`, `attach(cellId, el)`, `detach(cellId)`, `dispose(cellId)`, `focus(cellId)`, `paste(cellId, text, send)`, `setFontSize`, statuses via subscription; key handler (win32 + clipboard + app shortcuts passthrough), OSC 9 handler, Ctrl+wheel zoom, WebGL only while attached.

### Task 15: Layout UI
`App.tsx`, `store.ts` (zustand over shared reducers + debounced save), `Sidebar.tsx`, `TabBar.tsx`, `Grid.tsx`, `CellView.tsx`, `StatusDot.tsx`, `styles.css`. Maximize cell, Alt+arrows, Ctrl+T/W/Shift+N.

### Task 16: Grid dialog + presets (`GridDialog.tsx`)
5×4 drag picker, merge/unmerge, profile for all/each cell, worktree toggle per cell, presets save/load/delete, link to project.

### Task 17: Snippets panel (`SnippetPanel.tsx`)
Search, add/edit/delete, click/drag/Shift, autoSend; Ctrl+B toggle.

### Task 18: Command palette (`CommandPalette.tsx`)
Ctrl+K; sources: projects, tabs, archive, sessions (current project), snippets, presets, profiles, actions.

### Task 19: History + resume + notifications
History panel (archive + old sessions), resume into active cell/new cell/new tab, restore-on-start spawns with resume, notifications on → waiting when not visible/focused; click focuses cell.

### Task 20: Settings + packaging
`SettingsDialog.tsx` (font size, notifications, shell, profiles editor); electron-builder config (nsis + portable, asarUnpack node-pty); `npm run dist`; manual checklist in `docs/CHECKLIST.md`.
