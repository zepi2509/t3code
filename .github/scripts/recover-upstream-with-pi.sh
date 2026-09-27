#!/usr/bin/env bash
set -euo pipefail

: "${SYNC_WEBHOOK_URL:?HTTPS sync webhook required}"
: "${SYNC_WEBHOOK_SECRET:?Sync webhook secret required}"
[[ "$SYNC_WEBHOOK_URL" == https://*/sync-failed ]] || {
  echo 'SYNC_WEBHOOK_URL must be HTTPS and end in /sync-failed.' >&2
  exit 1
}
conflicts="$(git diff --name-only --diff-filter=U)"
if [[ -z "$conflicts" || "$conflicts" == pnpm-lock.yaml ]]; then
  echo 'Rebase failed without a source conflict; Pi cannot recover it.' >&2
  exit 1
fi

payload="$(jq -cn \
  --arg repository "$GITHUB_REPOSITORY" \
  --argjson run_id "$GITHUB_RUN_ID" \
  --arg base "$GITHUB_SHA" \
  --arg upstream "$(git rev-parse upstream/main)" \
  '{repository: $repository, run_id: $run_id, base: $base, upstream: $upstream}')"
signature="$(printf '%s' "$payload" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" | awk '{print $2}')"
curl --fail-with-body --silent --show-error --retry 2 --retry-all-errors \
  --connect-timeout 5 --max-time 10 -H "X-Sync-Signature: sha256=$signature" \
  -H 'Content-Type: application/json' --data-binary "$payload" "$SYNC_WEBHOOK_URL"

result_path="/result/$GITHUB_RUN_ID"
result_url="${SYNC_WEBHOOK_URL%/sync-failed}$result_path"
result_signature="$(printf 'GET %s' "$result_path" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" | awk '{print $2}')"
bundle="$RUNNER_TEMP/sync-$GITHUB_RUN_ID.bundle"
for ((attempt = 0; attempt < 150; attempt++)); do
  code="$(curl --silent --show-error --retry 2 --retry-all-errors \
    --connect-timeout 5 --max-time 30 \
    -H "X-Sync-Signature: sha256=$result_signature" \
    --output "$bundle" --write-out '%{http_code}' "$result_url")"
  case "$code" in
    200) break ;;
    202) sleep 10 ;;
    *) echo "Pi result unavailable (HTTP $code); sync stays unpublished." >&2; exit 1 ;;
  esac
done
[[ "${code:-}" == 200 ]] || { echo 'Pi did not finish within 25 minutes.' >&2; exit 1; }

# The bundle contains no credentials; GitHub verifies and tests it before publishing.
git rebase --abort
git bundle verify "$bundle"
git fetch "$bundle" refs/heads/main
candidate="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor upstream/main "$candidate"
[[ "$(git rev-list --count --merges upstream/main.."$candidate")" -eq 0 ]]
git diff --check upstream/main "$candidate"
git checkout -B main "$candidate"
[[ -z "$(git status --porcelain)" ]]
echo "Pi candidate $candidate loaded for independent GitHub validation."
