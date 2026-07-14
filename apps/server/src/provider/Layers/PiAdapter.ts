/** `ProviderAdapterShape` for the Pi coding agent (per-thread `pi --mode rpc` sessions). */
import * as NodeURL from "node:url";

import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ModelSelection,
  type PiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  buildPiTurnCommand,
  extractAssistantTextDelta,
  extractForkMessages,
  extractPiCommands,
  extractReasoningTextDelta,
  extractSessionFile,
  isPiExtensionCommand,
  makePiRpcTransport,
  type MakePiRpcTransportOptions,
  type PiAgentEvent,
  piForkSucceeded,
  piImageContentFromBytes,
  type PiImageContent,
  piModelSlug,
  piResponseData,
  piResponseHasCommand,
  piResponseSucceeded,
  planPiModelSwitch,
  resolveForkTargetEntryId,
  resolvePiThinkingLevel,
  type PiRpcTransport,
  type PiStdoutMessage,
  type PiThinkingLevel,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from "./PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");
export const buildPiCompactCommand = () => ({ type: "compact" as const });

const PI_STATE_TIMEOUT_MS = 5_000;
const PI_COMMANDS_TIMEOUT_MS = 5_000;
const PI_MESSAGES_TIMEOUT_MS = 5_000;
// fork/new_session rebinds to a new session file — give it more headroom
const PI_FORK_TIMEOUT_MS = 15_000;
const PI_MODEL_OPTIONS_TIMEOUT_MS = 5_000;
const PI_PROMPT_TIMEOUT_MS = 5_000;
const PI_APPROVAL_TITLE_PREFIX = "[t3-tool-approval] ";

// keep in sync with SENTINEL_COMMAND in t3-approvals.ts
const PI_APPROVAL_SENTINEL_COMMAND = "t3-approval-gate";

// like Claude/Cursor: full-access runs ungated; approval-required and
// auto-accept-edits gate via the bundled extension (Pi has no native per-tool approval)
function approvalGateForRuntimeMode(
  runtimeMode: ProviderSession["runtimeMode"],
): { readonly gate: false } | { readonly gate: true; readonly mode: string } {
  if (runtimeMode === "approval-required" || runtimeMode === "auto-accept-edits") {
    return { gate: true, mode: runtimeMode };
  }
  return { gate: false };
}

// dev resolves ../assets (running from src); the vp-pack build copies the asset
// next to the bundle, so prod resolves ./assets
const APPROVAL_EXTENSION_CANDIDATES: ReadonlyArray<string> = (() => {
  const resolve = (relative: string): string | undefined => {
    try {
      return NodeURL.fileURLToPath(new URL(relative, import.meta.url));
    } catch {
      return undefined;
    }
  };
  return [resolve("../assets/pi/t3-approvals.ts"), resolve("./assets/pi/t3-approvals.ts")].filter(
    (value): value is string => value !== undefined,
  );
})();

interface PiToolItem {
  readonly id: RuntimeItemId;
  readonly type: CanonicalItemType;
  readonly toolName: string;
  args: unknown;
}

interface PiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly items: Array<PiToolItem>;
}

interface PendingApproval {
  readonly piId: string;
  readonly requestType: CanonicalRequestType;
  readonly sessionApprovalKey: string;
}

interface NumberedOption {
  readonly index: number;
  readonly label: string;
}

type PendingNumberedOption = string | NumberedOption;

interface PendingUserInput {
  readonly piId: string;
  readonly questionId: string;
  readonly method: "select" | "confirm" | "input" | "editor";
  readonly numberedOptions?: ReadonlyArray<PendingNumberedOption>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly sessionScope: Scope.Closeable;
  readonly transport: PiRpcTransport;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly sessionApprovals: Set<string>;
  turnState: PiTurnState | undefined;
  agentActive: boolean;
  readonly turns: Array<{ id: TurnId; items: Array<PiToolItem> }>;
  readonly extensionCommands: Set<string>;
  stopped: boolean;
  // slug the pi process is running; used to issue set_model only on change
  currentModel: string | undefined;
  appliedThinkingLevel: PiThinkingLevel | undefined;
}

// ---------------------------------------------------------------------------
// Pure classification helpers
// ---------------------------------------------------------------------------

export function classifyPiToolItemType(toolName: string): CanonicalItemType {
  // whole-token match (split camelCase/separators) so "recommend" isn't read as "command"
  const tokens = new Set(
    toolName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[._/-]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
  const has = (...words: ReadonlyArray<string>): boolean => words.some((word) => tokens.has(word));

  if (has("mcp")) return "mcp_tool_call";
  if (has("agent", "subagent", "task", "skill")) return "collab_agent_tool_call";
  if (has("bash", "shell", "command", "terminal", "exec")) return "command_execution";
  if (has("edit", "write", "patch", "apply", "file")) return "file_change";
  if (has("search", "web")) return "web_search";
  if (has("image")) return "image_view";
  return "dynamic_tool_call";
}

export function classifyPiApprovalRequestType(toolHint: string): CanonicalRequestType {
  const item = classifyPiToolItemType(toolHint);
  switch (item) {
    case "command_execution":
      return "command_execution_approval";
    case "file_change":
      return "file_change_approval";
    default:
      // a Pi confirm is a binary gate, not structured input; tool_user_input
      // would be dropped by the runtime-ingestion + web approval pipeline
      return "dynamic_tool_call";
  }
}

export function summarizePiToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const input = args as Record<string, unknown>;
  const command = input["command"] ?? input["cmd"];
  if (typeof command === "string" && command.trim().length > 0) return command.trim().slice(0, 400);
  const path = input["file_path"] ?? input["path"] ?? input["filePath"];
  if (typeof path === "string" && path.trim().length > 0) return path.trim().slice(0, 400);
  const pattern = input["pattern"] ?? input["query"] ?? input["description"];
  if (typeof pattern === "string" && pattern.trim().length > 0) return pattern.trim().slice(0, 400);
  try {
    const serialized = JSON.stringify(input);
    return serialized.length <= 400 ? serialized : `${serialized.slice(0, 397)}...`;
  } catch {
    return undefined;
  }
}

