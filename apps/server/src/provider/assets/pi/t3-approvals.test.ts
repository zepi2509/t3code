import { describe, expect, it } from "@effect/vitest";

import { autoApprovedTools, describeToolCall, gateDecision } from "./t3-approvals.ts";

describe("t3-approvals: autoApprovedTools (default-deny allowlist)", () => {
  it("auto-approves only read-only tools by default", () => {
    const allowed = autoApprovedTools(undefined);
    for (const tool of ["read", "grep", "find", "ls", "glob"]) {
      expect(allowed.has(tool)).toBe(true);
    }
    for (const tool of ["bash", "write", "edit", "multi_edit", "apply_patch"]) {
      expect(allowed.has(tool)).toBe(false);
    }
  });

  it("adds edit tools only in auto-accept-edits mode; bash still gated", () => {
    const allowed = autoApprovedTools("auto-accept-edits");
    for (const tool of ["write", "edit", "multi_edit", "apply_patch"]) {
      expect(allowed.has(tool)).toBe(true);
    }
    expect(allowed.has("bash")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  it("treats unknown / custom / MCP tools as NOT auto-approved (default-deny)", () => {
    const allowed = autoApprovedTools("auto-accept-edits");
    for (const tool of ["foobar", "mcp__server__write", "rm", "move", ""]) {
      expect(allowed.has(tool)).toBe(false);
    }
  });
});

describe("t3-approvals: gateDecision (fail-closed)", () => {
  it("blocks when there is no UI to ask", () => {
    expect(gateDecision({ hasUI: false, confirmed: false })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
    expect(gateDecision({ hasUI: false, confirmed: true })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
  });

  it("blocks when the user declines", () => {
    expect(gateDecision({ hasUI: true, confirmed: false })).toEqual({
      block: true,
      reason: "Denied in T3 Code",
    });
  });

  it("allows when the user confirms", () => {
    expect(gateDecision({ hasUI: true, confirmed: true })).toBeUndefined();
  });
});

describe("t3-approvals: describeToolCall", () => {
  it("preserves every argument, including command whitespace and file contents", () => {
    for (const input of [
      { command: "  rm -rf /tmp/x  ", timeout: 10 },
      { cmd: "echo hi" },
      { file_path: "src/a.ts", content: "first\n" },
      { path: "src/b.ts", oldText: "before", newText: "after" },
      { foo: 1 },
    ]) {
      expect(JSON.parse(describeToolCall("custom", input))).toEqual(input);
    }
    expect(describeToolCall("custom", undefined)).toBe("custom");
  });

  it("keeps commands sharing a long prefix and writes to the same path distinct", () => {
    const prefix = "x".repeat(1000);
    expect(describeToolCall("bash", { command: `${prefix}; echo safe` })).not.toBe(
      describeToolCall("bash", { command: `${prefix}; echo different` }),
    );
    expect(describeToolCall("write", { path: "same", content: "first" })).not.toBe(
      describeToolCall("write", { path: "same", content: "second" }),
    );
  });

  it("refuses arguments that cannot be serialized instead of collapsing their identity", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    expect(() => describeToolCall("custom", input)).toThrow();
  });
});
