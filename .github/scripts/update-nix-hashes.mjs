import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

for (const name of ["unwrapped", "server"]) {
  const target = `.#${name}.pnpmDeps`;
  const oldHash = NodeChildProcess.execFileSync("nix", ["eval", "--raw", `${target}.outputHash`], {
    encoding: "utf8",
  }).trim();
  const args = ["build", target, "--no-link"];
  const options = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  let result = NodeChildProcess.spawnSync("nix", args, options);
  // A cached store with the old hash can hide newly added dependencies.
  // --rebuild requires an existing output, so build it normally first.
  if (result.status === 0) {
    result = NodeChildProcess.spawnSync("nix", [...args, "--rebuild"], options);
  }
  if (result.error) throw result.error;
  if (result.status === 0) continue;
  console.error(result.stderr);

  const newHash = result.stderr.match(/^\s*got:\s*(sha256-[A-Za-z0-9+/]+=)\s*$/m)?.[1];
  if (
    !result.stderr.includes("hash mismatch in fixed-output derivation") ||
    !result.stderr.includes(`specified: ${oldHash}`) ||
    !newHash ||
    newHash === oldHash
  ) {
    throw new Error(`Could not refresh ${target}; this is not a dependency hash mismatch.`);
  }
  const source = NodeFS.readFileSync("flake.nix", "utf8");
  if (source.split(oldHash).length !== 2) {
    throw new Error(`Expected exactly one ${name} dependency hash in flake.nix.`);
  }
  NodeFS.writeFileSync("flake.nix", source.replace(oldHash, newHash));
  NodeChildProcess.execFileSync("nix", args, { stdio: "inherit" });
}