// Pi encodes an RPC multi-select as `Title\n1. A\n2. B`
export function parseNumberedList(
  text: string,
): { title: string; items: ReadonlyArray<NumberedOption> } | null {
  const lines = text.split("\n");
  const items: NumberedOption[] = [];
  for (const line of lines.slice(1)) {
    const match = /^(\d+)\.\s+(.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) items.push({ index: Number(match[1]), label: match[2] });
  }
  return items.length >= 2 ? { title: lines[0] ?? text, items } : null;
}

export function isPiApprovalConfirmed(decision: ProviderApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

export function buildPiApprovalResponse(
  piId: string,
  decision: ProviderApprovalDecision,
): RpcExtensionUIResponse {
  return { type: "extension_ui_response", id: piId, confirmed: isPiApprovalConfirmed(decision) };
}

// numbered-list multi-select maps labels back to Pi's 1-based, comma-joined indices
export function buildPiUserInputResponse(
  pending: {
    readonly piId: string;
    readonly questionId: string;
    readonly method: "select" | "confirm" | "input" | "editor";
    readonly numberedOptions?: ReadonlyArray<PendingNumberedOption>;
  },
  answers: ProviderUserInputAnswers,
): RpcExtensionUIResponse {
  const answer = answers[pending.questionId];
  if (answer === null || answer === undefined) {
    return { type: "extension_ui_response", id: pending.piId, cancelled: true };
  }
  if (pending.method === "confirm") {
    return {
      type: "extension_ui_response",
      id: pending.piId,
      confirmed: answer === true || answer === "Yes" || answer === "Confirm",
    };
  }
  const numberedOptions = pending.numberedOptions;
  if (pending.method === "input" && numberedOptions) {
    const selected: ReadonlyArray<string> = Array.isArray(answer)
      ? answer.map(String)
      : typeof answer === "string" && answer.length > 0
        ? [answer]
        : [];
    const indices = selected
      .map((label) => {
        const optionIndex = numberedOptions.findIndex((entry) =>
          typeof entry === "string" ? entry === label : entry.label === label,
        );
        if (optionIndex < 0) return null;
        const option = numberedOptions[optionIndex];
        if (option === undefined) return null;
        return String(typeof option === "string" ? optionIndex + 1 : option.index);
      })
      .filter((value): value is string => value !== null);
    return { type: "extension_ui_response", id: pending.piId, value: indices.join(",") };
  }
  const value = typeof answer === "string" ? answer : "";
  return { type: "extension_ui_response", id: pending.piId, value };
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return fallback;
}

function readPiResumeState(resumeCursor: unknown): { sessionFile: string } | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") return undefined;
  const cursor = resumeCursor as Record<string, unknown>;
  return typeof cursor["sessionFile"] === "string" && cursor["sessionFile"].trim().length > 0
    ? { sessionFile: cursor["sessionFile"].trim() }
    : undefined;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  // transport override for tests; defaults to the real `pi --mode rpc` spawn
  readonly makeTransport?: (
    options: MakePiRpcTransportOptions,
  ) => Effect.Effect<
    PiRpcTransport,
    PlatformError.PlatformError,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options?: PiAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const baseEnvironment = options?.environment ?? process.env;

  let approvalExtensionPath: string | undefined;
  for (const candidate of APPROVAL_EXTENSION_CANDIDATES) {
    const exists = yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));
    if (exists) {
      approvalExtensionPath = candidate;
      break;
    }
  }
  const approvalExtensionAvailable = approvalExtensionPath !== undefined;

  const sessions = new Map<ThreadId, PiSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextUuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nextEventId = Effect.map(nextUuid, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const rawEvent = (
    source: "pi.rpc.event" | "pi.rpc.extension-ui",
    method: string,
    payload: unknown,
  ) => ({ raw: { source, method, payload } }) as const;

  const completeTurn = (
    context: PiSessionContext,
    state: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const turnState = context.turnState;
      if (!turnState) return;
      context.turnState = undefined;
      context.turns.push({ id: turnState.turnId, items: [...turnState.items] });

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...readySession } = context.session;
      context.session = { ...readySession, status: "ready", updatedAt };

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "turn.completed",
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId: turnState.turnId,
        payload: {
          state,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
    });

  const openTurn = (context: PiSessionContext): Effect.Effect<TurnId> =>
    Effect.gen(function* () {
      const turnId = TurnId.make(yield* nextUuid);
      const startedAt = yield* nowIso;
      context.turnState = { turnId, startedAt, items: [] };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        type: "turn.started",
        payload: context.currentModel ? { model: context.currentModel } : {},
      });
      return turnId;
    });

  const updateDiscoveredCommands = (
    context: PiSessionContext,
    response: Parameters<typeof extractPiCommands>[0],
  ): void => {
    context.extensionCommands.clear();
    for (const command of extractPiCommands(response)) {
      if (command.source === "extension") context.extensionCommands.add(command.name);
    }
  };

  const syncPiSessionState = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const [stateResponse, statsResponse, commandsResponse] = yield* Effect.all([
        context.transport.request(
          { type: "get_state" },
          `pi-sync-state-${yield* nextUuid}`,
          PI_STATE_TIMEOUT_MS,
        ),
        context.transport.request(
          { type: "get_session_stats" },
          `pi-sync-stats-${yield* nextUuid}`,
          PI_STATE_TIMEOUT_MS,
        ),
        context.transport.request(
          { type: "get_commands" },
          `pi-sync-commands-${yield* nextUuid}`,
          PI_COMMANDS_TIMEOUT_MS,
        ),
      ]);
      updateDiscoveredCommands(context, commandsResponse);

      const state = piResponseData(stateResponse);
      const model = state?.["model"];
      if (model && typeof model === "object") {
        const record = model as Record<string, unknown>;
        if (typeof record["provider"] === "string" && typeof record["id"] === "string") {
          context.currentModel = piModelSlug({ provider: record["provider"], id: record["id"] });
          context.session = { ...context.session, model: context.currentModel };
        }
      }
      const thinkingLevel = state?.["thinkingLevel"];
      if (typeof thinkingLevel === "string") {
        context.appliedThinkingLevel = thinkingLevel as PiThinkingLevel;
      }
      const sessionFile = extractSessionFile(stateResponse);
      if (sessionFile) context.session = { ...context.session, resumeCursor: { sessionFile } };
      const sessionName = state?.["sessionName"];
      if (typeof sessionName === "string" && sessionName.trim().length > 0) {
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "thread.metadata.updated",
          payload: { name: sessionName.trim() },
        });
      }

      const stats = piResponseData(statsResponse);
      const tokens = stats?.["tokens"];
      if (tokens && typeof tokens === "object") {
        const tokenRecord = tokens as Record<string, unknown>;
        const contextUsage =
          stats?.["contextUsage"] && typeof stats["contextUsage"] === "object"
            ? (stats["contextUsage"] as Record<string, unknown>)
            : undefined;
        const usedTokens =
          typeof contextUsage?.["tokens"] === "number"
            ? contextUsage["tokens"]
            : typeof tokenRecord["total"] === "number"
              ? tokenRecord["total"]
              : 0;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: Math.max(0, Math.trunc(usedTokens)),
              ...(typeof tokenRecord["total"] === "number"
                ? { totalProcessedTokens: Math.max(0, Math.trunc(tokenRecord["total"])) }
                : {}),
              ...(typeof tokenRecord["input"] === "number"
                ? { inputTokens: Math.max(0, Math.trunc(tokenRecord["input"])) }
                : {}),
              ...(typeof tokenRecord["cacheRead"] === "number"
                ? { cachedInputTokens: Math.max(0, Math.trunc(tokenRecord["cacheRead"])) }
                : {}),
              ...(typeof tokenRecord["output"] === "number"
                ? { outputTokens: Math.max(0, Math.trunc(tokenRecord["output"])) }
                : {}),
              ...(typeof contextUsage?.["contextWindow"] === "number" &&
              contextUsage["contextWindow"] > 0
                ? { maxTokens: Math.trunc(contextUsage["contextWindow"]) }
                : {}),
              ...(typeof stats["toolCalls"] === "number"
                ? { toolUses: Math.max(0, Math.trunc(stats["toolCalls"])) }
                : {}),
              compactsAutomatically: state?.["autoCompactionEnabled"] === true,
            },
          },
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to synchronize Pi RPC state", {
          threadId: context.session.threadId,
          cause,
        }),
      ),
    );

  const renderPiValue = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value === undefined) return undefined;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  const handlePiEvent = (context: PiSessionContext, event: PiAgentEvent): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      const base = {
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...rawEvent("pi.rpc.event", event.type, event),
      };

      switch (event.type) {
        case "agent_start": {
          context.agentActive = true;
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "running" },
          });
          return;
        }

        case "turn_start": {
          if (!context.turnState) {
            yield* openTurn(context);
          }
          return;
        }

        case "message_start":
          return;

        case "message_end": {
          const message = event.message as unknown as Record<string, unknown>;
          if (message["role"] !== "custom" || message["display"] === false) return;
          const content = renderPiValue(message["content"]);
          if (!content?.trim()) return;
          const turnId = context.turnState?.turnId;
          yield* offerRuntimeEvent({
            ...base,
            ...(turnId ? { turnId } : {}),
            itemId: RuntimeItemId.make(`custom:${stamp.eventId}`),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              title:
                typeof message["customType"] === "string"
                  ? message["customType"]
                  : "Extension message",
              detail: content,
              data: {
                customType: message["customType"],
                content: message["content"],
                details: message["details"],
              },
            },
          });
          return;
        }

        case "message_update": {
          if (!context.turnState) return;
          const text = extractAssistantTextDelta(event);
          if (text !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: text },
            });
            return;
          }
          const reasoning = extractReasoningTextDelta(event);
          if (reasoning !== null) {
            yield* offerRuntimeEvent({
              ...base,
              turnId: context.turnState.turnId,
              type: "content.delta",
              payload: { streamKind: "reasoning_text", delta: reasoning },
            });
          }
          return;
        }

        case "tool_execution_start": {
          if (!context.turnState) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const detail = summarizePiToolArgs(event.args);
          const argsObj =
            event.args && typeof event.args === "object"
              ? (event.args as Record<string, unknown>)
              : undefined;
          context.turnState.items.push({
            id: itemId,
            type: itemType,
            toolName: event.toolName,
            args: event.args,
          });
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.started",
            payload: {
              itemType,
              title: event.toolName,
              ...(detail ? { detail } : {}),
              ...(argsObj ? { data: { toolName: event.toolName, input: argsObj } } : {}),
            },
          });
          return;
        }

        case "tool_execution_update": {
          if (!context.turnState) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const detail = renderPiValue(event.partialResult);
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.updated",
            payload: {
              itemType,
              title: event.toolName,
              status: "inProgress",
              ...(detail?.trim() ? { detail: detail.slice(0, 2_000) } : {}),
              data: {
                toolName: event.toolName,
                input: event.args,
                // Pi partialResult is accumulated structured output: replace, never append.
                partialResult: event.partialResult,
              },
            },
          });
          return;
        }

        case "tool_execution_end": {
          if (!context.turnState) return;
          const itemId = RuntimeItemId.make(event.toolCallId);
          const itemType = classifyPiToolItemType(event.toolName);
          const storedItem = context.turnState.items.find((item) => item.id === itemId);
          const argsDetail = summarizePiToolArgs(storedItem?.args);
          const resultDetail = renderPiValue(event.result);
          const detail =
            event.isError || itemType === "dynamic_tool_call" || itemType === "mcp_tool_call"
              ? resultDetail?.slice(0, 2_000)
              : argsDetail;
          const argsObj =
            storedItem?.args && typeof storedItem.args === "object"
              ? (storedItem.args as Record<string, unknown>)
              : undefined;
          yield* offerRuntimeEvent({
            ...base,
            turnId: context.turnState.turnId,
            itemId,
            type: "item.completed",
            payload: {
              itemType,
              title: event.toolName,
              status: event.isError ? "failed" : "completed",
              ...(detail ? { detail } : {}),
              data: {
                toolName: event.toolName,
                ...(argsObj ? { input: argsObj } : {}),
                result: event.result,
                isError: event.isError,
                ...((event.result as { terminate?: unknown } | null)?.terminate === true
                  ? { terminate: true }
                  : {}),
              },
            },
          });
          return;
        }

        case "turn_end": {
          // agent_end drives completion, not turn_end (pi runs many internal turns per prompt)
          return;
        }

        case "agent_end":
          // Low-level end is not terminal: retry, compaction, steering, or follow-up may follow.
          return;

        case "agent_settled": {
          context.agentActive = false;
          if (context.turnState) yield* completeTurn(context, "completed");
          yield* syncPiSessionState(context);
          return;
        }

        case "queue_update": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: {
              state: context.turnState ? "running" : "ready",
              detail: { steering: event.steering, followUp: event.followUp },
            },
          });
          const queuedMessages = [
            ...event.steering.map((message) => `Steering queued: ${message}`),
            ...event.followUp.map((message) => `Follow-up queued: ${message}`),
          ];
          const queueStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            ...queueStamp,
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
            type: "provider.ui",
            payload: {
              effect: {
                method: "setStatus",
                statusKey: "pi-queue",
                ...(queuedMessages.length > 0
                  ? { statusText: queuedMessages.join(" · ").slice(0, 400) }
                  : {}),
              },
            },
            ...rawEvent("pi.rpc.event", event.type, event),
          });
          return;
        }

        case "compaction_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: { state: "waiting", reason: "compaction", detail: { reason: event.reason } },
          });
          return;
        }

        case "compaction_end": {
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.state.changed",
            payload: {
              state: "compacted",
              detail: {
                reason: event.reason,
                result: event.result,
                aborted: event.aborted,
                willRetry: event.willRetry,
                ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
              },
            },
          });
          return;
        }

        case "auto_retry_start": {
          yield* offerRuntimeEvent({
            ...base,
            type: "session.state.changed",
            payload: {
              state: "waiting",
              reason: `Retry ${event.attempt}/${event.maxAttempts}`,
              detail: event,
            },
          });
          return;
        }

        case "auto_retry_end": {
          if (!event.success && event.finalError) {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.error",
              payload: { message: event.finalError, class: "provider_error", detail: event },
            });
          }
          return;
        }

        case "extension_error": {
          yield* offerRuntimeEvent({
            ...base,
            type: "runtime.error",
            payload: {
              message: `Pi extension error: ${event.error}`,
              class: "provider_error",
              detail: { extensionPath: event.extensionPath, event: event.event },
            },
          });
          return;
        }

        case "session_info_changed": {
          if (!event.name?.trim()) return;
          yield* offerRuntimeEvent({
            ...base,
            type: "thread.metadata.updated",
            payload: { name: event.name.trim() },
          });
          return;
        }

        case "thinking_level_changed": {
          context.appliedThinkingLevel = event.level as PiThinkingLevel;
          yield* offerRuntimeEvent({
            ...base,
            type: "session.configured",
            payload: { config: { thinkingLevel: event.level } },
          });
          return;
        }

        case "entry_appended": {
          const entry = event.entry as unknown as Record<string, unknown>;
          if (
            entry["type"] === "model_change" &&
            typeof entry["provider"] === "string" &&
            typeof entry["modelId"] === "string"
          ) {
            context.currentModel = `${entry["provider"]}/${entry["modelId"]}`;
            context.session = { ...context.session, model: context.currentModel };
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              payload: { config: { model: context.currentModel } },
            });
            return;
          }
          if (entry["type"] === "custom") {
            yield* offerRuntimeEvent({
              ...base,
              type: "runtime.warning",
              payload: {
                message:
                  typeof entry["customType"] === "string"
                    ? `Pi extension state: ${entry["customType"]}`
                    : "Pi extension state updated",
                detail: entry["data"],
              },
            });
          }
          return;
        }
      }
    });

  const handleExtensionUIRequest = (
    context: PiSessionContext,
    request: RpcExtensionUIRequest,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const stamp = yield* makeEventStamp();
      const turnId = context.turnState?.turnId;

      if (
        request.method === "notify" ||
        request.method === "setStatus" ||
        request.method === "setWidget" ||
        request.method === "setTitle" ||
        request.method === "set_editor_text"
      ) {
        const effect = (() => {
          switch (request.method) {
            case "notify":
              return {
                method: "notify" as const,
                message: request.message,
                notifyType: request.notifyType ?? "info",
              };
            case "setStatus":
              return {
                method: "setStatus" as const,
                statusKey: request.statusKey,
                ...(request.statusText === undefined ? {} : { statusText: request.statusText }),
              };
            case "setWidget":
              return {
                method: "setWidget" as const,
                widgetKey: request.widgetKey,
                ...(request.widgetLines === undefined ? {} : { widgetLines: request.widgetLines }),
                widgetPlacement: request.widgetPlacement ?? "aboveEditor",
              };
            case "setTitle":
              return { method: "setTitle" as const, title: request.title };
            case "set_editor_text":
              return { method: "set_editor_text" as const, text: request.text };
          }
        })();
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          type: "provider.ui",
          payload: { effect },
          ...rawEvent("pi.rpc.extension-ui", request.method, request),
        });
        return;
      }

      const requestId = ApprovalRequestId.make(yield* nextUuid);
      const runtimeRequestId = RuntimeRequestId.make(requestId);

      if (request.method === "confirm" && request.title.startsWith(PI_APPROVAL_TITLE_PREFIX)) {
        const title = request.title.slice(PI_APPROVAL_TITLE_PREFIX.length);
        const requestType = classifyPiApprovalRequestType(title);
        const detail = request.message.length > 0 ? `${title}\n${request.message}` : title;
        const sessionApprovalKey = `${requestType}:${detail}`;
        if (context.sessionApprovals.has(sessionApprovalKey)) {
          yield* context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: request.id,
            confirmed: true,
          });
          return;
        }
        context.pendingApprovals.set(requestId, {
          piId: request.id,
          requestType,
          sessionApprovalKey,
        });
        yield* offerRuntimeEvent({
          ...stamp,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          requestId: runtimeRequestId,
          type: "request.opened",
          payload: { requestType, detail: detail.slice(0, 2000), args: { ...request, title } },
          ...rawEvent("pi.rpc.extension-ui", request.method, request),
        });
        if (request.timeout !== undefined) {
          yield* Effect.sleep(request.timeout).pipe(
            Effect.flatMap(() => {
              if (!context.pendingApprovals.delete(requestId)) return Effect.void;
              return makeEventStamp().pipe(
                Effect.flatMap((timeoutStamp) =>
                  offerRuntimeEvent({
                    ...timeoutStamp,
                    provider: PROVIDER,
                    providerInstanceId: boundInstanceId,
                    threadId: context.session.threadId,
                    ...(turnId ? { turnId } : {}),
                    requestId: runtimeRequestId,
                    type: "request.resolved",
                    payload: { requestType, decision: "cancel" },
                  }),
                ),
              );
            }),
            Effect.forkIn(context.sessionScope),
          );
        }
        return;
      }

      const questionId = String(requestId);
      let numberedOptions: ReadonlyArray<PendingNumberedOption> | undefined;
      const parsed = request.method === "input" ? parseNumberedList(request.title) : null;
      if (parsed) numberedOptions = parsed.items;
      const title = parsed?.title ?? request.title;
      const options =
        request.method === "select"
          ? request.options
          : request.method === "confirm"
            ? ["Yes", "No"]
            : parsed
              ? parsed.items.map((item) => item.label)
              : [];
      const question: UserInputQuestion = {
        id: questionId,
        header: title.slice(0, 12) || "Input",
        question:
          request.method === "confirm" && request.message.length > 0 ? request.message : title,
        options: options.map((label) => ({ label, description: label })),
        multiSelect: Boolean(parsed),
        inputKind: request.method,
        title,
        ...(request.method === "confirm" ? { message: request.message } : {}),
        ...(request.method === "input" && request.placeholder !== undefined
          ? { placeholder: request.placeholder }
          : {}),
        ...(request.method === "editor" && request.prefill !== undefined
          ? { prefill: request.prefill }
          : {}),
        multiline: request.method === "editor",
        ...(request.method !== "editor" && request.timeout !== undefined
          ? { timeoutMs: Math.max(1, Math.trunc(request.timeout)) }
          : {}),
      };

      context.pendingUserInputs.set(requestId, {
        piId: request.id,
        questionId,
        method: request.method,
        ...(numberedOptions ? { numberedOptions } : {}),
      });

      yield* offerRuntimeEvent({
        ...stamp,
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(turnId ? { turnId } : {}),
        requestId: runtimeRequestId,
        type: "user-input.requested",
        payload: { questions: [question] },
        ...rawEvent("pi.rpc.extension-ui", request.method, request),
      });
      if (request.method !== "editor" && request.timeout !== undefined) {
        yield* Effect.sleep(request.timeout).pipe(
          Effect.flatMap(() => {
            if (!context.pendingUserInputs.delete(requestId)) return Effect.void;
            return makeEventStamp().pipe(
              Effect.flatMap((timeoutStamp) =>
                offerRuntimeEvent({
                  ...timeoutStamp,
                  provider: PROVIDER,
                  providerInstanceId: boundInstanceId,
                  threadId: context.session.threadId,
                  ...(turnId ? { turnId } : {}),
                  requestId: runtimeRequestId,
                  type: "user-input.resolved",
                  payload: { answers: {} },
                }),
              ),
            );
          }),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

  const handleMessage = (
    context: PiSessionContext,
    message: PiStdoutMessage,
  ): Effect.Effect<void> => {
    switch (message._tag) {
      case "event":
        return handlePiEvent(context, message.event);
      case "extension-ui":
        return handleExtensionUIRequest(context, message.request);
      case "response":
        return Effect.void;
      case "unknown":
        return makeEventStamp().pipe(
          Effect.flatMap((stamp) =>
            offerRuntimeEvent({
              ...stamp,
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              type: "runtime.warning",
              payload: { message: message.reason, detail: message.payload },
            }),
          ),
        );
    }
  };

  // settle+clear pending extension-UI requests so Pi is never left blocked
  const cancelPendingExtensionRequests = (context: PiSessionContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [requestId, pending] of context.pendingApprovals) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            confirmed: false,
          }),
        );
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          type: "request.resolved",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: pending.requestType, decision: "decline" },
        });
      }
      context.pendingApprovals.clear();
      for (const [requestId, pending] of context.pendingUserInputs) {
        yield* Effect.ignore(
          context.transport.writeExtensionResponse({
            type: "extension_ui_response",
            id: pending.piId,
            cancelled: true,
          }),
        );
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          type: "user-input.resolved",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers: {} },
        });
      }
      context.pendingUserInputs.clear();
    });

  const stopSessionInternal = (
    context: PiSessionContext,
    opts?: {
      readonly emitExitEvent?: boolean;
      readonly exitKind?: "graceful" | "error";
      readonly reason?: string;
    },
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;

      if (context.turnState) {
        yield* completeTurn(context, "interrupted", "Session stopped.");
      }

      yield* cancelPendingExtensionRequests(context);

      if (context.notificationFiber) yield* Fiber.interrupt(context.notificationFiber);

      yield* Effect.ignore(Scope.close(context.sessionScope, Exit.void));

      const updatedAt = yield* nowIso;
      const { activeTurnId: _activeTurnId, ...closedSession } = context.session;
      context.session = { ...closedSession, status: "closed", updatedAt };
      sessions.delete(context.session.threadId);

      if (opts?.emitExitEvent !== false) {
        const exitKind = opts?.exitKind ?? "graceful";
        const reason =
          opts?.reason ??
          (exitKind === "error" ? "Pi process exited unexpectedly." : "Session stopped");
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...stamp,
          type: "session.exited",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: context.session.threadId,
          payload: {
            reason,
            exitKind,
            ...(exitKind === "error" ? { recoverable: false } : {}),
          },
        });
      }
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }));
    }
    return Effect.succeed(context);
  };

  // resolve attachments before mutating turn state so a bad one fails cleanly
  const resolvePromptImages = (
    attachments: ProviderSendTurnInput["attachments"],
  ): Effect.Effect<ReadonlyArray<PiImageContent>, ProviderAdapterError> =>
    Effect.forEach(attachments ?? [], (attachment) =>
      Effect.gen(function* () {
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "prompt",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "prompt",
                detail: `Failed to read attachment '${attachment.id}'.`,
                cause,
              }),
          ),
        );
        return piImageContentFromBytes({ mimeType: attachment.mimeType, bytes });
      }),
    );

  // switch only on change; fail closed (prompt not sent) on a bad slug or rejection
  const maybeSwitchPiModel = (
    context: PiSessionContext,
    requestedModel: string | undefined,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const plan = planPiModelSwitch(context.currentModel, requestedModel);
      if (plan.kind === "noop") return;
      if (plan.kind === "invalid") {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Invalid Pi model slug '${plan.slug}'; expected 'provider/id'.`,
        });
      }
      const response = yield* context.transport.request(
        { type: "set_model", provider: plan.provider, modelId: plan.modelId },
        `pi-set-model-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "set_model")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `Pi rejected model switch to '${plan.slug}'.`,
        });
      }
      context.currentModel = plan.slug;
      context.session = { ...context.session, model: plan.slug };
      // a model switch can reset the thinking level — force re-apply next turn
      context.appliedThinkingLevel = undefined;
    });

  const applyThinkingLevel = (
    context: PiSessionContext,
    modelSelection: ModelSelection | null | undefined,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const level = resolvePiThinkingLevel(modelSelection);
      if (level === undefined || level === context.appliedThinkingLevel) return;
      const response = yield* context.transport.request(
        { type: "set_thinking_level", level },
        `pi-set-thinking-${yield* nextUuid}`,
        PI_MODEL_OPTIONS_TIMEOUT_MS,
      );
      if (piResponseSucceeded(response, "set_thinking_level")) {
        context.appliedThinkingLevel = level;
      } else {
        yield* Effect.logWarning("pi.thinking.set-failed", {
          threadId: context.session.threadId,
          level,
        });
      }
    });

  const startSession: PiAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }

    const existing = sessions.get(input.threadId);
    if (existing) {
      yield* stopSessionInternal(existing, { emitExitEvent: false }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("pi.session.replace.stop-failed", { threadId: input.threadId, cause }),
        ),
      );
    }

    const startedAt = yield* nowIso;
    const threadId = input.threadId;
    const modelSelection =
      input.modelSelection !== undefined && input.modelSelection.instanceId === boundInstanceId
        ? input.modelSelection
        : undefined;
    const resumeState = readPiResumeState(input.resumeCursor);
    const cwd = input.cwd ?? serverConfig.cwd;
    const thinkingLevel = resolvePiThinkingLevel(modelSelection);

    const spawnArgs: string[] = ["--mode", "rpc"];
    if (resumeState) spawnArgs.push("--session", resumeState.sessionFile);
    if (modelSelection?.model) spawnArgs.push("--model", modelSelection.model);
    if (thinkingLevel) spawnArgs.push("--thinking", thinkingLevel);

    // gate driven by runtimeMode; if required, must be provably active or we fail closed
    const approvalGate = approvalGateForRuntimeMode(input.runtimeMode);
    let processEnv = baseEnvironment;
    let verifyApprovalGate = false;
    if (approvalGate.gate) {
      if (!approvalExtensionAvailable || !approvalExtensionPath) {
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is required for this runtime mode but the bundled approval gate is unavailable; refusing to start an ungated Pi session.",
        });
      }
      spawnArgs.push("--extension", approvalExtensionPath);
      processEnv = { ...baseEnvironment, T3_PI_APPROVAL_MODE: approvalGate.mode };
      verifyApprovalGate = true;
    }

    const sessionScope = yield* Scope.make();

    const makeTransport = options?.makeTransport ?? makePiRpcTransport;
    const transport = yield* makeTransport({
      binaryPath: piSettings.binaryPath || "pi",
      args: spawnArgs,
      cwd,
      env: processEnv,
      onExit: Effect.suspend(() => {
        const live = sessions.get(threadId);
        if (live && !live.stopped && live.session.status !== "closed") {
          return stopSessionInternal(live, { emitExitEvent: true, exitKind: "error" });
        }
        return Effect.void;
      }),
    }).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to start Pi RPC process."),
            cause,
          }),
      ),
      Effect.onError(() => Effect.ignore(Scope.close(sessionScope, Exit.void))),
    );

    const session: ProviderSession = {
      threadId,
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      status: "ready",
      runtimeMode: input.runtimeMode,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(modelSelection?.model ? { model: modelSelection.model } : {}),
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    const context: PiSessionContext = {
      session,
      sessionScope,
      transport,
      notificationFiber: undefined,
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      sessionApprovals: new Set(),
      turnState: undefined,
      agentActive: false,
      turns: [],
      extensionCommands: new Set(),
      stopped: false,
      currentModel: modelSelection?.model,
      appliedThinkingLevel: thinkingLevel,
    };
    sessions.set(threadId, context);

    const notificationFiber = yield* Stream.fromQueue(transport.messages).pipe(
      Stream.mapEffect((message) => handleMessage(context, message)),
      Stream.runDrain,
      Effect.catchCause((cause) =>
        Effect.logError("Failed to process Pi runtime message.", { cause }),
      ),
      Effect.forkIn(sessionScope),
    );
    context.notificationFiber = notificationFiber;

    const stateResponse = yield* transport.request(
      { type: "get_state" },
      `pi-get-state-${yield* nextUuid}`,
      PI_STATE_TIMEOUT_MS,
    );
    const sessionFile = extractSessionFile(stateResponse);
    if (sessionFile !== undefined) {
      context.session = { ...context.session, resumeCursor: { sessionFile } };
    }

    const commandsResponse = yield* transport.request(
      { type: "get_commands" },
      `pi-get-commands-${yield* nextUuid}`,
      PI_COMMANDS_TIMEOUT_MS,
    );
    updateDiscoveredCommands(context, commandsResponse);

    // fail closed unless the gate extension registered its sentinel command
    if (verifyApprovalGate) {
      if (!piResponseHasCommand(commandsResponse, PI_APPROVAL_SENTINEL_COMMAND)) {
        yield* stopSessionInternal(context, { emitExitEvent: false });
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId,
          detail:
            "Tool approval is enabled but the approval gate failed to load; refusing to run an ungated Pi session.",
        });
      }
    }

    const startedStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...startedStamp,
      type: "session.started",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {},
    });

    // session file is the provider-native thread id — publish for provider_thread_id parity
    if (sessionFile !== undefined) {
      const threadStartedStamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...threadStartedStamp,
        type: "thread.started",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId,
        payload: { providerThreadId: sessionFile },
      });
    }

    const configuredStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...configuredStamp,
      type: "session.configured",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: {
        config: {
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(input.cwd ? { cwd: input.cwd } : {}),
        },
      },
    });

    const readyStamp = yield* makeEventStamp();
    yield* offerRuntimeEvent({
      ...readyStamp,
      type: "session.state.changed",
      provider: PROVIDER,
      providerInstanceId: boundInstanceId,
      threadId,
      payload: { state: "ready" },
    });
    yield* syncPiSessionState(context);

    return { ...context.session };
  });

  const sendTurn: PiAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);

    const requestedModel =
      input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection.model : undefined;
    const promptText = typeof input.input === "string" ? input.input : "";
    // resolve before mutating turn state so a bad attachment fails cleanly
    const images = yield* resolvePromptImages(input.attachments);

    if (promptText.length === 0 && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Pi turns require non-empty text or at least one attachment.",
      });
    }

    // a message mid-turn steers the running turn; otherwise it opens a fresh one
    const isMidTurn = context.turnState !== undefined;

    // only on a fresh turn — changing options mid-stream would race the active turn
    if (!isMidTurn) {
      yield* maybeSwitchPiModel(context, requestedModel);
      yield* applyThinkingLevel(context, input.modelSelection);
    }

    if (!context.turnState) {
      const turnId = TurnId.make(yield* nextUuid);
      const startedAt = yield* nowIso;
      context.turnState = { turnId, startedAt, items: [] };
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: startedAt,
      };
      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "turn.started",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        turnId,
        payload: context.currentModel ? { model: context.currentModel } : {},
      });
    }

    const turnId = context.turnState.turnId;
    const extensionCommand = isPiExtensionCommand(promptText, context.extensionCommands);
    const command = buildPiTurnCommand({
      isMidTurn,
      isExtensionCommand: extensionCommand,
      message: promptText,
      images,
    });
    const response = yield* context.transport.request(
      command,
      `pi-${command.type}-${yield* nextUuid}`,
      PI_PROMPT_TIMEOUT_MS,
    );
    if (!piResponseSucceeded(response, command.type)) {
      yield* completeTurn(context, "failed", `Pi rejected the ${command.type} request.`);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: command.type,
        detail: `Pi rejected the ${command.type} request.`,
      });
    }
    if (extensionCommand) {
      const commandsResponse = yield* context.transport.request(
        { type: "get_commands" },
        `pi-refresh-commands-${yield* nextUuid}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      updateDiscoveredCommands(context, commandsResponse);
      if (!context.agentActive && context.turnState?.turnId === turnId) {
        yield* completeTurn(context, "completed");
      }
    }

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: PiAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
      // settle bridged requests so Pi isn't left blocked (matches Cursor)
      yield* cancelPendingExtensionRequests(context);
      if (context.turnState) {
        yield* completeTurn(context, "interrupted", "Turn interrupted.");
      }
    },
  );

  const compactThread: PiAdapterShape["compactThread"] = Effect.fn("compactThread")(
    function* (threadId) {
      const context = yield* requireSession(threadId);
      const response = yield* context.transport.request(
        buildPiCompactCommand(),
        `pi-compact-${yield* nextUuid}`,
        PI_PROMPT_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(response, "compact")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "compact",
          detail: "Pi rejected the compact request.",
        });
      }
    },
  );

  const respondToRequest: PiAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
    function* (threadId, requestId, decision: ProviderApprovalDecision) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}.`,
        });
      }
      context.pendingApprovals.delete(requestId);

      const response: RpcExtensionUIResponse = buildPiApprovalResponse(pending.piId, decision);
      yield* context.transport.writeExtensionResponse(response);
      if (decision === "acceptForSession") {
        context.sessionApprovals.add(pending.sessionApprovalKey);
      }

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "request.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType: pending.requestType, decision },
      });
    },
  );

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = Effect.fn("respondToUserInput")(
    function* (threadId, requestId, answers: ProviderUserInputAnswers) {
      const context = yield* requireSession(threadId);
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Unknown pending user-input request: ${requestId}.`,
        });
      }
      context.pendingUserInputs.delete(requestId);

      const response: RpcExtensionUIResponse = buildPiUserInputResponse(pending, answers);

      yield* context.transport.writeExtensionResponse(response);

      const stamp = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        ...stamp,
        type: "user-input.resolved",
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers },
      });
    },
  );

  const readThread: PiAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
    const context = yield* requireSession(threadId);
    return {
      threadId,
      turns: context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
    };
  });

  const rollbackThread: PiAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      const context = yield* requireSession(threadId);

      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      // forking mid-stream is undefined — abort/finalize any live turn first
      if (context.turnState) {
        yield* Effect.ignore(context.transport.writeCommand({ type: "abort" }));
        yield* cancelPendingExtensionRequests(context);
        yield* completeTurn(context, "interrupted", "Turn interrupted for rollback.");
      }

      const forkResponse = yield* context.transport.request(
        { type: "get_fork_messages" },
        `pi-fork-messages-${yield* nextUuid}`,
        PI_MESSAGES_TIMEOUT_MS,
      );
      if (!piResponseSucceeded(forkResponse, "get_fork_messages")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_fork_messages",
          detail: "Pi did not return forkable messages for rollback.",
        });
      }
      const userMessages = extractForkMessages(forkResponse);
      const target = resolveForkTargetEntryId(userMessages, numTurns);

      if (target === null) {
        // no known Pi history to fork against; just trim the local skeleton
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        return yield* readThread(threadId);
      }

      // fork branches before the target message; new_session resets past the first
      const rollbackResponse =
        target.kind === "fork"
          ? yield* context.transport.request(
              { type: "fork", entryId: target.entryId },
              `pi-fork-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            )
          : yield* context.transport.request(
              { type: "new_session" },
              `pi-new-session-${yield* nextUuid}`,
              PI_FORK_TIMEOUT_MS,
            );
      if (!piForkSucceeded(rollbackResponse)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: target.kind === "fork" ? "fork" : "new_session",
          detail: "Pi rejected or cancelled the rollback.",
        });
      }

      // CRITICAL: fork/new_session rebinds to a new session file — refresh the
      // resume cursor or a later reconnect resumes the stale pre-rollback branch
      const stateResponse = yield* context.transport.request(
        { type: "get_state" },
        `pi-get-state-${yield* nextUuid}`,
        PI_STATE_TIMEOUT_MS,
      );
      const sessionFile = extractSessionFile(stateResponse);
      const commandsResponse = yield* context.transport.request(
        { type: "get_commands" },
        `pi-post-fork-commands-${yield* nextUuid}`,
        PI_COMMANDS_TIMEOUT_MS,
      );
      updateDiscoveredCommands(context, commandsResponse);
      const updatedAt = yield* nowIso;
      context.session = {
        ...context.session,
        status: "ready",
        updatedAt,
        resumeCursor: sessionFile !== undefined ? { sessionFile } : undefined,
      };

      if (sessionFile !== undefined) {
        const threadStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          ...threadStartedStamp,
          type: "thread.started",
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload: { providerThreadId: sessionFile },
        });
      }

      context.turns.splice(Math.max(0, context.turns.length - numTurns));

      return yield* readThread(threadId);
    },
  );

  const stopSession: PiAdapterShape["stopSession"] = Effect.fn("stopSession")(function* (threadId) {
    const context = yield* requireSession(threadId);
    yield* stopSessionInternal(context, { emitExitEvent: true });
  });

  const listSessions: PiAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: PiAdapterShape["stopAll"] = () =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: true }),
      {
        discard: true,
      },
    );

  yield* Effect.addFinalizer(() =>
    Effect.forEach(
      sessions,
      ([, context]) => stopSessionInternal(context, { emitExitEvent: false }),
      {
        discard: true,
      },
    ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" as const, manualCompaction: true },
    startSession,
    sendTurn,
    interruptTurn,
    compactThread,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies PiAdapterShape;
});
