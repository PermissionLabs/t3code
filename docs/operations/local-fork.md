# Personal T3 Code fork

This branch keeps a persistent quota footer and an isolated local desktop runtime on top of upstream T3 Code. Upstream contribution acceptance is independent of using this fork.

## Run on macOS

Prerequisites: Git, Bun, Xcode Command Line Tools, and the provider CLIs you use. `vp` installs the Node and package-manager versions pinned by this repository. Authenticate Codex and Claude locally; credentials are never part of the fork.

```sh
git clone https://github.com/bamnenim-permissionlabs/t3code.git
cd t3code
git remote add upstream https://github.com/pingdotgg/t3code.git
git remote set-url --push upstream DISABLED
git fetch upstream --tags
git switch custom/local
./apps/desktop/scripts/local-fork.sh build
./apps/desktop/scripts/local-fork.sh start
```

The first build installs dependencies, runs changed-file checks, and builds the desktop and server/web bundles. Normal launches use these built files without a Vite server or build watchers. Keep the launcher running; quit the application with Cmd-Q before maintenance.

Use `apps/desktop/scripts/local-fork.sh start`, not the generated internal Electron bundle directly: the launcher supplies the data directory and disables official binary updates.

The macOS bundle is labeled **T3 Code (Custom)**, uses `com.bamnenim.t3code.custom`, and does not register the official URL scheme. Some inherited menu labels still say Beta. This source build is not a signed, notarized distribution; native passkeys and official deep-link/T3 Connect flows are not validated here.

## Data and isolation

- Custom server state: `~/.t3-custom/userdata`.
- Custom Electron profile: below `~/.t3-custom/electron`.
- Official `~/.t3` and the official Electron profile are not used by this launcher.
- The old temporary Dev preview is a separate environment. Its conversations have not been migrated.
- GitHub contains source only. Runtime state, provider credentials, logs, dependencies, and generated bundles are not committed.

## Update while keeping customization

Quit Custom, commit any intentional source edits on `custom/local`, then run:

```sh
./apps/desktop/scripts/local-fork.sh update
./apps/desktop/scripts/local-fork.sh start
```

`update` fetches the latest official **stable release** (a plain `vX.Y.Z` tag, never nightly or preview), fast-forwards from the fork's `custom/local`, creates a local `backup/local-<timestamp>` branch and (when present) a private local data archive in `~/.t3-custom-backups`, merges that release, installs locked dependencies, runs changed-file checks, builds, and pushes only `custom/local` to the fork. This keeps the fork on the same release train as stable servers on other machines. To move to a newer release, wait for the next stable tag. This is an explicit update command, not an unattended schedule.

The app and update/build command share a lock. Dirty worktrees, merge conflicts, or failed checks/builds stop the process. A build marker prevents launching a revision whose build failed. No force-push or automatic conflict resolution is used. Local merge commits are unsigned so updates do not require personal signing-key access.

If a merge conflicts, resolve it and commit, then run `./apps/desktop/scripts/local-fork.sh build` and `git push origin custom/local`. To abandon an unfinished merge, run `git merge --abort`, then build again.

If a completed update is unsuitable, inspect the recovery branch named in `.git/local-fork-backup`. Preserve any new edits and ask an agent to recover onto a new branch; do not blindly reset the shared custom branch. Code rollback and database rollback are separate: an older build may not understand a migrated database. Restore the matching data archive only with the app stopped, after preserving the current data. Backups may contain secrets and stay local; review disk usage and remove old backups when no longer needed.

`./apps/desktop/scripts/local-fork.sh status` reports the checkout, last built commit, and the stable release it is based on. Future modifications should stay on small branches based on `custom/local` and merge back after verification. Keep changes narrowly scoped to reduce upstream conflicts. If the official product eventually covers the same need, remove the redundant local patch.
