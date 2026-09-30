#!/usr/bin/env bash
set -euo pipefail

: "${SYNC_WEBHOOK_URL:?HTTPS sync webhook required}"
: "${SYNC_WEBHOOK_SECRET:?Sync webhook secret required}"
[[ "$SYNC_WEBHOOK_URL" == https://*/sync-failed ]] || {
  echo 'SYNC_WEBHOOK_URL must be HTTPS and end in /sync-failed.' >&2
  exit 1
}
attempt="${1:-0}"
[[ "$attempt" =~ ^[0-2]$ ]]
id="$GITHUB_RUN_ID-${GITHUB_RUN_ATTEMPT:-1}-$attempt"
input="$RUNNER_TEMP/sync-$id.input.bundle"
if [[ "$attempt" == 0 ]]; then
  conflicts="$(git diff --name-only --diff-filter=U)"
  if [[ -z "$conflicts" || "$conflicts" == pnpm-lock.yaml ]]; then
    echo 'Rebase failed without a source conflict; Pi cannot recover it.' >&2
    exit 1
  fi
else
  : "${2:?failed validation log required}"
  test -z "$(git status --porcelain)"
  git update-ref refs/sync-candidate HEAD
  git bundle create "$input" upstream/main..refs/sync-candidate
fi

payload="$RUNNER_TEMP/sync-$id.request.json"
node - "$attempt" "$input" "${2:-}" "$(git rev-parse HEAD)" "$(git rev-parse upstream/main)" > "$payload" <<'JS'
const fs = require('node:fs');
const [attempt, input, log, candidate, upstream] = process.argv.slice(2);
const payload = {
  repository: process.env.GITHUB_REPOSITORY,
  run_id: Number(process.env.GITHUB_RUN_ID),
  run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
  attempt: Number(attempt),
  base: process.env.GITHUB_SHA,
  upstream,
};
if (payload.attempt > 0) {
  const bundle = fs.readFileSync(input);
  if (bundle.length > 16 * 1024 * 1024) throw Error('Repair bundle exceeds 16 MiB');
  // Only the failed gate's tail is sent, never runner credentials or environment dumps.
  let diagnostics = fs.readFileSync(log).subarray(-60_000).toString('utf8');
  for (const name of ['SYNC_WEBHOOK_SECRET', 'GH_TOKEN', 'GITHUB_TOKEN', 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) {
    if (process.env[name]) diagnostics = diagnostics.replaceAll(process.env[name], '[REDACTED]');
  }
  Object.assign(payload, { candidate, bundle: bundle.toString('base64'), log: diagnostics });
}
process.stdout.write(JSON.stringify(payload));
JS
signature="$(openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" < "$payload" | awk '{print $2}')"
curl --fail-with-body --silent --show-error --retry 2 --retry-all-errors \
  --connect-timeout 5 --max-time 120 -H "X-Sync-Signature: sha256=$signature" \
  -H 'Content-Type: application/json' --data-binary "@$payload" "$SYNC_WEBHOOK_URL"

result_path="/result/$id"
result_url="${SYNC_WEBHOOK_URL%/sync-failed}$result_path"
result_signature="$(printf 'GET %s' "$result_path" | openssl dgst -sha256 -hmac "$SYNC_WEBHOOK_SECRET" | awk '{print $2}')"
bundle="$RUNNER_TEMP/sync-$id.bundle"
for ((poll = 0; poll < 210; poll++)); do
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
[[ "${code:-}" == 200 ]] || { echo 'Pi did not finish within 35 minutes.' >&2; exit 1; }

# A GitHub rerun and each repair have distinct results; no previous candidate can be reused.
if [[ "$attempt" == 0 ]]; then git rebase --abort; fi
git bundle verify "$bundle"
git -c fetch.fsckObjects=true fetch "$bundle" refs/heads/main
candidate="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor upstream/main "$candidate"
[[ "$(git rev-list --count --merges upstream/main.."$candidate")" -eq 0 ]]
git diff --check upstream/main "$candidate"
git checkout -B main "$candidate"
[[ -z "$(git status --porcelain)" ]]
echo "Pi candidate $candidate loaded for independent GitHub validation (attempt $attempt)."
