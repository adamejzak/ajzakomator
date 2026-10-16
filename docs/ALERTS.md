# Status, alerts and AI accounts

## Status

Every cell, tab and project shows a live status: ◐ working, ● waiting for you.

A turn that ends with a limit or an error is shown in red instead of "waiting for you": **limit reached** for a rate limit (Claude) or "You've hit your usage limit" (Codex), **error** for any other failure.

## Alerts

Claude and Codex cells raise a desktop notification and a sound for three events:

- **finished**: the agent ended its turn,
- **needs you**: a permission prompt or a question,
- **error**: the turn ended with an API error such as a rate limit, shown with a readable reason.

Click a notification to jump to the cell.

**Settings → Notifications and sounds** gives each event its own notification switch and sound: one of eight built-in synthesized presets (the default is a soft ding-dong), the system sound, your own file (wav, mp3, ogg, m4a, aac or flac, up to 5 MB) or off. There is also a volume slider, quiet hours (they may wrap past midnight) and a test button per event that plays exactly what would play.

Rules:

- Desktop notifications are always silent: the app plays the sound you chose, so you never hear a double ding.
- Alerts stay silent while you look at the cell in the active window, and never fire for restored sessions or a cell that merely went quiet.
- One alert per turn: minimizing and restoring the window, switching tabs or waking the computer never makes an agent that already reported alert again.
- **Mute alerts of this cell** in the cell menu silences one cell (its status is still shown).
- The saved alert settings take precedence over the notification and sound settings of earlier versions, which are only read when no alert settings exist yet.

## How Codex reports a turn

Codex cells are launched with a per-process `notify` hook (never written to your `config.toml`): when a turn completes, Codex calls `curl` against the app's local hook server. That gives an exact end of turn and the exact conversation id, so several Codex cells in one folder each resume their own conversation after a restart. It replaces a `notify` program you may have configured, for these cells only. If the hook never reports (an old Codex), the cell falls back to the activity heuristic.

A notify only starts a turn end: it counts once the cell has been quiet for about 2.5 s, so a sub-agent finishing mid-turn never raises a false "finished" alert or binds the wrong conversation. The conversation is stored after its first committed turn end and confirmed after the second.

The hook address (a per-run token plus a per-start nonce) is part of the launch command typed into the cell's shell, so it can appear in that shell's history. It only lets a local process fake status events of a cell and is useless after the app quits.

## AI account limits

The **AI account limits** panel shows the 5-hour and weekly limits of your main Claude account, extra saved Claude accounts and Codex.

From a saved account's "⋮" menu, **Make main account** swaps it with the main Claude login. The previous main account stays saved, and open Claude sessions normally pick up the new login on their next message without being closed (this depends on the Claude Code version; a session that does not can be restarted or resumed). The selected account's token is refreshed with Anthropic first, and the sign-in files are exchanged on your computer.

If a swap is interrupted, the app keeps an emergency copy, blocks further swaps and asks you to check both accounts. After you clear the warning, sign in again to any account that stopped working (a Claude sign-in is always possible again).

Known limit: if a Claude session writes its login in the very same millisecond as the swap, the app detects most such cases and asks you to check your accounts, but it cannot detect all of them. Keep your own backup of your Claude login.

Not available on macOS, where Claude keeps its login in the Keychain (saved accounts cannot be added there either).
