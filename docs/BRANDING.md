# Unimux branding and compatibility

The product, package, terminal identifier and MCP server are named `unimux`.
The repository and update feed are `daven-team/unimux`. Original supplied artwork
lives in `resources/branding/logo.png` and `resources/branding/banner.png`.
Both README languages use the banner. The renderer and update window use
`resources/icon.png`, the same artwork exported for Electron Builder.

After updating the source logo, run `npm run icons` to regenerate the centered
1024×1024 PNG used by Electron Builder. The export trims the outer black margin
without changing the supplied source artwork. Then run `npm run build` and
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
