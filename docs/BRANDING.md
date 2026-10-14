# Unimux branding and compatibility

The product, package, terminal identifier and MCP server are named `unimux`.
The repository and update feed are `daven-team/unimux`. The SVG mark in
`resources/logo.svg`, the renderer mark and the update window use the same
terminal prompt inside a U-shaped workspace.

After changing the vector mark, run `npm run icons` to regenerate the 1024×1024
PNG used by Electron Builder. Then run `npm run build` and
`node scripts/capture-readme.mjs` to refresh the screenshots from the actual app.

Two internal identities intentionally retain the previous name:

- `com.ajzakomator.app` remains the Electron application ID and Windows
  AppUserModelID. Electron Builder derives the NSIS installation identity from
  it, so keeping it allows existing installations to update in place.
- The application keeps `%APPDATA%\ajzakomator` on Windows and
  `~/Library/Application Support/ajzakomator` on macOS. This preserves projects,
  session history, editor drafts, saved accounts and update handoff files.
  `MC_DATA_DIR` still overrides this path for isolated development and capture.

Previously published release notes keep their historical product names and
asset filenames. Their repository links point to the renamed repository.
The changelog parser and download badge support both product names.
New release notes and packages use `unimux`.

New MCP launches use the `unimux` namespace and `UNIMUX_MCP_TOKEN`. Environment
cleanup also removes the old `AJZ_MCP_TOKEN` from parent sessions. Restart or
resume an existing agent from the app to apply the new MCP launch configuration.
