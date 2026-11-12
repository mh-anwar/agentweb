#!/usr/bin/env bash
# Install the newest green commit of the release branch for every agent on this machine.
#
# Agents point their MCP config at $AGENTWEB_HOME/current/dist/agentweb.mjs. This builds the branch tip in a clean
# copy, runs the test suite and, only if it passes, moves `current` to the new build in one rename. A red commit
# never ships: it's recorded in failed/ and skipped until the branch moves again. Agents already running keep the
# build they started with; new sessions get the new one. Rollback: point `current` at an older releases/<sha>.
#
# Run by the repo's post-commit / post-merge hooks (scripts/install-release-hooks.sh); safe to run by hand.
#   AGENTWEB_RELEASE_BRANCH  default build/agentweb-v0
#   AGENTWEB_HOME            default ~/.local/share/agentweb
#   AGENTWEB_KEEP            releases kept, default 5
set -uo pipefail

REPO=$(git -C "$(dirname "$(readlink -f "$0")")" rev-parse --path-format=absolute --git-common-dir)
REPO=$(dirname "$REPO")
BRANCH=${AGENTWEB_RELEASE_BRANCH:-build/agentweb-v0}
HOME_DIR=${AGENTWEB_HOME:-$HOME/.local/share/agentweb}
KEEP=${AGENTWEB_KEEP:-5}
mkdir -p "$HOME_DIR"/{releases,failed,build}
LOG="$HOME_DIR/release.log"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$LOG"; }

# one release at a time; a commit landing meanwhile is picked up by the loop below
exec 9>"$HOME_DIR/.lock"
if ! flock -n 9; then
  touch "$HOME_DIR/.again"
  exit 0
fi

release() {
  local sha work lock_hash
  sha=$(git -C "$REPO" rev-parse --verify -q "$BRANCH^{commit}") || { log "no branch $BRANCH"; return 1; }
  [ "$(readlink "$HOME_DIR/current" 2>/dev/null)" = "releases/$sha" ] && return 0
  [ -e "$HOME_DIR/failed/$sha" ] && return 0
  log "building $BRANCH $sha"
  work="$HOME_DIR/build/$sha"
  rm -rf "$work" && mkdir -p "$work"
  git -C "$REPO" archive "$sha" | tar -x -C "$work" || { log "archive failed"; return 1; }

  # dependencies: hard links to the main checkout's when the lockfile matches (no disk, no network), else npm ci
  lock_hash=$(sha256sum "$work/package-lock.json" | cut -c1-16)
  if [ -d "$REPO/node_modules" ] && [ "$(sha256sum "$REPO/package-lock.json" | cut -c1-16)" = "$lock_hash" ]; then
    cp -al "$REPO/node_modules" "$work/node_modules" 2>/dev/null || { rm -rf "$work/node_modules"; cp -a "$REPO/node_modules" "$work/node_modules"; }
  else
    (cd "$work" && npm ci --no-audit --no-fund >>"$LOG" 2>&1) || { log "npm ci failed: $sha"; fail "$sha" "$work"; return 1; }
  fi

  # the copy has no .git: the build is told its commit, so `agentweb --version` can say which build is installed
  (cd "$work" && AGENTWEB_COMMIT="${sha:0:7}" nice -n 10 npm run build >>"$LOG" 2>&1) || { log "build failed: $sha"; fail "$sha" "$work"; return 1; }
  if ! (cd "$work" && nice -n 10 npm test >"$work/test.log" 2>&1); then
    # timing tests can lose to a busy machine: re-run only the files that failed, once
    mapfile -t again < <(sed -n '/^✖ failing tests:/,$p' "$work/test.log" | grep -oE '[^ ]+/test/[^ ]+\.test\.ts' | sort -u)
    if [ "${#again[@]}" -eq 0 ] || ! (cd "$work" && nice -n 10 node --test "${again[@]}" >>"$work/test.log" 2>&1); then
      log "tests failed: $sha ($(grep -cE '^✖' "$work/test.log") failing lines)"
      cp "$work/test.log" "$HOME_DIR/failed/$sha.log"
      fail "$sha" "$work"
      return 1
    fi
    log "flaky test files passed on retry: ${again[*]##*/}"
  fi
  node "$work/dist/agentweb.mjs" --version >/dev/null 2>&1 || { log "built file does not start: $sha"; fail "$sha" "$work"; return 1; }

  rm -rf "$HOME_DIR/releases/$sha"
  mv "$work" "$HOME_DIR/releases/$sha"
  ln -sfn "releases/$sha" "$HOME_DIR/current.new" && mv -T "$HOME_DIR/current.new" "$HOME_DIR/current"
  log "released $sha: $(git -C "$REPO" log -1 --format=%s "$sha")"

  # keep the newest $KEEP releases (and whatever `current` is)
  ls -1t "$HOME_DIR/releases" | tail -n +"$((KEEP + 1))" | while read -r old; do
    [ "$old" = "$sha" ] || rm -rf "${HOME_DIR:?}/releases/$old"
  done
  find "$HOME_DIR/failed" -mtime +14 -delete 2>/dev/null
}

fail() {
  touch "$HOME_DIR/failed/$1"
  rm -rf "$2"
}

while :; do
  rm -f "$HOME_DIR/.again"
  release
  [ -e "$HOME_DIR/.again" ] || break
done
