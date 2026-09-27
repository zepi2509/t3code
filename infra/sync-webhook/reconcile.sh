#!/usr/bin/env bash
set -euo pipefail

run_id="${1:?run id required}"
base="${2:?fork SHA required}"
upstream="${3:?upstream SHA required}"
if [[ ! "$run_id" =~ ^[1-9][0-9]*$ || ! "$base" =~ ^[0-9a-f]{40}$ || ! "$upstream" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Invalid sync reference.' >&2
  exit 2
fi
work="/data/jobs/${run_id}-worktree"
trap 'rm -rf -- "$work"' EXIT
export GIT_EDITOR=true GIT_TERMINAL_PROMPT=0

rm -rf -- "$work"
git clone --quiet --filter=blob:none --branch main --single-branch \
  https://github.com/zepi2509/t3code.git "$work"
cd "$work"
if [[ "$(git rev-parse HEAD)" != "$base" ]]; then
  echo "Fork moved since the failing run; skipping stale notification."
  exit 20
fi
git config user.name 'Pi sync assistant'
git config user.email 'pi-sync@users.noreply.github.com'
git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch --quiet upstream main
if [[ "$(git rev-parse upstream/main)" != "$upstream" ]]; then
  echo "Upstream moved since the failing run; waiting for a fresh notification."
  exit 20
fi

if bash .github/scripts/rebase-upstream.sh upstream/main; then
  echo 'Rebase no longer conflicts; no Pi run needed.'
else
  if [[ -z "$(git diff --name-only --diff-filter=U)" ]]; then
    echo 'Rebase failed without source conflicts; Pi was not started.' >&2
    exit 1
  fi

  conflicts="$(git diff --name-only --diff-filter=U)"
  echo "Unresolved files: $conflicts"
  # The container has no GitHub write credentials; Pi may only prepare a local result.
  timeout -k 10s 25m pi -p --no-session --no-approve \
    --no-extensions --no-skills --no-prompt-templates --no-context-files \
    --provider openai-codex --model "${SYNC_PI_MODEL:-gpt-6-sol}" --thinking xhigh \
    --tools read,bash,edit,write,grep,find,ls \
    "Complete the interrupted rebase of the Pi fork onto upstream/main. Conflicts: $conflicts. Inspect upstream's new design and the surrounding callers and tests. Adapt the fork's Pi changes to upstream's current logic and types instead of restoring obsolete fork code. Preserve both upstream functionality and the fork's Pi behavior; use the smallest integration that follows upstream conventions. Resolve conflicts deliberately, continue the rebase through all commits, and run focused checks for changed behavior when feasible. Do not blanket choose ours/theirs, skip or abort commits, push, or access credentials. Report any unresolved conflicts or checks you could not run; never claim completion if the rebase is incomplete."
fi

test -z "$(git diff --name-only --diff-filter=U)"
test ! -d .git/rebase-merge
test ! -d .git/rebase-apply
git merge-base --is-ancestor upstream/main HEAD
test "$(git rev-list --count --merges upstream/main..HEAD)" -eq 0
test -z "$(git status --porcelain)"
git diff --check
git bundle create "/data/jobs/${run_id}.bundle" upstream/main..main
printf 'Prepared a linear rebased bundle at /data/jobs/%s.bundle for GitHub validation.\n' "$run_id"
