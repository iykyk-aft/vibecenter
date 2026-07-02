#!/usr/bin/env bash
# Auto-sync this repo with origin so work is never lost between Claude Code
# sessions or computers. Wired to Claude Code hooks in .claude/settings.json:
#   SessionStart -> `git-autosync.sh pull`   (grab other computers' work)
#   Stop         -> `git-autosync.sh push`   (commit + publish this turn's work)
#
# Portable: derives the repo from its own location, so it works on any machine
# regardless of where the checkout lives. Always exits 0 — a sync hiccup must
# never block or fail the editing session.
set -uo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" 2>/dev/null || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0
git remote get-url origin >/dev/null 2>&1 || exit 0
BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)" || exit 0
[ -n "$BRANCH" ] || exit 0

# Pull remote work without losing local edits; on conflict, back out cleanly
# and leave it for a human rather than wedging a half-finished rebase.
sync_down() {
  if ! git pull --rebase --autostash origin "$BRANCH" >/dev/null 2>&1; then
    git rebase --abort >/dev/null 2>&1 || true
  fi
}

case "${1:-}" in
  pull)
    sync_down
    ;;
  push)
    if [ -n "$(git status --porcelain)" ]; then
      git add -A
      git commit -q -m "auto-sync: $(date '+%Y-%m-%d %H:%M:%S')" >/dev/null 2>&1 || true
    fi
    sync_down
    git push origin "$BRANCH" >/dev/null 2>&1 || true
    ;;
  *)
    echo "usage: git-autosync.sh pull|push" >&2
    ;;
esac
exit 0
