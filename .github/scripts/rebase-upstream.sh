#!/usr/bin/env bash
set -euo pipefail
export GIT_EDITOR=true

if git rebase "${1:?upstream ref required}"; then
  exit 0
fi

# Only the generated lockfile is safe to discard; source conflicts need a human.
while true; do
  mapfile -t conflicts < <(git diff --name-only --diff-filter=U)
  if [[ ${#conflicts[@]} != 1 || ${conflicts[0]} != pnpm-lock.yaml ]]; then
    echo 'Rebase stopped on a non-lockfile conflict; refusing to publish.' >&2
    exit 1
  fi
  git checkout --ours pnpm-lock.yaml
  git add pnpm-lock.yaml
  if git diff --cached --quiet; then
    continuation=--skip
  else
    continuation=--continue
  fi
  if git rebase "$continuation"; then
    break
  fi
done

# The caller must regenerate and validate the lockfile before pushing.
