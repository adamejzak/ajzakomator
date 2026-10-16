# Updating

An update is never installed without your click. Development builds do not install updates.

To check manually, right-click the **unimux** name/version and choose **Check for updates**. If checking or downloading fails, the header offers a retry and shows the error.

Save your editor changes before an update; agent conversations are restored through their CLI resume support.

## Modes

**Settings → Updates** has two modes:

- **Manual** (the default): nothing happens at start. The app downloads updates in the background; the status bar shows **Version … available - Update** and, once it is downloaded, **Version … ready - Install**. Clicking either opens the update window, which finishes the download if needed, installs and starts the new version.
- **Automatic**: at start the app shows a short "Checking for updates" window only if the check is slow. When a new version exists it asks "Install now" or "Later" and starts downloading in the background while you decide, so "Install now" goes straight to the installer. "Later", the close button and Escape start the current version, and the status bar button installs the update afterwards.

If a newer release appears before the installer starts, the window follows the newest one; once the installer has started, that version finishes and the newer one is offered after the relaunch. With no update, no network or any error the app simply starts.

## Windows

The installed Windows app checks GitHub Releases through electron-updater.

## macOS

Squirrel.Mac (electron-updater) refuses updates that are only ad-hoc signed, so the macOS app has its own updater with the same two modes.

1. It reads `latest-mac.yml` from the latest GitHub release and downloads the `.zip` for your processor (Apple Silicon or Intel) into `~/Library/Application Support/unimux/updates/mac`.
2. It checks the size and SHA-512, unpacks the archive with `ditto` and verifies the bundle (version, bundle identifier, executable and `codesign --verify`).
3. After you click install, a small script waits until the app has quit, moves the old app aside, puts the new one in its place (restoring the old one if anything fails), removes the quarantine flag and starts the new version.

The log is `updates/mac/update.log`.

The app only replaces itself when it runs from a normal, writable `.app` that belongs to you (for example in **Applications**). From the mounted DMG, a translocated (quarantined) copy, a read-only or administrator-owned location, or when macOS denies the **App Management** permission, the status bar offers the download page instead and the tooltip says why.

The first update to a macOS version that contains this updater is still manual (older versions cannot do it), and the updater has not yet been validated on a real Mac.
