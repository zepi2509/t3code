import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { createQueue, createReceiver } from "./server.mjs";

const secret = "an-isolated-32-byte-test-secret-for-webhooks";
const notification = {
  repository: "zepi2509/t3code",
  run_id: 123,
  base: "a".repeat(40),
  upstream: "b".repeat(40),
};

NodeTest.test("only signed fork sync notifications enqueue a Pi run", async (t) => {
  const accepted = [];
  const server = createReceiver(secret, (request) => accepted.push(request));
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/sync-failed`;
  const send = (payload, signature = true) => {
    const body = JSON.stringify(payload);
    return fetch(url, {
      method: "POST",
      headers: signature
        ? {
            "X-Sync-Signature": `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`,
          }
        : {},
      body,
    });
  };

  NodeAssert.equal((await send(notification, false)).status, 401);
  NodeAssert.equal((await send({ ...notification, repository: "attacker/repo" })).status, 400);
  NodeAssert.equal((await send({ ...notification, base: "../../secrets" })).status, 400);
  NodeAssert.equal((await send({ ...notification, padding: "x".repeat(17_000) })).status, 413);
  NodeAssert.equal((await send(notification)).status, 202);
  NodeAssert.deepEqual(accepted, [
    { run_id: 123, base: notification.base, upstream: notification.upstream },
  ]);
});

NodeTest.test("signed result download waits for a ready bundle", async (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-result-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  NodeFS.writeFileSync(NodePath.join(directory, "123.json"), JSON.stringify(notification));
  const server = createReceiver(secret, () => {}, directory);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/result/123`;
  const signature = NodeCrypto.createHmac("sha256", secret).update("GET /result/123").digest("hex");
  NodeAssert.equal((await fetch(url)).status, 401);
  NodeAssert.equal(
    (await fetch(url, { headers: { "X-Sync-Signature": `sha256=${signature}` } })).status,
    202,
  );
  NodeFS.writeFileSync(NodePath.join(directory, "123.done"), "ready\n");
  NodeAssert.equal(
    (await fetch(url, { headers: { "X-Sync-Signature": `sha256=${signature}` } })).status,
    500,
  );
  NodeFS.writeFileSync(NodePath.join(directory, "123.bundle"), "bundle");
  const ready = await fetch(url, { headers: { "X-Sync-Signature": `sha256=${signature}` } });
  NodeAssert.equal(ready.status, 200);
  NodeAssert.equal(await ready.text(), "bundle");
  NodeFS.writeFileSync(NodePath.join(directory, "123.done"), "failed\n");
  NodeAssert.equal(
    (await fetch(url, { headers: { "X-Sync-Signature": `sha256=${signature}` } })).status,
    409,
  );
});

NodeTest.test("a queued delivery survives a receiver restart", async (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-webhook-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  NodeFS.writeFileSync(NodePath.join(directory, "123.json"), JSON.stringify(notification));
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  createQueue(directory, async () => {
    finished();
    return 0;
  }).resume();
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  NodeAssert.equal(NodeFS.readFileSync(NodePath.join(directory, "123.done"), "utf8"), "ready\n");
});

NodeTest.test("duplicate refs cool down, then retry automatically", async (t) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sync-webhook-"));
  t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const invoked = [];
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const queue = createQueue(directory, async (request) => {
    invoked.push(request.run_id);
    finished();
    return 0;
  });
  NodeAssert.equal(queue.enqueue(notification), true);
  NodeAssert.equal(queue.enqueue(notification), false);
  await done;
  await new Promise((resolve) => setImmediate(resolve));
  queue.resume();
  queue.enqueue({ ...notification, run_id: 124 });
  await new Promise((resolve) => setImmediate(resolve));
  NodeAssert.deepEqual(invoked, [123]);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(directory, "124.done"), "utf8"),
    "already-attempted\n",
  );
  const marker = NodePath.join(directory, `ref-${notification.base}-${notification.upstream}`);
  NodeFS.utimesSync(marker, new Date(0), new Date(0));
  queue.enqueue({ ...notification, run_id: 125 });
  await new Promise((resolve) => setImmediate(resolve));
  NodeAssert.deepEqual(invoked, [123, 125]);
});
