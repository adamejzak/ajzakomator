# Unimux branding and compatibility

The product, package, terminal identifier and MCP server are named `unimux`.
The repository and update feed are `daven-team/unimux`. Original supplied artwork
lives in `resources/branding/logo.png` and `resources/branding/banner.png`.
Both README languages use the banner. The renderer and update window use
the same artwork: `resources/icon-64.png` in the renderer and `resources/icon.png`
in the update window and macOS packages. Windows uses `resources/icon.ico` with
16, 24, 32, 48, 64, 128 and 256 px variants for shortcuts, Explorer and the taskbar.

After updating the square source logo, run `npm run icons` to regenerate all
three exports. The full image, rounded tile, padding and transparency are preserved;
no brightness-based crop or additional CSS mask is applied. Then run `npm run build` and
`node scripts/capture-readme.mjs` to refresh the screenshots from the actual app.

Since 0.9.0 the internal identities use the new name as well, with these
compatibility measures for installations from before the rebranding:

- The Electron application ID (`build.appId`) and the Windows AppUserModelID are
  `com.unimux.app`. Runs from the repository (`npm run dev`, a clone) use
  `com.unimux.app.dev`, so they never share the taskbar entry and icon with the
  installed app; the window also sets its taskbar icon explicitly (`setAppDetails`).
- `build.nsis.guid` is pinned to `214279c4-b798-5d4e-848f-0b9245114cd1`. Electron
  Builder otherwise derives the NSIS GUID from the application ID (UUID v5 of the
  appId); this value is the one derived from the previous ID `com.ajzakomator.app`.
  The GUID names the uninstall and install registry keys (which hold the install
  location) and the installer mutex, so pinning it lets the new installer find and
  replace the existing installation in place instead of installing a second copy.
  Do not change it.
- Updates keep the existing shortcuts, which carry the previous AppUserModelID.
  `resources/installer.nsh` stamps `com.unimux.app` on the Start menu, desktop and
  pinned taskbar shortcuts on every install (an update and a manual reinstall both
  keep the pin), so the window groups with its pin and notifications keep working.
- On macOS the bundle identifier stays `com.ajzakomator.app` (`build.mac.appId`):
  the in-app updater of 0.8.4 and earlier refuses an update whose
  `CFBundleIdentifier` differs from the running app. From 0.9.0 the updater accepts
  both identifiers, so a later release can switch the bundle to `com.unimux.app`
  once installations older than 0.9.0 no longer matter. Switching also resets
  macOS permissions that are stored per bundle identifier (notifications).
- The data directory is `%APPDATA%\unimux` on Windows and
  `~/Library/Application Support/unimux` on macOS. The first start of 0.9.0 or
  later moves the previous `ajzakomator` directory there
  (`src/main/dataDirMigration.ts`) before anything else touches it, and leaves a
  link at the old path (a directory junction on Windows, a symlink on macOS).
  The rename is atomic and nothing is copied or deleted: if it fails (locked files)
  the old directory is used for that run and the move is retried on the next start;
  if only the link fails it is created on a later start. An empty `unimux` directory
  without a state is moved aside as `unimux.pre-migration-<timestamp>`.
  While the update window of the previous version still runs in the old directory,
  the move waits for a later start. A link at the old path that the user made to
  another place (data kept on another drive) stays the data directory and is not
  replaced; only the app's own link, which points to `unimux`, counts as migrated.
- The link keeps every old path working: the update window of 0.8.4 polls
  `%APPDATA%\ajzakomator\update` for the `installer-done` and `ready` markers, the
  macOS update script of 0.8.4 waits for `.../ajzakomator/updates/mac/ready`, and a
  downgraded build still finds its data. The installer writes `installer-done`
  into `$APPDATA\ajzakomator\update` while that path exists (real directory or link)
  and into `$APPDATA\unimux\update` otherwise, so it never creates the new
  directory before the migration.
- `MC_DATA_DIR` overrides the data directory for isolated development and capture;
  no migration runs then. Runs from the repository (`npm run dev`) never move the
  directory either: they use the old one while it is still a real directory.

Previously published release notes keep their historical product names and
asset filenames. Their repository links point to the renamed repository.
The changelog parser and download badge support both product names.
New release notes and packages use `unimux`.

New MCP launches use the `unimux` namespace and `UNIMUX_MCP_TOKEN`. Environment
cleanup also removes the old `AJZ_MCP_TOKEN` from parent sessions. Restart or
resume an existing agent from the app to apply the new MCP launch configuration.
