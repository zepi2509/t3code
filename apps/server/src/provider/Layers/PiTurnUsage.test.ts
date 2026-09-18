import { describe, expect, it } from "@effect/vitest";
import { completePiTurnUsage, normalizePiMessageUsage } from "./PiTurnUsage.ts";

const usage = { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 };
const message = (value: unknown = usage, stopReason = "stop") =>
  normalizePiMessageUsage({ usage: value, stopReason });

describe("Pi turn usage", () => {
  it("sums main-agent responses including both cache categories without costs or content", () => {
    expect(completePiTurnUsage([message(), message()], true)).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 70,
      outputTokens: 6,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
    });
  });

  it("keeps valid lower bounds for missing responses, partial counters and interrupts", () => {
    expect(completePiTurnUsage([message(), undefined], true)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 35,
      outputTokens: 3,
    });
    expect(completePiTurnUsage([message({ output: 4, cacheRead: 2 })], true)).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      inputTokens: 2,
      outputTokens: 4,
      cachedInputTokens: 2,
    });
    expect(completePiTurnUsage([message()], false)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 35,
    });
    expect(completePiTurnUsage([message(usage, "aborted")], true)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 35,
    });
  });

  it("does not equate missing/error placeholder usage with known zero", () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const messages of [
      [],
      [undefined],
      [message(null)],
      [message(zero, "error")],
      [message(zero, "aborted")],
    ]) {
      expect(completePiTurnUsage(messages, true)).toEqual({
        usageScope: "main_agent",
        usageStatus: "unavailable",
        hasSubagents: false,
      });
    }
    expect(completePiTurnUsage([message(zero)], true)).toMatchObject({
      usageStatus: "complete",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(completePiTurnUsage([message(zero, "error"), message()], true)).toMatchObject({
      usageStatus: "partial",
      inputTokens: 35,
    });
  });

  it("rejects invalid counters without losing independently valid counts", () => {
    for (const invalid of [-1, NaN, Infinity, 1.2, "12", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(completePiTurnUsage([message({ ...usage, input: invalid })], true)).toMatchObject({
        usageStatus: "partial",
        inputTokens: 25,
        outputTokens: 3,
      });
    }
    expect(
      completePiTurnUsage([message({ ...usage, input: Number.MAX_SAFE_INTEGER })], true),
    ).toMatchObject({ usageStatus: "partial", outputTokens: 3 });
  });
});
