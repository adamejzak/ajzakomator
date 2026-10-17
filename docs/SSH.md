# SSH connections

The **SSH** tile in the left rail opens the **SSH view** as a tab in the main area, next to your grids. It is a small SSH client built into the grid: it uses the built-in `ssh2` library (no `ssh` program is needed) and runs every session in the Pty Host, next to the local terminals.

- **SSH mode.** While the SSH view is in front, the left side panel shows the SSH sections instead of Projects, Files and Git: **Hosts**, **Keys**, **Known hosts** and a greyed **SFTP** entry (coming soon). The Projects, Files or Git tile, or a grid or file tab, brings the normal side panel back; the SSH tile folds and unfolds the side panel, and with the side panel folded the view shows the sections as a row at the top.
- **Hosts.** Search, **New host**, **New key** and **Send to all** at the top, then a **Groups** row (click a group to show only its hosts; its menu has **Open as grid**), the hosts as tiles by group (label, user@host and a dot that shows whether a session to it is connected) and the local shells. Click a host to see and edit it in the details pane on the right; double-click or **Connect** opens it in the active grid, **Open in a new grid** in a new tab. Ctrl/Cmd+click selects several hosts and **Open as grid** opens them as one SSH-only grid; every group has its own **Open as grid** button.
- **Keys.** Key tiles (label, type, fingerprint); **New key** generates one or adds one from a file or pasted text, and a click on a tile opens the key in the details pane (label, public key, passphrase, export, delete).
- **Known hosts.** The trusted host keys (host, key type, fingerprint, date) with **Remove**; the same list as in **Settings > SSH**.
- **SSH cells in any grid.** The **Add** menu above the grid and a cell's menu list your hosts like profiles: pick one to add an SSH cell to the current grid. The grid dialog and presets can hold SSH cells too.
- **Saved hosts.** Save hosts with a label, address, port, user, group and tags; search them, fold groups, duplicate or delete them.
- **Key types.** Generate Ed25519, ECDSA (256, 384, 521) or RSA (3072, 4096, 2048) keys, or add one from a file (picker or drag and drop) or as pasted text: OpenSSH keys, PEM RSA and EC keys and PuTTY PPK v2 RSA keys. PuTTY PPK v3 keys must be saved as OpenSSH in PuTTYgen first. Copy the public key for `authorized_keys`; the private key can only be saved to a file you choose. Certificates can be stored but are not used to sign in yet. ML-DSA and other post-quantum keys are not offered: there is no standard SSH signature for them and servers do not accept them.
- **Signing in.** Public key, saved password, password prompt and keyboard-interactive (one-time codes). A passphrase you type can be remembered until the app quits, so a grid of cells on one key asks once.
- **Host keys.** The first connection shows the server's fingerprint and asks whether to trust it; a changed key shows a red warning and connects only after you confirm the replacement. Trusted keys are listed in **Known hosts** of the SSH view and in **Settings > SSH**.
- **Startup command** per host: typed into the shell after login, line by line as if you typed it.
- **Send to all.** One command for the checked SSH sessions of the current grid (SSH view button, palette, grid tab menu).
- **No restore, no reconnect.** Sessions are not restored after a restart of the app; the cells show a **Connect** card. There is no automatic reconnect.

## Where secrets live

Hosts are stored in `state.json` without secrets. Keys and saved passwords are stored in `ssh/vault.json` in the app data folder, encrypted with Windows DPAPI or the macOS Keychain (`safeStorage`). When the system encryption is unavailable they are kept in memory only until the app quits and nothing secret is written. Trusted host keys are in `ssh/known_hosts.json`.

The app never reads `~/.ssh` by itself. On macOS the Keychain may ask again for access to "unimux Safe Storage" after an update.

The main process handles host keys, keys and passwords and passes secrets to the Pty Host in memory only.

## Not supported yet

Agent forwarding and ssh-agent/Pageant, jump hosts and proxies, port forwarding, SFTP, mosh, per-host environment variables, importing `~/.ssh/config` or `known_hosts`.
