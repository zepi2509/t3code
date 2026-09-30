import * as NodeChildProcess from "node:child_process";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Native test prerequisites depend on the host OS.
if (process.platform === "linux") {
  const hasLibsecretHeaders = () =>
    NodeChildProcess.spawnSync("pkg-config", ["--exists", "libsecret-1"]).status === 0;

  if (!hasLibsecretHeaders()) {
    // Upstream CI installs these in its workflow, but the fork's independent
    // validation runner invokes the desktop test task without that setup.
    if (process.env.GITHUB_ACTIONS !== "true") {
      throw new Error("Desktop native tests require pkg-config and libsecret-1-dev on Linux.");
    }
    NodeChildProcess.execFileSync("sudo", ["apt-get", "update"], { stdio: "inherit" });
    NodeChildProcess.execFileSync("sudo", ["apt-get", "install", "-y", "pkg-config", "libsecret-1-dev"], {
      stdio: "inherit",
    });
    if (!hasLibsecretHeaders()) {
      throw new Error("libsecret-1 development headers are still unavailable after installation.");
    }
  }
}
