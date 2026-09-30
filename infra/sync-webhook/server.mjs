import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = "zepi2509/t3code";
const JOB_ID = /^[1-9][0-9]*(?:-[1-9][0-9]*-[0-2])?$/;
const MAX_BODY = 24 * 1024 * 1024;

export function jobId(request) {
  return request.run_attempt === undefined
    ? String(request.run_id)
    : `${request.run_id}-${request.run_attempt}-${request.attempt}`;
}

export function verifySignature(body, signature, secret) {
  if (typeof signature !== "string" || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const expected = NodeCrypto.createHmac("sha256", secret).update(body).digest();
  return NodeCrypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

export function parseNotification(body) {
  const value = JSON.parse(body.toString("utf8"));
  if (
    value?.repository !== REPOSITORY ||
    !Number.isSafeInteger(value.run_id) ||
    value.run_id < 1 ||
    !SHA.test(value.base) ||
    !SHA.test(value.upstream) ||
    value.base === value.upstream
  ) {
    throw new Error("Invalid sync notification");
  }
  const request = { run_id: value.run_id, base: value.base, upstream: value.upstream };
  if (value.run_attempt !== undefined) {
    if (
      !Number.isSafeInteger(value.run_attempt) ||
      value.run_attempt < 1 ||
      !Number.isInteger(value.attempt) ||
      value.attempt < 0 ||
      value.attempt > 2
    )
      throw new Error("Invalid sync attempt");
    Object.assign(request, { run_attempt: value.run_attempt, attempt: value.attempt });
  } else if (value.attempt !== undefined || value.candidate !== undefined) {
    throw new Error("Repair requires a workflow attempt");
  }
  if (value.attempt > 0) {
    if (
      !SHA.test(value.candidate) ||
      typeof value.bundle !== "string" ||
      value.bundle.length > 22_369_624 ||
      value.bundle.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.bundle) ||
      typeof value.log !== "string" ||
      !value.log.trim() ||
      Buffer.byteLength(value.log) > 65_536
    )
      throw new Error("Invalid repair input");
    const bundle = Buffer.from(value.bundle, "base64");
    if (
      bundle.length > 16 * 1024 * 1024 ||
      !/^# v[23] git bundle\n/.test(bundle.subarray(0, 16).toString())
    ) {
      throw new Error("Invalid Git bundle");
    }
    Object.assign(request, { candidate: value.candidate, bundle: value.bundle, log: value.log });
  } else if (
    value.candidate !== undefined ||
    value.bundle !== undefined ||
    value.log !== undefined
  ) {
    throw new Error("Unexpected repair input");
  }
  return request;
}

export function createReceiver(secret, enqueue, directory = "/data/jobs") {
  return NodeHttp.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(204).end();
      return;
    }
    if (
      request.method === "GET" &&
      JOB_ID.test((request.url ?? "").replace(/^\/result\//, "")) &&
      request.url.startsWith("/result/")
    ) {
      if (
        !verifySignature(
          Buffer.from(`GET ${request.url}`),
          request.headers["x-sync-signature"],
          secret,
        )
      ) {
        response.writeHead(401).end();
        return;
      }
      const id = request.url.slice("/result/".length);
      if (
        !id.split("-").every((part) => Number.isSafeInteger(Number(part))) ||
        !NodeFS.existsSync(NodePath.join(directory, `${id}.json`))
      ) {
        response.writeHead(404).end();
        return;
      }
      const done = NodePath.join(directory, `${id}.done`);
      if (!NodeFS.existsSync(done)) {
        response.writeHead(202).end();
        return;
      }
      const bundle = NodePath.join(directory, `${id}.bundle`);
      let stat;
      try {
        if (NodeFS.readFileSync(done, "utf8").trim() !== "ready") {
          response.writeHead(409).end();
          return;
        }
        stat = NodeFS.lstatSync(bundle);
      } catch {
        response.writeHead(500).end();
        return;
      }
      if (!stat.isFile() || stat.size > 128 * 1024 * 1024) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/x-git-bundle",
        "Content-Length": stat.size,
      });
      NodeFS.createReadStream(bundle)
        .on("error", (error) => response.destroy(error))
        .pipe(response);
      return;
    }
    if (request.method !== "POST" || request.url !== "/sync-failed") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!verifySignature(body, request.headers["x-sync-signature"], secret)) {
        response.writeHead(401).end();
        return;
      }
      let notification;
      try {
        notification = parseNotification(body);
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (!notification.candidate && body.length > 16_384) {
        response.writeHead(413).end();
        return;
      }
      enqueue(notification);
      response.writeHead(202).end();
    })().catch((error) => {
      console.error("Webhook delivery failed:", error);
      if (!response.headersSent) response.writeHead(error.statusCode ?? 500).end();
    });
  });
}

