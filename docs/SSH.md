# SSH connections

The **SSH** tile in the left rail is a small SSH client inside the terminal grid. It uses the built-in `ssh2` library (no `ssh` program is needed) and runs every session in the Pty Host, next to the local terminals.

- **Hosts.** Save hosts with a label, address, port, user, group and tags; search them, fold groups, duplicate or delete them. Click a host to connect in the active grid, or open it in a new tab. A group (or several hosts selected with Ctrl/Cmd+click) opens as a grid with one session per host. The grid dialog and presets can hold SSH cells too.
- **Keys.** Generate Ed25519, ECDSA (256, 384, 521) or RSA (3072, 4096, 2048) keys, or add one from a file (picker or drag and drop) or as pasted text: OpenSSH keys, PEM RSA and EC keys and PuTTY PPK v2 RSA keys. PuTTY PPK v3 keys must be saved as OpenSSH in PuTTYgen first. Copy the public key for `authorized_keys`; the private key can only be saved to a file you choose. Certificates can be stored but are not used to sign in yet. ML-DSA and other post-quantum keys are not offered: there is no standard SSH signature for them and servers do not accept them.
- **Signing in.** Public key, saved password, password prompt and keyboard-interactive (one-time codes). A passphrase you type can be remembered until the app quits, so a grid of cells on one key asks once.
- **Host keys.** The first connection shows the server's fingerprint and asks whether to trust it; a changed key shows a red warning and connects only after you confirm the replacement. Trusted keys are listed in **Settings > SSH > Known hosts**.
- **Startup command** per host: typed into the shell after login, line by line as if you typed it.
- **Send to all.** One command for the checked SSH sessions of the current grid (panel button, palette, grid tab menu).
- **No restore, no reconnect.** Sessions are not restored after a restart of the app; the cells show a **Connect** card. There is no automatic reconnect.

## Where secrets live

Hosts are stored in `state.json` without secrets. Keys and saved passwords are stored in `ssh/vault.json` in the app data folder, encrypted with Windows DPAPI or the macOS Keychain (`safeStorage`). When the system encryption is unavailable they are kept in memory only until the app quits and nothing secret is written. Trusted host keys are in `ssh/known_hosts.json`.

The app never reads `~/.ssh` by itself. On macOS the Keychain may ask again for access to "unimux Safe Storage" after an update.

The main process handles host keys, keys and passwords and passes secrets to the Pty Host in memory only.

## Not supported yet

Agent forwarding and ssh-agent/Pageant, jump hosts and proxies, port forwarding, SFTP, mosh, per-host environment variables, importing `~/.ssh/config` or `known_hosts`.
