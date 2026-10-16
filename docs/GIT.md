# Git panel and repository trust

The **Git** tile in the left rail (enabled for projects that are git repositories) shows the branch with ahead/behind counts, your changes (stage, unstage, commit), the commit history with a thin graph, commit details and read-only diffs, and offers **Fetch**, **Pull** (fast-forward only), **Push** (after a confirmation that names the remote, branch and the URL it resolves to) and switching branches (only with a clean tree). It runs your system `git` without a shell, with timeouts and output limits. There is no discard, no force push, no amend and no way to skip hooks.

The panel needs git 2.26 or newer on your `PATH`.

## Trust model

A git repository can carry its own configuration that makes git start programs: `filter.*.clean/smudge` (run by `status` and `add`), `core.fsmonitor`, hooks, `core.hooksPath`, `core.sshCommand`, `diff.*.textconv`, `remote.*.uploadpack/receivepack`, credential helpers, `include` files and more. Opening a repository you only downloaded must not run any of that, so the panel has a trust model:

- When a project is opened, the panel reads the repository's **local** configuration, `.gitattributes` / `.git/info/attributes` and `.git/hooks` **without running anything** and looks for such keys.
- A repository with none of them just works. A repository with some starts **read-only**: the history, commit details, commit diffs and the branch list work (these were checked to start nothing), while status, changes, diffs of working files, stage, commit, fetch, pull, push and branch switching are disabled and the status is not even requested when the window gets the focus. A banner lists the keys (never their values).
- **Trust this repository** remembers the repository path together with a hash of exactly that configuration (and the hook files) in `git-trust.json` in the app data folder. Any change to the configuration or the hooks asks again. Only this explicit button grants trust; nothing a page of the app sends along with an ordinary request can.
- A trusted repository behaves normally, and the panel says in its confirmations and next to the commit box that its hooks and filters may run.
- Always on, trusted or not: `core.fsmonitor=false`, `--no-textconv`, `--no-ext-diff`, `--no-pager`, `protocol.ext.allow=never`, and no `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` style variables from the environment.
- A project that is a subfolder of a larger repository (for example a repository in your home folder) opens as a **parent repository**: you can read it, but nothing is staged, committed or pushed from the panel.
- Diffs of untracked files only show files git lists as untracked, never through a link, junction or 8.3 alias (`GIT~1`), and credentials found in diffs, commit messages and error texts are masked.
