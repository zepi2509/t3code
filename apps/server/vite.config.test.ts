import { describe, expect, it } from "vite-plus/test";

import { shouldBundleDesktopServerDependency } from "./vite.config.ts";

describe("desktop server bundle", () => {
  it("leaves only platform-native packages external", () => {
    expect(shouldBundleDesktopServerDependency("effect")).toBe(true);
    expect(shouldBundleDesktopServerDependency("@anthropic-ai/claude-agent-sdk")).toBe(true);
    expect(shouldBundleDesktopServerDependency("node-pty")).toBe(false);
    expect(shouldBundleDesktopServerDependency("@ff-labs/fff-node")).toBe(false);
  });
});
