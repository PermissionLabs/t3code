# Fork server runtime (headless macOS T3 service)

Used on mini-1 (2026-11-10) to replace the official headless `t3 serve` service with a build of this fork.
Copy this folder to `~/permissionlabs/t3-fork-build/` and keep `tools/env.sh` there.

- `env.sh` → `~/permissionlabs/t3-fork-build/tools/env.sh` (user-space node 26, vp, pnpm)
- `build.sh [worktree]` → `~/permissionlabs/t3-fork-build/<sha>/runtime`
- `swap.sh [--dry-run] [--block-updates] | --rollback` — run by a person from a normal terminal (restarts the service)
- `public-config.env` (mode 600, not in git): public relay/Clerk config copied from the official binary so the cloud relay keeps working.
