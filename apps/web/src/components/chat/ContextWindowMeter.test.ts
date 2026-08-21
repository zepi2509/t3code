import { describe, expect, it } from "vite-plus/test";

import { canCompactContext } from "./ContextWindowMeter";

describe("canCompactContext", () => {
  it("requires both provider support and an active context snapshot", () => {
    expect(canCompactContext(true, true)).toBe(true);
    expect(canCompactContext(false, true)).toBe(false);
    expect(canCompactContext(true, false)).toBe(false);
  });
});