// Requests survive restarts. A short per-ref cooldown avoids duplicate Pi runs
// while an earlier GitHub runner is still validating the same conflict.
export function createQueue(directory, runJob) {
  NodeFS.mkdirSync(directory, { recursive: true });
  const pending = new Set();
  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    try {
      for (const id of pending) {
        pending.delete(id);
        const file = NodePath.join(directory, `${id}.json`);
        const request = parseNotification(NodeFS.readFileSync(file));
        const marker = NodePath.join(directory, `ref-${request.base}-${request.upstream}`);
        const done = NodePath.join(directory, `${id}.done`);
        if (NodeFS.existsSync(done)) continue;
        let outcome = "already-attempted";
        if (
          request.candidate ||
          !NodeFS.existsSync(marker) ||
          Date.now() - NodeFS.statSync(marker).mtimeMs > 45 * 60_000
        ) {
          try {
            const exit = await runJob(request, NodePath.join(directory, `${id}.log`));
            outcome = exit === 0 ? "ready" : exit === 20 ? "stale" : "failed";
          } catch (error) {
            console.error(`Sync ${id} failed:`, error);
            outcome = "failed";
          }
          NodeFS.writeFileSync(marker, `${id}\n`);
        }
        NodeFS.writeFileSync(`${done}.tmp`, `${outcome}\n`);
        NodeFS.renameSync(`${done}.tmp`, done);
        console.log(`Sync ${id}: ${outcome}; see ${id}.log`);
      }
    } finally {
      busy = false;
    }
  }
  return {
    enqueue(request) {
      request = parseNotification(
        Buffer.from(JSON.stringify({ ...request, repository: REPOSITORY })),
      );
      const id = jobId(request);
      try {
        NodeFS.writeFileSync(
          NodePath.join(directory, `${id}.json`),
          JSON.stringify({ ...request, repository: REPOSITORY }),
          {
            flag: "wx",
            mode: 0o600,
          },
        );
      } catch (error) {
        if (error.code === "EEXIST") {
          const existing = parseNotification(
            NodeFS.readFileSync(NodePath.join(directory, `${id}.json`)),
          );
          if (JSON.stringify(existing) !== JSON.stringify(request)) {
            throw Object.assign(new Error("Sync job already exists with different inputs"), {
              statusCode: 409,
            });
          }
          return false;
        }
        throw error;
      }
      pending.add(id);
      void drain().catch((error) => console.error("Sync queue stopped:", error));
      return true;
    },
    resume() {
      for (const file of NodeFS.readdirSync(directory)) {
        if (
          file.endsWith(".json") &&
          JOB_ID.test(file.slice(0, -5)) &&
          !NodeFS.existsSync(NodePath.join(directory, file.replace(/\.json$/, ".done")))
        ) {
          pending.add(file.slice(0, -5));
        }
      }
      void drain().catch((error) => console.error("Sync queue stopped:", error));
    },
  };
}

function runJob(request, log) {
  return new Promise((resolve, reject) => {
    const id = jobId(request);
    if (request.candidate) {
      NodeFS.writeFileSync(`/data/jobs/${id}.input.bundle`, Buffer.from(request.bundle, "base64"), {
        mode: 0o600,
      });
      NodeFS.writeFileSync(`/data/jobs/${id}.failure.log`, request.log, { mode: 0o600 });
    }
    const fd = NodeFS.openSync(log, "a", 0o600);
    const child = NodeChildProcess.spawn(
      "timeout",
      [
        "-k",
        "10s",
        "30m",
        "bash",
        "/app/reconcile.sh",
        id,
        request.base,
        request.upstream,
        request.candidate ?? "",
      ],
      {
        stdio: ["ignore", fd, fd],
      },
    );
    NodeFS.closeSync(fd);
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

if (
  process.argv[1] &&
  NodeURL.pathToFileURL(NodePath.resolve(process.argv[1])).href === import.meta.url
) {
  const secret = NodeFS.readFileSync(
    process.env.WEBHOOK_SECRET_FILE ?? "/run/secrets/webhook",
    "utf8",
  ).trim();
  if (secret.length < 32) throw new Error("Webhook secret must be at least 32 characters");
  const queue = createQueue("/data/jobs", runJob);
  createReceiver(secret, queue.enqueue).listen(8787, "0.0.0.0", () => {
    console.log("Sync webhook listening on port 8787");
    queue.resume();
  });
}
