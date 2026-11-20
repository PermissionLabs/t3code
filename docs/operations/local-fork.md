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

## Build a shared server release

There are two ways to prepare a change for `custom/local`. For an upstream release, run
`bash scripts/fork-prepare-upstream.sh --publish` in a fork checkout synced with `pl-sync t3code`.
It checks the fork head with the Reader and merges the latest official stable tag into a
separate candidate worktree. A clean candidate is pushed with `brokerctl push-agent` and opened
as a PR to `custom/local` with `brokerctl open-pr`. A conflict stops in that worktree (exit 2);
resolve it there, validate, then push and open the PR the same way. A release that changes
`.github/workflows` stops before pushing, because the broker refuses workflow changes; hand
that branch to the MacBook path. For a fork-only change, open the usual agent PR.

Either PR merges after a passkey approval in the broker approver, which merges through the
GitHub pull request API so branch rules apply. Then sync the fork and check out the **exact
remote `custom/local` SHA** in a clean Apple Silicon build worktree. Select the Node version in
the root package manifest. The builder also needs Corepack, Rust/Cargo, `jq`, and the approved
`pl-gh-read`.

```sh
bash scripts/fork-build-release.sh "$MERGED_SHA" "$ARTIFACT_DIRECTORY" 0.1.8
```

Use an absolute output directory. The optional third argument is a minimum version base for
machines already running a fork whose version is ahead of the source manifest. The version
comes from the commit time and full SHA, so rerunning the build for the same commit verifies
and reuses the existing directory instead of producing a second release. The builder uses the
repository's CLI archive builder, then tests that the packaged service launcher starts a
server in a temporary T3 home. The output version directory contains the archive,
`SHA256SUMS`, and a manifest recording the fork SHA and official tag. Keep each published
version directory immutable.

For an exact-version update, the server's `T3CODE_RELEASE_BASE_URL` must point at an approved
HTTPS repository serving those directories at `v<version>/`. Verify download access from
each service account before requesting an update. Keep the per-machine Reader path in service
configuration.

## Roll out to the machines

The first build with rollout support is installed on each machine by hand. After that, open
**Settings → About → Fork server rollout** on mini-1, paste the exact published version, and
select mini-1, mini-2, and the MacBook in that order. mini-1 drives the rollout through its
linked environments (**Settings → Connections**), so mini-2 and the MacBook must be linked to
mini-1 and reachable. The rollout state lives in `fork-rollout.json` under mini-1's T3 home,
so it continues after the page closes and resumes after mini-1 restarts into the new version.

Each server stages and checks the archive, waits until it has no active turn, pending request,
running tool, background task, or terminal, then briefly refuses new turns and terminals while
it re-checks and hands off to its service launcher. The launcher backs up the database, starts
the new version as a trial, and returns to the previous version and database if the trial
fails. A step finishes when that server reports the requested version; a failed or rolled-back
step stops the rollout before the next machine. **Stop rollout** cancels a step that is still
waiting for idle. The custom desktop app uses the separately signed desktop build.
