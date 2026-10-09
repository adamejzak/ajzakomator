# README screenshots

The PNGs in this folder come from the real Electron application in English. The capture script creates a temporary **Atlas storefront** project, three project entries, reusable snippets and a review-team preset. Four real shell terminals run JavaScript tests, display the demo catalog and inspect its source. No AI models are invoked and no installed app data is loaded.

From the repository root, with Node.js 22 or newer and dependencies installed:

```sh
npm run build
node scripts/capture-readme.mjs
```

An Electron desktop environment is required. The script uses `MC_DATA_DIR` for isolated state, `MC_OFFSCREEN=1` to keep its window away from the desktop, and a dynamically allocated `MC_DEBUG_PORT` to control and capture the renderer over CDP. It does not modify source files or an installed app's settings. The four shell cells use cmd on Windows and bash on macOS.

| Image | View |
| --- | --- |
| `main.png` | Projects, a 2×2 terminal grid, real demo output and snippets |
| `editor.png` | File tree and integrated source editor |
| `grid-dialog.png` | Review-team preset with profiles, roles and startup prompts |
| `palette.png` | Command palette with projects, snippets and actions |

To review a capture before replacing the tracked images, pass an output directory:

```sh
node scripts/capture-readme.mjs ./capture-review
```

The script logs its temporary demo directory and closes its own Electron instance when finished. Temporary data is kept for inspection. CDP sets the actual renderer viewport to 1600×1000; platform fonts and test timings may vary. Do not run while another process is rebuilding `out/`. Inspect all four images before committing them.

The app may display the project folder path. If your system temp path includes your personal name, set `MC_CAPTURE_ROOT` to a generic, writable directory before capturing. For example, in PowerShell:

```powershell
$env:MC_CAPTURE_ROOT = 'D:\Temp\ajzakomator-demo'
node scripts/capture-readme.mjs
```
