# Pi-assisted fork sync sidecar

The Docker daemon used by `remote-workspace` runs on **ZEPI-Server**. Its host-managed `/opt/stacks/remote-workspace/compose.yaml` starts this sidecar on `remote-workspace_default`, alongside T3. Traefik terminates TLS for `pi-sync.zepner.dev` using a higher-priority TCP router in `/opt/stacks/netbird/traefik-dynamic.yaml`; HTTP/1.1 ALPN is required because the sidecar uses Node's HTTP server. No host port is published.

`infra/sync-webhook/` receives signed notifications **only when the upstream rebase stops on a source conflict**. Like T3, it uses the Pi CLI installed in `remote-workspace` and the existing subscription-backed OAuth login. Each job starts its own headless `pi -p` process against a fresh, credential-free checkout, defaulting to `openai-codex/gpt-6-sol` with `xhigh` thinking. Pi adapts the fork changes to upstream's current logic. Pi never pushes. GitHub Actions downloads the rebased commits, verifies and tests them, then publishes with an explicit lease only if the checks pass.

1. After changing the sidecar code, rebuild its image on ZEPI-Server from this checkout, then start **only** the new service (do not recreate T3 or NetBird):

   ```sh
   SYNC_PI_INSTALL_DIR=/mnt/external_hdd/appdata/remote-workspace/agent-tools/pi \
   SYNC_PI_AGENT_DIR=/mnt/external_hdd/remote-workspace/home/.pi/agent \
     docker compose -f infra/sync-webhook/compose.yaml build sync-webhook
   docker compose -f /opt/stacks/remote-workspace/compose.yaml up -d --no-deps sync-webhook
   docker exec remote-workspace-sync-webhook pi auth check --provider openai-codex --json
   ```

2. GitHub Actions secrets `SYNC_WEBHOOK_URL` (`https://pi-sync.zepner.dev/sync-failed`) and `SYNC_WEBHOOK_SECRET` must be set for the fork. The HMAC secret is also stored in the Docker volume `t3-sync-webhook-secret`, mounted read-only by the service. Rotate both copies together, never commit the secret, and do not expose port 8787 directly. The TCP router forwards to `sync-webhook:8787` on `remote-workspace_default`; the sidecar verifies signatures on both POST and result GET. Without the route and secrets, a conflicted sync fails safely.

3. On a source conflict, the GitHub runner stays in the **same sync run**. It waits for a signed download of the Pi result, verifies the linear Git bundle, regenerates lockfile/Nix hashes if needed, then runs focused contracts/server/web checks and a web build. Only after those checks pass does the existing `--force-with-lease` publish step run. The release job remains part of that workflow, so the complete run reports success or failure; a separate restart would repeat the old conflict or race the current run. No manual review or publish command is required.

   See `docker compose -f /opt/stacks/remote-workspace/compose.yaml logs sync-webhook` and the `t3-sync-jobs` volume for `<run-id>.log`, `<run-id>.done`, and `<run-id>.bundle`. Temporary Git checkouts are removed after each attempt to limit disk use. Duplicate deliveries of one run are ignored. The same fork/upstream pair has a 45-minute cooldown to avoid overlapping Pi runs; a later scheduled run can retry after a failure. If Pi or pre-publish verification fails, `main` remains unchanged. GitHub Actions records failures; a later scheduled sync can retry. A release failure after publication cannot undo the published commit automatically.

On this host Docker's default bridge DNS does not resolve external names; image builds use host networking. The host-managed sidecar service uses `1.1.1.1` as its DNS resolver.

The running container has no Docker socket, full host home directory, or GitHub push token. It mounts only the Pi installation (read-only) and the Pi agent directory (read-write, required for OAuth token refresh), both with the same UID as T3. **This is the shared login**: untrusted repository instructions or model-generated shell commands could read or leak it, and writes to the agent directory can affect T3. Container isolation does not protect that credential. Enable unattended execution only if this risk is acceptable; never mount the entire host home. Do not copy credentials into the worktree. This automation prepares a candidate, **not** a verified sync or a release.
