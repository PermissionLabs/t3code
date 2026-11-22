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

## Update the desktop app

`custom/local` changes only through broker PRs (next section), so a desktop checkout never merges
or pushes on its own. The installed **T3 Code (Custom)** app updates in two steps:

```sh
./apps/desktop/scripts/t3-update.sh             # fast-forward to origin/custom/local, check, build, package, sign
# quit the app with Cmd-Q, then:
./apps/desktop/scripts/t3-update.sh --install   # back up userdata, replace the app, keep the old one as .prev
```

The first step writes only to the checkout and `release/custom`, so the installed app keeps
running and an agent inside it can run it. Run it on the same `custom/local` commit the servers
were built from. Only a `local-fork.sh start` dev run holds the checkout's lock; quit that one
first. The first step stops when the checkout is dirty, not on `custom/local`, or has commits
that `origin/custom/local` lacks, and when checks or the build fail. Signing may ask for keychain
access to the Apple Development identity the first time.

`--install` needs the app quit because it replaces the bundle. If the new app misbehaves, quit
it and run `t3-update.sh --rollback` to put `.prev` back. Code and data roll back separately: an
older build may not understand a migrated database, so restore the matching
`~/.t3-custom-backups/<time>-userdata.tgz` only with the app quit, after preserving the current
data. Backups may contain secrets and stay local; remove old ones when no longer needed.

For a dev run, `./apps/desktop/scripts/local-fork.sh update` does the same fast-forward, check,
and build without packaging; then use `local-fork.sh start`. `local-fork.sh status` reports the
checkout, last built commit, and the stable release it is based on. Each update also leaves a
`backup/local-<time>` branch named in `.git/local-fork-backup`.

## Build a shared server release

There are two ways to prepare a change for `custom/local`. For an upstream release, run
`bash scripts/fork-prepare-upstream.sh --publish` in a fork checkout synced with `pl-sync t3code`.
It checks the fork head with the Reader and merges the latest official stable tag into a
separate candidate worktree. A clean candidate is pushed with `brokerctl push-agent` and opened
as a PR to `custom/local` with `brokerctl open-pr`. A conflict stops in that worktree (exit 2);
resolve it there, validate, then push and open the PR the same way. A release that changes
`.github/workflows` stops before pushing, because the broker refuses workflow changes; hand
that branch to the MacBook path. For a fork-only change, open the usual agent PR.

Either PR merges after a passkey approval in the broker approver. The approval names the PR
head and the current `custom/local` commit, and the broker updates `custom/local` only while it
still points at that commit, so a branch that moved after approval is left unchanged. Then sync the fork and check out the **exact
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

The first build with rollout support is installed on each mini by hand. After that, open
**Settings → About → Fork server rollout** on mini-1, paste the exact published version, and
select mini-1 and mini-2 in that order. The MacBook runs the desktop app, whose server belongs
to the app and refuses remote updates; update it with `t3-update.sh` on the same commit (see
[Update the desktop app](#update-the-desktop-app)). mini-1 drives the rollout through its
linked environments (**Settings → Connections**). Link mini-2 to mini-1 with
**Full access**: each server accepts update requests only from a full-access link. The rollout
state lives in `fork-rollout.json` under mini-1's T3 home, so it continues after the page
closes and resumes once mini-1 is back on the new version and its launcher has committed it.

Each server stages and checks the archive, waits until it has no active turn, pending request,
running tool, background task, or terminal, then briefly refuses new turns and terminals while
it re-checks and hands off to its service launcher. The launcher backs up the database, starts
the new version as a trial, and returns to the previous version and database if the trial
fails. A step finishes when that server reports the requested version; a failed or rolled-back
step stops the rollout before the next machine. **Stop rollout** cancels a step that is still
waiting for idle; when that server cannot be reached, the step says so, because it may still
restart once idle. The custom desktop app uses the separately signed desktop build.
