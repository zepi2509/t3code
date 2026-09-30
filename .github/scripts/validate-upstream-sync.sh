#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_SHA:?original fork commit required}"
script="$(realpath "$0")"
helper="$(dirname "$script")/recover-upstream-with-pi.sh"

commit_generated() {
  git add -- pnpm-lock.yaml flake.nix
  if ! git diff --cached --quiet; then
    git -c core.hooksPath=/dev/null commit -m 'fix(build): refresh generated dependencies after upstream sync'
  fi
}

if [[ "${1:-}" == --check ]]; then
  # The original runner owns the gates. Pi cannot replace their workflow or scripts.
  git restore --source="$GITHUB_SHA" --staged --worktree -- .github/workflows \
    .github/scripts/recover-upstream-with-pi.sh .github/scripts/validate-upstream-sync.sh
  if ! git diff --cached --quiet; then
    git -c core.hooksPath=/dev/null commit --amend --no-edit
  fi
  test -z "$(git diff --name-only "$GITHUB_SHA" HEAD -- .pi/)"
  vp install --lockfile-only --no-frozen-lockfile --ignore-scripts
  vp install --lockfile-only --frozen-lockfile --ignore-scripts
  node .github/scripts/update-nix-hashes.mjs
  nix build .#desktop .#server --no-link --show-trace --print-build-logs
  commit_generated
  vp install --frozen-lockfile
  for package in @t3tools/contracts t3 @t3tools/client-runtime @t3tools/web @t3tools/desktop @t3tools/mobile; do
    echo "Typecheck: $package"
    vp run --filter "$package" typecheck
  done
  for package in @t3tools/contracts t3 @t3tools/client-runtime @t3tools/web @t3tools/desktop @t3tools/mobile; do
    echo "Tests: $package"
    vp run --filter "$package" test
  done
  vp run --filter @t3tools/web build
  git diff --check
  test -z "$(git status --porcelain)"
  exit 0
fi

if [[ "$(git rev-parse HEAD)" == "$GITHUB_SHA" ]]; then
  echo 'No upstream changes; no candidate to validate.'
  exit 0
fi
for ((attempt = 0; attempt <= 2; attempt++)); do
  log="$RUNNER_TEMP/sync-validation-$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}-$attempt.log"
  echo "Validate upstream candidate (repair $attempt/2)"
  # Run in a fresh shell: calling a function from an if would disable its errexit.
  if bash "$script" --check 2>&1 | tee "$log"; then
    echo 'All sync gates passed; candidate may be published with the original lease.'
    exit 0
  fi
  if [[ "$attempt" == 2 ]]; then
    echo 'Validation still fails after two Pi repairs; nothing will be published.' >&2
    exit 1
  fi
  # A failed Nix build can already have refreshed one hash. Preserve it in the input bundle.
  commit_generated
  test -z "$(git status --porcelain)"
  bash "$helper" "$((attempt + 1))" "$log"
done
