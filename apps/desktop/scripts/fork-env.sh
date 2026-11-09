# Sourced by local-fork.sh and t3-update.sh (bash). Puts the repo's tools on
# PATH so both scripts work from a bare login shell, a Finder-launched
# terminal, or an agent shell alike: repo-local node_modules/.bin (vp and
# friends, which build scripts spawn by name), node from mise or nvm when the
# shell has not activated one, and cargo for the resource monitor.
#
# Requires: $repo (absolute repo root). Callers check for the tools they need.

fork_env() {
  local dir mise_bin nvm_node
  if ! command -v node >/dev/null 2>&1; then
    mise_bin=$(command -v mise 2>/dev/null || true)
    if [ -z "$mise_bin" ] && [ -x "$HOME/.local/bin/mise" ]; then mise_bin="$HOME/.local/bin/mise"; fi
    if [ -n "$mise_bin" ]; then
      eval "$("$mise_bin" env -s bash -C "$repo")" || true
    fi
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.local/share/mise/shims" ]; then
    PATH="$HOME/.local/share/mise/shims:$PATH"
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
    nvm_node=$(ls -1d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$nvm_node" ]; then PATH="$nvm_node:$PATH"; fi
  fi
  # Repo-local binaries ahead of anything mise or nvm prepended:
  # scripts/build-desktop-artifact.ts spawns `vp` by name.
  PATH="$repo/node_modules/.bin:$PATH"

  # cargo: keg-only Homebrew rustup or rustup's ~/.cargo/bin.
  for dir in /opt/homebrew/opt/rustup/bin "$HOME/.cargo/bin"; do
    if [ -d "$dir" ]; then PATH="$dir:$PATH"; fi
  done
  # git, codesign, ditto and friends live in the system dirs; keep them reachable.
  case ":$PATH:" in *:/usr/bin:*) ;; *) PATH="$PATH:/usr/bin:/bin:/usr/sbin:/sbin" ;; esac
  export PATH
}
