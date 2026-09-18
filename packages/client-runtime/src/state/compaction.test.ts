import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isCompactCommandMessage, isContextCompacting } from "./compaction.ts";

const message = {
  id: MessageId.make("compact-request"),
  role: "user" as const,
  text: " /COMPACT ",
  createdAt: "2026-09-08T10:00:00.000Z",
};
const running = { state: "running" as const, requestedAt: message.createdAt };
const input = { messages: [message], activities: [], latestTurn: running, isBusy: true };

describe("context compaction state", () => {
  it("only treats a bare user /compact as a command", () => {
    expect(isCompactCommandMessage(message)).toBe(true);
    expect(isCompactCommandMessage({ ...message, attachments: [{}] })).toBe(false);
    expect(isCompactCommandMessage({ ...message, role: "assistant" })).toBe(false);
    expect(isCompactCommandMessage({ ...message, text: "/compact later" })).toBe(false);
  });

  it("tracks a dispatched optimistic request before its turn is projected", () => {
    expect(
      isContextCompacting({ ...input, messages: [], latestTurn: null, pendingMessage: message }),
    ).toBe(true);
    expect(isContextCompacting({ ...input, isBusy: false, pendingMessage: message })).toBe(false);
  });

  it("tracks queued and running compaction, but not a historical request", () => {
    expect(isContextCompacting(input)).toBe(true);
    expect(
      isContextCompacting({
        ...input,
        latestTurn: { state: "completed", requestedAt: "2026-09-08T09:00:00.000Z" },
      }),
    ).toBe(true);
    expect(
      isContextCompacting({
        ...input,
        latestTurn: { ...running, requestedAt: "2026-09-08T11:00:00.000Z" },
      }),
    ).toBe(false);
    expect(isContextCompacting({ ...input, latestTurn: { ...running, state: "completed" } })).toBe(
      false,
    );
  });

  it.each(["context-compaction", "provider.turn.start.failed"])(
    "settles only the matching %s request, including an optimistic request",
    (kind) => {
      const activities = [{ kind, payload: { requestId: message.id } }];
      expect(isContextCompacting({ ...input, activities })).toBe(false);
      expect(isContextCompacting({ ...input, activities, pendingMessage: message })).toBe(false);
      expect(
        isContextCompacting({
          ...input,
          activities: [{ kind, payload: { requestId: "older-request" } }],
        }),
      ).toBe(true);
      expect(isContextCompacting({ ...input, activities: [{ kind, payload: null }] })).toBe(true);
    },
  );
});
