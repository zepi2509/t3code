import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { createQueue, createReceiver, jobId } from "../../infra/sync-webhook/server.mjs";

const assert = NodeAssert;
const { execFile, execFileSync } = NodeChildProcess;
const fs = NodeFS;
const os = NodeOS;
const path = NodePath;
const { test } = NodeTest;
const { fileURLToPath } = NodeURL;
const execute = NodeUtil.promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
const secret = "isolated-repair-loop-test-secret-32-bytes";

for (const scenario of ["repairs", "exhausted", "wrong-ancestry"]) {
  test(`validation loop: ${scenario}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-validation-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const runner = path.join(root, "runner");
    const bin = path.join(root, "bin");
    const jobs = path.join(root, "jobs");
    fs.mkdirSync(bin);
    const git = (cwd, ...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git(root, "init", "-q", "-b", "main", runner);
    git(runner, "config", "user.name", "Sync test");
    git(runner, "config", "user.email", "sync@example.invalid");
    fs.mkdirSync(path.join(runner, ".github/scripts"), { recursive: true });
    fs.mkdirSync(path.join(runner, ".github/workflows"));
    for (const file of [
      "recover-upstream-with-pi.sh",
      "validate-upstream-sync.sh",
      "update-nix-hashes.mjs",
    ]) {
      fs.copyFileSync(path.join(scripts, file), path.join(runner, ".github/scripts", file));
      fs.copyFileSync(path.join(scripts, file), path.join(root, file));
    }
    fs.writeFileSync(path.join(runner, ".github/workflows/sync.yml"), "name: original gates\n");
    fs.writeFileSync(path.join(runner, "pnpm-lock.yaml"), "fixture\n");
    const hashes = ["A", "B"].map((char) => `sha256-${char.repeat(43)}=`);
    fs.writeFileSync(path.join(runner, "flake.nix"), hashes.join("\n"));
    fs.writeFileSync(
      path.join(runner, "repair.json"),
      JSON.stringify({ nix: false, types: false }),
    );
    git(runner, "add", ".");
    git(runner, "commit", "-qm", "base");
    git(runner, "branch", "upstream");
    fs.writeFileSync(path.join(runner, "pi.txt"), "preserve Pi behavior\n");
    git(runner, "add", ".");
    git(runner, "commit", "-qm", "Pi fork");
    const base = git(runner, "rev-parse", "HEAD");
    const remote = path.join(root, "fork.git");
    git(root, "init", "-q", "--bare", remote);
    git(runner, "remote", "add", "origin", remote);
    git(runner, "push", "-q", "origin", "HEAD:main");
    git(runner, "checkout", "-q", "upstream");
    fs.writeFileSync(path.join(runner, "upstream.txt"), "preserve upstream behavior\n");
    git(runner, "add", ".");
    git(runner, "commit", "-qm", "upstream update");
    const upstream = git(runner, "rev-parse", "HEAD");
    git(runner, "checkout", "-q", "main");
    git(runner, "rebase", "upstream");
    git(runner, "update-ref", "refs/remotes/upstream/main", upstream);

    const calls = path.join(root, "gates.log");
    const fake = (name, code) =>
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\n${code}`, { mode: 0o755 });
    fake(
      "nix",
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GATES_LOG, 'nix ' + args.join(' ') + '\\n');
if (args[0] === 'eval') {
  console.log(fs.readFileSync('flake.nix', 'utf8').split('\\n')[args[2].startsWith('.#unwrapped') ? 0 : 1]);
} else if (args.includes('.#desktop') && !JSON.parse(fs.readFileSync('repair.json')).nix) {
  fs.writeFileSync('flake.nix', fs.readFileSync('flake.nix', 'utf8').replace('sha256-${"A".repeat(43)}=', 'sha256-${"C".repeat(43)}='));
  console.error('Nix build failed: native Vite+ binding missing ' + process.env.SYNC_WEBHOOK_SECRET);
  process.exit(1);
}`,
    );
    fake(
      "vp",
      `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GATES_LOG, 'vp ' + args.join(' ') + '\\n');
