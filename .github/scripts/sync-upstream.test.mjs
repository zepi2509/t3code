import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assert = NodeAssert;
const { execFileSync, spawnSync } = NodeChildProcess;
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = NodeFS;
const { tmpdir } = NodeOS;
const { join } = NodePath;
const { env } = NodeProcess;
const { test } = NodeTest;
const { fileURLToPath } = NodeURL;

const rebaseScript = fileURLToPath(new URL("./rebase-upstream.sh", import.meta.url));
const hashesScript = fileURLToPath(new URL("./update-nix-hashes.mjs", import.meta.url));

for (const version of [
  "0.0.43-preview.20260923.2138",
  "0.0.43-pr.1.2",
  "0.0.43-nightly.20260923.1",
  "0.0.43",
]) {
  test(`macOS manifest handling for ${version}`, (t) => {
    const cwd = workspace(t);
    NodeFS.mkdirSync(join(cwd, "release"));
    const preview = version.includes("-preview.") || version.includes("-pr.");
    if (!preview) writeFileSync(join(cwd, "release/latest-mac.yml"), "manifest");
    const workflow = readFileSync(
      new URL("../workflows/desktop-build.yml", import.meta.url),
      "utf8",
    );
    const shell = workflow.match(
      /name: Disambiguate Intel macOS update manifest[\s\S]*?run: \|\n((?: {10}.*\n)+)/,
    )?.[1];
    assert.ok(shell);
    const result = spawnSync(
      "bash",
      ["-e", "-c", shell.replace("${{ needs.prepare.outputs.version }}", version)],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      NodeFS.readdirSync(join(cwd, "release")),
      preview ? [] : ["latest-mac-x64.yml"],
    );
  });
}

function workspace(t) {
  const cwd = mkdtempSync(join(tmpdir(), "t3-sync-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

for (const conflict of ["pnpm-lock.yaml", "source.txt"]) {
  test(`rebase ${conflict === "pnpm-lock.yaml" ? "resolves generated" : "rejects source"} conflicts`, (t) => {
    const cwd = workspace(t);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    const commit = (message) => {
      git("add", ".");
      git("commit", "-m", message);
    };
    git("init", "-b", "fork");
    git("config", "user.name", "Sync test");
    git("config", "user.email", "sync@example.invalid");
    writeFileSync(join(cwd, conflict), "base\n");
    commit("base");
    git("branch", "upstream");
    writeFileSync(join(cwd, conflict), "fork\n");
    writeFileSync(join(cwd, "pi.txt"), "preserve Pi\n");
    commit("fork integration");
    writeFileSync(join(cwd, conflict), "fork again\n");
    commit("generated-only update");
    git("checkout", "upstream");
    writeFileSync(join(cwd, conflict), "upstream\n");
    commit("upstream update");
    git("checkout", "fork");

    const result = spawnSync("bash", [rebaseScript, "upstream"], { cwd, encoding: "utf8" });
    if (conflict === "source.txt") {
      assert.notEqual(result.status, 0);
      assert.equal(git("diff", "--name-only", "--diff-filter=U"), conflict);
    } else {
      assert.equal(result.status, 0, result.stderr);
      git("merge-base", "--is-ancestor", "upstream", "HEAD");
      assert.equal(git("rev-list", "--count", "--merges", "upstream..HEAD"), "0");
      assert.equal(readFileSync(join(cwd, conflict), "utf8"), "upstream\n");
      assert.equal(readFileSync(join(cwd, "pi.txt"), "utf8"), "preserve Pi\n");
      assert.equal(git("status", "--porcelain"), "");
    }
  });
}

for (const scenario of ["mismatch", "cached", "network"]) {
  const mismatch = scenario !== "network";
  test(`hash refresh handles ${scenario}`, (t) => {
    const cwd = workspace(t);
    const oldHashes = ["A", "B"].map((char) => `sha256-${char.repeat(43)}=`);
    const newHashes = ["C", "D"].map((char) => `sha256-${char.repeat(43)}=`);
    const original = oldHashes.join("\n");
    writeFileSync(join(cwd, "flake.nix"), original);
    writeFileSync(
      join(cwd, "nix"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const index = args.find((arg) => arg.startsWith(".#")).startsWith(".#unwrapped") ? 0 : 1;
const hash = fs.readFileSync("flake.nix", "utf8").split("\\n")[index];
if (args[0] === "eval") { console.log(hash); process.exit(0); }
fs.appendFileSync("builds", args.slice(1).join(" ") + "\\n");
if (${scenario === "cached"} && fs.readFileSync("builds", "utf8").split("\\n").filter((line) => line.startsWith(args[1])).length === 1) process.exit(0);
const expected = ${JSON.stringify(newHashes)}[index];
if (hash === expected) process.exit(0);
console.error(${mismatch} ? "error: hash mismatch in fixed-output derivation 'deps':\\n  specified: " + hash + "\\n       got: " + expected : "error: network unavailable");
process.exit(1);
`,
      { mode: 0o755 },
    );
    const result = spawnSync("node", [hashesScript], {
      cwd,
      encoding: "utf8",
      env: { ...env, PATH: `${cwd}:${env.PATH}` },
    });
    assert.equal(result.status, mismatch ? 0 : 1, result.stderr);
    assert.equal(
      readFileSync(join(cwd, "flake.nix"), "utf8"),
      mismatch ? newHashes.join("\n") : original,
    );
    if (mismatch) {
      assert.deepEqual(
        readFileSync(join(cwd, "builds"), "utf8").trim().split("\n"),
        ["unwrapped", "server"].flatMap((name) => [
          `.#${name}.pnpmDeps --no-link`,
          ...(scenario === "cached" ? [`.#${name}.pnpmDeps --no-link --rebuild`] : []),
          `.#${name}.pnpmDeps --no-link`,
        ]),
      );
    }
  });
}
