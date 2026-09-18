import type { TurnTokenUsage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

const TokenCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const decodeTokenCount = Schema.decodeUnknownOption(TokenCount);
const tokenCount = (value: unknown): number | undefined =>
  Option.getOrUndefined(decodeTokenCount(value));

export interface PiMessageUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly complete: boolean;
}

/** Only message_end is authoritative. Pi input excludes both cache categories. */
export function normalizePiMessageUsage(message: Record<string, unknown>): PiMessageUsage {
  const usage = Predicate.isObject(message.usage) ? message.usage : {};
  const input = tokenCount(usage.input);
  const outputTokens = tokenCount(usage.output);
  const cachedInputTokens = tokenCount(usage.cacheRead);
  const cacheCreationTokens = tokenCount(usage.cacheWrite);
  const inputs = [input, cachedInputTokens, cacheCreationTokens];
  const inputTokens = inputs.some((value) => value !== undefined)
    ? tokenCount(inputs.reduce<number>((sum, value) => sum + (value ?? 0), 0))
    : undefined;
  const successful = ["stop", "length", "toolUse"].includes(String(message.stopReason));
  // Pi initializes error/aborted responses with zero usage even if no usage arrived.
  if (!successful && (inputTokens ?? 0) + (outputTokens ?? 0) === 0) return { complete: false };
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    complete:
      successful &&
      inputs.every((value) => value !== undefined) &&
      inputTokens !== undefined &&
      outputTokens !== undefined,
  };
}

/** Missing responses and counters leave known lower bounds, never fabricated zero totals. */
export function completePiTurnUsage(
  messages: ReadonlyArray<PiMessageUsage | undefined>,
  completed: boolean,
): TurnTokenUsage {
  const totals: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheCreationTokens?: number;
  } = {};
  let validTotals = true;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "cacheCreationTokens",
  ] as const) {
    const values = messages.flatMap((message) =>
      message?.[key] !== undefined ? [message[key]] : [],
    );
    if (values.length === 0) continue;
    const total = tokenCount(values.reduce((sum, value) => sum + value, 0));
    if (total !== undefined) totals[key] = total;
    else validTotals = false;
  }
  const common = { usageScope: "main_agent", hasSubagents: false, ...totals } as const;
  if (
    completed &&
    validTotals &&
    messages.length > 0 &&
    messages.every((message) => message?.complete) &&
    totals.inputTokens !== undefined &&
    totals.outputTokens !== undefined
  ) {
    return {
      ...common,
      usageStatus: "complete",
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
    };
  }
  return { ...common, usageStatus: Object.keys(totals).length > 0 ? "partial" : "unavailable" };
}
