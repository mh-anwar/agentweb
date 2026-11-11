#!/usr/bin/env bash
# Make every commit or merge on the release branch (in any worktree of this repo) start scripts/release-local.sh
# in the background. Run once per machine. Hooks are per clone and never committed.
set -euo pipefail
common=$(git rev-parse --path-format=absolute --git-common-dir)
branch=${AGENTWEB_RELEASE_BRANCH:-build/agentweb-v0}
for h in post-commit post-merge post-rewrite; do
  f="$common/hooks/$h"
  if [ -e "$f" ] && ! grep -q 'agentweb-release' "$f"; then
    echo "skip $h: a hook is already there ($f); add the line from $0 to it by hand" >&2
    continue
  fi
  cat >"$f" <<EOF
#!/bin/sh
# agentweb-release: a new commit on $branch goes out to this machine's agents once its tests pass
[ "\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "$branch" ] || exit 0
top=\$(git rev-parse --show-toplevel)
[ -x "\$top/scripts/release-local.sh" ] || exit 0
setsid "\$top/scripts/release-local.sh" </dev/null >/dev/null 2>&1 &
exit 0
EOF
  chmod +x "$f"
  echo "installed $h"
done
