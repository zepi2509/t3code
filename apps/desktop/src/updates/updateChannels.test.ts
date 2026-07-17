import { describe, expect, it } from "vite-plus/test";

import { isNightlyDesktopVersion, resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";

describe("desktop update channels", () => {
  it("keeps fork builds on the upstream nightly channel", () => {
    expect(isNightlyDesktopVersion("0.0.29-nightly.20260717.832")).toBe(true);
    expect(isNightlyDesktopVersion("0.0.29-nightly.20260717.832.fork.3")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.29-nightly.20260717.832.fork.3")).toBe(
      "nightly",
    );
    expect(isNightlyDesktopVersion("0.0.29")).toBe(false);
  });
});