if (args.join(' ') === 'run --filter @t3tools/web typecheck' && !JSON.parse(fs.readFileSync('repair.json')).types) {
  console.error('Web typecheck failed: incompatible upstream type');
  process.exit(1);
}`,
    );
    fake(
      "curl",
      `const fs = require('node:fs');
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const headers = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-H') {
  const separator = args[i + 1].indexOf(':');
  headers[args[i + 1].slice(0, separator)] = args[i + 1].slice(separator + 1).trim();
}
const url = args.at(-1).replace('https://sync.invalid', process.env.TEST_RECEIVER);
(async () => {
  const posting = args.includes('--data-binary');
  const response = await fetch(url, { headers, ...(posting ? { method: 'POST', body: fs.readFileSync(value('--data-binary').slice(1)) } : {}) });
  const body = Buffer.from(await response.arrayBuffer());
  if (posting) { if (!response.ok) throw Error('repair HTTP ' + response.status); }
  else { fs.writeFileSync(value('--output'), body); process.stdout.write(String(response.status)); }
})().catch(error => { console.error(error); process.exit(1); });`,
    );

    const received = [];
    const queue = createQueue(jobs, async (request) => {
      received.push(request);
      const candidate = path.join(root, `candidate-${request.attempt}`);
      git(root, "clone", "-q", runner, candidate);
      git(candidate, "config", "user.name", "Pi test");
      git(candidate, "config", "user.email", "pi@example.invalid");
      const input = path.join(root, `${jobId(request)}.input.bundle`);
      fs.writeFileSync(input, Buffer.from(request.bundle, "base64"));
      git(candidate, "bundle", "verify", input);
      git(candidate, "fetch", "-q", input, "refs/sync-candidate");
      assert.equal(git(candidate, "rev-parse", "FETCH_HEAD"), request.candidate);
      git(candidate, "checkout", "-q", "-B", "main", request.candidate);
      assert.equal(
        fs
          .readFileSync(path.join(candidate, "flake.nix"), "utf8")
          .includes(`sha256-${"C".repeat(43)}=`),
        true,
      );
      assert.equal(request.log.includes(secret), false);
      if (scenario === "wrong-ancestry") git(candidate, "checkout", "-q", "-B", "main", base);
      fs.writeFileSync(
        path.join(candidate, "repair.json"),
        JSON.stringify({
          nix: true,
          types: scenario === "repairs" && request.attempt === 2,
          attempt: request.attempt,
        }),
      );
      // A model may accidentally change the workflow; the runner must restore its original gates.
      fs.writeFileSync(
        path.join(candidate, ".github/workflows/sync.yml"),
        "name: weakened gates\n",
      );
      git(candidate, "add", ".");
      git(candidate, "commit", "-qm", `Pi repair ${request.attempt}`);
      git(
        candidate,
        "bundle",
        "create",
        path.join(jobs, `${jobId(request)}.bundle`),
        `${upstream}..main`,
      );
      return 0;
    });
    const server = createReceiver(secret, queue.enqueue, jobs);
    server.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => server.close());
    let result;
    try {
      result = await execute("bash", [path.join(root, "validate-upstream-sync.sh")], {
        cwd: runner,
        encoding: "utf8",
        maxBuffer: 2_000_000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GATES_LOG: calls,
          TEST_RECEIVER: `http://127.0.0.1:${server.address().port}`,
          GITHUB_SHA: base,
          GITHUB_REPOSITORY: "zepi2509/t3code",
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "3",
          RUNNER_TEMP: root,
          SYNC_WEBHOOK_URL: "https://sync.invalid/sync-failed",
          SYNC_WEBHOOK_SECRET: secret,
        },
      });
    } catch (error) {
      result = error;
    }
    assert.equal(result.code ?? 0, scenario === "repairs" ? 0 : 1, result.stderr);
    assert.deepEqual(
      received.map((request) => request.attempt),
      scenario === "wrong-ancestry" ? [1] : [1, 2],
    );
    assert.equal(received[0].run_attempt, 3);
    assert.equal(received[0].base, base);
    assert.equal(received[0].upstream, upstream);
    assert.notEqual(received[0].candidate, base);
    assert.match(received[0].log, /Nix build failed.*\[REDACTED\]/);
    if (scenario !== "wrong-ancestry") assert.match(received[1].log, /Web typecheck failed/);
    assert.equal(
      git(root, "--git-dir", remote, "rev-parse", "refs/heads/main"),
      base,
      "validation must never push",
    );
    const commands = fs.readFileSync(calls, "utf8").split("\n");
    assert.equal(
      commands.filter((line) => line.startsWith("nix build .#desktop")).length,
      scenario === "wrong-ancestry" ? 1 : 3,
    );
    if (scenario === "repairs") {
      assert.equal(git(runner, "status", "--porcelain"), "");
      assert.equal(git(runner, "rev-list", "--count", "--merges", `${upstream}..HEAD`), "0");
      assert.equal(fs.readFileSync(path.join(runner, "pi.txt"), "utf8"), "preserve Pi behavior\n");
      assert.equal(
        fs.readFileSync(path.join(runner, "upstream.txt"), "utf8"),
        "preserve upstream behavior\n",
      );
      assert.equal(
        fs.readFileSync(path.join(runner, ".github/workflows/sync.yml"), "utf8"),
        "name: original gates\n",
      );
      for (const pkg of [
        "@t3tools/contracts",
        "t3",
        "@t3tools/client-runtime",
        "@t3tools/web",
        "@t3tools/desktop",
        "@t3tools/mobile",
      ]) {
        assert.ok(commands.includes(`vp run --filter ${pkg} test`));
      }
      assert.ok(commands.includes("vp run --filter @t3tools/web build"));
      assert.match(result.stdout, /All sync gates passed/);
    } else if (scenario === "exhausted") {
      assert.match(result.stderr, /after two Pi repairs/);
      assert.ok(!commands.includes("vp run --filter @t3tools/web build"));
    }
  });
}
