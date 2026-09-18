import type {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

type CompactionMessage = Pick<OrchestrationMessage, "id" | "role" | "text" | "createdAt"> & {
  readonly attachments?: ReadonlyArray<unknown> | undefined;
};

export function isCompactCommandMessage(
  message: Pick<CompactionMessage, "role" | "text" | "attachments">,
): boolean {
  return (
    message.role === "user" &&
    message.text.trim().toLowerCase() === "/compact" &&
    !message.attachments?.length
  );
}

/** Correlate both optimistic sends and persisted /compact turns with their terminal activity. */
export function isContextCompacting(input: {
  readonly messages: ReadonlyArray<CompactionMessage>;
  readonly activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>;
  readonly latestTurn: Pick<OrchestrationLatestTurn, "state" | "requestedAt"> | null | undefined;
  readonly isBusy: boolean;
  readonly pendingMessage?: CompactionMessage | undefined;
}): boolean {
  if (!input.isBusy) return false;
  const pendingMessage =
    input.pendingMessage && isCompactCommandMessage(input.pendingMessage)
      ? input.pendingMessage
      : undefined;
  const message = pendingMessage ?? input.messages.findLast(isCompactCommandMessage);
  if (!message) return false;
  const settled = input.activities.some((activity) => {
    if (activity.kind !== "context-compaction" && activity.kind !== "provider.turn.start.failed") {
      return false;
    }
    const payload = activity.payload;
    return (
      typeof payload === "object" &&
      payload !== null &&
      "requestId" in payload &&
      payload.requestId === message.id
    );
  });
  if (settled) return false;
  if (pendingMessage) return true;
  return (
    message.createdAt > (input.latestTurn?.requestedAt ?? message.createdAt) ||
    (input.latestTurn?.state === "running" && message.createdAt === input.latestTurn.requestedAt)
  );
}
