/** Typed JSONL transport + pure parsing helpers for `pi --mode rpc`. */
import type {
  AgentSessionEvent,
  ModelInfo,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelCapabilities,
  ModelSelection,
  ServerProviderModel,
  ServerProviderSkill,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSelectOptionDescriptor } from "../providerSnapshot.ts";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

export type PiAgentEvent =
  | AgentSessionEvent
  | {
      readonly type: "extension_error";
      readonly extensionPath: string;
      readonly event: string;
      readonly error: string;
    };

export type PiStdoutMessage =
  | { readonly _tag: "response"; readonly id: string | undefined; readonly response: RpcResponse }
  | { readonly _tag: "extension-ui"; readonly request: RpcExtensionUIRequest }
  | { readonly _tag: "event"; readonly event: PiAgentEvent }
  | {
      readonly _tag: "unknown";
      readonly payload: Record<string, unknown>;
      readonly reason: string;
    };

export function tryParsePiJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return null;
  }
  try {
    // eslint-disable-next-line no-restricted-syntax -- boundary parse of an untrusted JSONL line
    const value = JSON.parse(trimmed) as unknown; // @effect-diagnostics-ignore preferSchemaOverJson
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const PI_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "extension_error",
  // Pi 0.80.6 also emits these state/session events from AgentSession.
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function parseExtensionUIRequest(msg: Record<string, unknown>): RpcExtensionUIRequest | null {
  if (typeof msg["id"] !== "string" || typeof msg["method"] !== "string") return null;
  const method = msg["method"];
  const timeoutValid = msg["timeout"] === undefined || typeof msg["timeout"] === "number";
  if (!timeoutValid) return null;
  switch (method) {
    case "select":
      return typeof msg["title"] === "string" && isStringArray(msg["options"])
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "confirm":
      return typeof msg["title"] === "string" && typeof msg["message"] === "string"
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "input":
      return typeof msg["title"] === "string" &&
        (msg["placeholder"] === undefined || typeof msg["placeholder"] === "string")
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "editor":
      return typeof msg["title"] === "string" &&
        (msg["prefill"] === undefined || typeof msg["prefill"] === "string")
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "notify":
      return typeof msg["message"] === "string" &&
        (msg["notifyType"] === undefined ||
          msg["notifyType"] === "info" ||
          msg["notifyType"] === "warning" ||
          msg["notifyType"] === "error")
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "setStatus":
      return typeof msg["statusKey"] === "string" &&
        (msg["statusText"] === undefined || typeof msg["statusText"] === "string")
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "setWidget":
      return typeof msg["widgetKey"] === "string" &&
        (msg["widgetLines"] === undefined || isStringArray(msg["widgetLines"])) &&
        (msg["widgetPlacement"] === undefined ||
          msg["widgetPlacement"] === "aboveEditor" ||
          msg["widgetPlacement"] === "belowEditor")
        ? (msg as RpcExtensionUIRequest)
        : null;
    case "setTitle":
      return typeof msg["title"] === "string" ? (msg as RpcExtensionUIRequest) : null;
    case "set_editor_text":
      return typeof msg["text"] === "string" ? (msg as RpcExtensionUIRequest) : null;
    default:
      return null;
  }
}

function isValidPiEvent(msg: Record<string, unknown>, type: string): boolean {
  switch (type) {
    case "agent_start":
    case "agent_settled":
    case "turn_start":
      return true;
    case "agent_end":
      return Array.isArray(msg["messages"]) && typeof msg["willRetry"] === "boolean";
    case "turn_end":
      return isRecord(msg["message"]) && Array.isArray(msg["toolResults"]);
    case "message_start":
    case "message_end":
      return isRecord(msg["message"]);
    case "message_update":
      return isRecord(msg["message"]) && isRecord(msg["assistantMessageEvent"]);
    case "tool_execution_start":
      return typeof msg["toolCallId"] === "string" && typeof msg["toolName"] === "string";
    case "tool_execution_update":
      return (
        typeof msg["toolCallId"] === "string" &&
        typeof msg["toolName"] === "string" &&
        msg["partialResult"] !== undefined
      );
    case "tool_execution_end":
      return (
        typeof msg["toolCallId"] === "string" &&
        typeof msg["toolName"] === "string" &&
        typeof msg["isError"] === "boolean" &&
        msg["result"] !== undefined
      );
    case "queue_update":
      return isStringArray(msg["steering"]) && isStringArray(msg["followUp"]);
    case "compaction_start":
      return (
        msg["reason"] === "manual" || msg["reason"] === "threshold" || msg["reason"] === "overflow"
      );
    case "compaction_end":
      return (
        (msg["reason"] === "manual" ||
          msg["reason"] === "threshold" ||
          msg["reason"] === "overflow") &&
        typeof msg["aborted"] === "boolean" &&
        typeof msg["willRetry"] === "boolean"
      );
    case "auto_retry_start":
      return (
        typeof msg["attempt"] === "number" &&
        typeof msg["maxAttempts"] === "number" &&
        typeof msg["delayMs"] === "number" &&
        typeof msg["errorMessage"] === "string"
      );
    case "auto_retry_end":
      return typeof msg["success"] === "boolean" && typeof msg["attempt"] === "number";
    case "extension_error":
      return (
        typeof msg["extensionPath"] === "string" &&
        typeof msg["event"] === "string" &&
        typeof msg["error"] === "string"
      );
    case "entry_appended":
      return isRecord(msg["entry"]);
    case "session_info_changed":
      return msg["name"] === undefined || typeof msg["name"] === "string";
    case "thinking_level_changed":
      return typeof msg["level"] === "string";
    default:
      return false;
  }
}

export function classifyPiStdoutMessage(msg: Record<string, unknown>): PiStdoutMessage | null {
  const type = msg["type"];
  if (typeof type !== "string" || type.length === 0) return null;
  if (type === "response") {
    if (typeof msg["command"] !== "string" || typeof msg["success"] !== "boolean") {
      return { _tag: "unknown", payload: msg, reason: "Malformed Pi RPC response" };
    }
    return {
      _tag: "response",
      id: typeof msg["id"] === "string" ? msg["id"] : undefined,
      response: msg as unknown as RpcResponse,
    };
  }
  if (type === "extension_ui_request") {
    const request = parseExtensionUIRequest(msg);
    return request
      ? { _tag: "extension-ui", request }
      : { _tag: "unknown", payload: msg, reason: "Unknown or malformed Pi extension UI request" };
  }
  if (!PI_EVENT_TYPES.has(type)) {
    return { _tag: "unknown", payload: msg, reason: `Unknown Pi RPC event: ${type}` };
  }
  return isValidPiEvent(msg, type)
    ? { _tag: "event", event: msg as unknown as PiAgentEvent }
    : { _tag: "unknown", payload: msg, reason: `Malformed Pi RPC event: ${type}` };
}

export function parsePiStdoutLine(line: string): PiStdoutMessage | null {
  const msg = tryParsePiJsonObject(line.endsWith("\r") ? line.slice(0, -1) : line);
  return msg ? classifyPiStdoutMessage(msg) : null;
}

// only text_delta is user-visible; thinking/toolcall deltas leak raw json
export function extractAssistantTextDelta(event: PiAgentEvent): string | null {
  if (event.type !== "message_update") return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent || assistantEvent.type !== "text_delta") return null;
  return typeof assistantEvent.delta === "string" ? assistantEvent.delta : null;
}

export function extractReasoningTextDelta(event: PiAgentEvent): string | null {
  if (event.type !== "message_update") return null;
  const assistantEvent = event.assistantMessageEvent;
  if (!assistantEvent || assistantEvent.type !== "thinking_delta") return null;
  const delta = (assistantEvent as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : null;
}

// slugs are provider/id; keep any extra "/" in the id
export function splitPiModelSlug(slug: string): { provider: string; id: string } | null {
  const trimmed = slug.trim();
  const idx = trimmed.indexOf("/");
  if (idx <= 0 || idx >= trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, idx), id: trimmed.slice(idx + 1) };
}

export function piModelSlug(model: Pick<ModelInfo, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

// derived from RpcCommand so it tracks the installed package
export type PiImageContent = NonNullable<Extract<RpcCommand, { type: "prompt" }>["images"]>[number];

export type PiTurnCommand = Extract<
  RpcCommand,
  { type: "prompt" } | { type: "steer" } | { type: "follow_up" }
>;

// raw base64, not a data URL
export function piImageContentFromBytes(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): PiImageContent {
  return {
    type: "image",
    data: Buffer.from(input.bytes).toString("base64"),
    mimeType: input.mimeType,
  };
}

// mid-turn must "steer": a bare prompt is rejected while streaming and, being
// fire-and-forget, would be silently dropped
export function buildPiTurnCommand(args: {
  readonly isMidTurn: boolean;
  readonly isExtensionCommand?: boolean;
  readonly deliveryMode?: "steer" | "follow-up";
  readonly message: string;
  readonly images?: ReadonlyArray<PiImageContent>;
}): PiTurnCommand {
  const hasImages = args.images !== undefined && args.images.length > 0;
  const images = hasImages ? [...(args.images as ReadonlyArray<PiImageContent>)] : undefined;
  return args.isMidTurn && !args.isExtensionCommand
    ? {
        type: args.deliveryMode === "follow-up" ? "follow_up" : "steer",
        message: args.message,
        ...(images ? { images } : {}),
      }
    : { type: "prompt", message: args.message, ...(images ? { images } : {}) };
}

const PI_THINKING_LEVELS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;

export type PiThinkingLevel = Extract<RpcCommand, { type: "set_thinking_level" }>["level"];

export const PI_THINKING_OPTION_ID = "thinking";

export const PI_THINKING_LEVEL_VALUES = PI_THINKING_LEVELS.map(
  (level) => level.value,
) as ReadonlyArray<PiThinkingLevel>;

const PI_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(PI_THINKING_LEVEL_VALUES);

export function asPiThinkingLevel(value: string | undefined): PiThinkingLevel | undefined {
  return value !== undefined && PI_THINKING_LEVEL_SET.has(value)
    ? (value as PiThinkingLevel)
    : undefined;
}

export function resolvePiThinkingLevel(
  modelSelection: ModelSelection | null | undefined,
): PiThinkingLevel | undefined {
  return asPiThinkingLevel(
    getModelSelectionStringOptionValue(modelSelection, PI_THINKING_OPTION_ID),
  );
}

export type PiModelSwitchPlan =
  | { readonly kind: "noop" }
  | { readonly kind: "invalid"; readonly slug: string }
  | {
      readonly kind: "switch";
      readonly provider: string;
      readonly modelId: string;
      readonly slug: string;
    };

export function planPiModelSwitch(
  currentModel: string | undefined,
  requestedModel: string | undefined,
): PiModelSwitchPlan {
  if (requestedModel === undefined || requestedModel === currentModel) return { kind: "noop" };
  const parts = splitPiModelSlug(requestedModel);
  if (!parts) return { kind: "invalid", slug: requestedModel };
  return { kind: "switch", provider: parts.provider, modelId: parts.id, slug: requestedModel };
}

export function supportedPiThinkingLevels(
  model: Pick<ModelInfo, "reasoning"> & {
    readonly thinkingLevelMap?: Partial<Record<PiThinkingLevel, unknown>>;
  },
): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) return ["off"];
  return PI_THINKING_LEVEL_VALUES.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" ? true : mapped !== undefined;
  });
}

export function piModelCapabilities(model: ModelInfo): ModelCapabilities {
  const levels = supportedPiThinkingLevels(model);
  return createModelCapabilities({
    optionDescriptors: model.reasoning
      ? [
          buildSelectOptionDescriptor({
            id: "thinking",
            label: "Thinking",
            options: PI_THINKING_LEVELS.filter((level) => levels.includes(level.value)).map(
              (level) => ({ ...level }),
            ),
          }),
        ]
      : [],
  });
}

export function piModelInfoToServerModel(model: ModelInfo): ServerProviderModel {
  const slug = piModelSlug(model);
  const rawName = (model as unknown as { name?: unknown }).name;
  const name = typeof rawName === "string" && rawName.trim().length > 0 ? rawName.trim() : model.id;
  return {
    slug,
    name,
    isCustom: false,
    capabilities: piModelCapabilities(model),
  };
}

export function piResponseData(response: RpcResponse | undefined): Record<string, unknown> | null {
  if (!response || response.type !== "response" || response.success !== true) return null;
  const data = (response as { data?: unknown }).data;
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

export function extractSessionFile(response: RpcResponse | undefined): string | undefined {
  const sessionFile = piResponseData(response)?.["sessionFile"];
  return typeof sessionFile === "string" && sessionFile.trim().length > 0
    ? sessionFile.trim()
    : undefined;
}

export function extractAvailableModels(
  response: RpcResponse | undefined,
): ReadonlyArray<ModelInfo> {
  const models = piResponseData(response)?.["models"];
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const model = entry as Record<string, unknown>;
    if (typeof model["provider"] !== "string" || typeof model["id"] !== "string") return [];
    return [model as unknown as ModelInfo];
  });
}

export interface PiCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly path?: string;
  readonly scope?: string;
}

export function extractPiCommands(response: RpcResponse | undefined): ReadonlyArray<PiCommandInfo> {
  const commands = piResponseData(response)?.["commands"];
  if (!Array.isArray(commands)) return [];
  return commands.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const source = entry["source"];
    if (
      typeof entry["name"] !== "string" ||
      (source !== "extension" && source !== "prompt" && source !== "skill")
    )
      return [];
    const sourceInfo = isRecord(entry["sourceInfo"]) ? entry["sourceInfo"] : entry;
    return [
      {
        name: entry["name"],
        ...(typeof entry["description"] === "string" ? { description: entry["description"] } : {}),
        source,
        ...(typeof sourceInfo["path"] === "string" ? { path: sourceInfo["path"] } : {}),
        ...(typeof sourceInfo["scope"] === "string"
          ? { scope: sourceInfo["scope"] }
          : typeof sourceInfo["location"] === "string"
            ? { scope: sourceInfo["location"] }
            : {}),
      },
    ];
  });
}

export function piCommandsToProviderResources(commands: ReadonlyArray<PiCommandInfo>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: ServerProviderSlashCommand[] = [];
  const skills: ServerProviderSkill[] = [];
  for (const command of commands) {
    const metadata = {
      source: command.source,
      ...(command.path ? { sourcePath: command.path } : {}),
      ...(command.scope ? { sourceScope: command.scope } : {}),
    } as const;
    if (command.source === "skill") {
      const name = command.name.startsWith("skill:") ? command.name.slice(6) : command.name;
      if (name.length === 0) continue;
      skills.push({
        name,
        ...(command.description ? { description: command.description } : {}),
        path: command.path ?? `<pi-skill:${name}>`,
        ...(command.scope ? { scope: command.scope } : {}),
        enabled: true,
        displayName: name,
        ...(command.description ? { shortDescription: command.description } : {}),
      });
      continue;
    }
    slashCommands.push({
      name: command.name,
      ...(command.description ? { description: command.description } : {}),
      ...metadata,
    });
  }
  return { slashCommands, skills };
}

export function isPiExtensionCommand(message: string, commands: ReadonlySet<string>): boolean {
  const match = /^\/([^\s]+)/.exec(message.trimStart());
  return match?.[1] !== undefined && commands.has(match[1]);
}

// approval-gate handshake: the sentinel command's presence confirms the gate loaded
export function piResponseHasCommand(
  response: RpcResponse | undefined,
  commandName: string,
): boolean {
  const commands = piResponseData(response)?.["commands"];
  if (!Array.isArray(commands)) return false;
  return commands.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>)["name"] === commandName,
  );
}

export function extractLastAssistantText(response: RpcResponse | undefined): string | null {
  const text = piResponseData(response)?.["text"];
  return typeof text === "string" ? text : null;
}

// fail-closed: a timeout (undefined) or mismatched command counts as failure
export function piResponseSucceeded(response: RpcResponse | undefined, command: string): boolean {
  return (
    response !== undefined &&
    response.type === "response" &&
    response.success === true &&
    (response as { command?: unknown }).command === command
  );
}

// branch-scoped user messages (each with entryId) — the only valid fork targets
export function extractForkMessages(
  response: RpcResponse | undefined,
): ReadonlyArray<{ readonly entryId: string; readonly text: string }> {
  const messages = piResponseData(response)?.["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const entryId = record["entryId"];
    if (typeof entryId !== "string" || entryId.length === 0) return [];
    const text = typeof record["text"] === "string" ? (record["text"] as string) : "";
    return [{ entryId, text }];
  });
}

// fail-closed; both fork/new_session return { cancelled } on success
export function piForkSucceeded(response: RpcResponse | undefined): boolean {
  if (!response || response.type !== "response" || response.success !== true) return false;
  return piResponseData(response)?.["cancelled"] !== true;
}

// linear 1-user-message-per-turn mapping; mid-turn steers can under-drop (deferred)
export function resolveForkTargetEntryId(
  userMessages: ReadonlyArray<{ readonly entryId: string }>,
  numTurns: number,
): { readonly kind: "fork"; readonly entryId: string } | { readonly kind: "reset" } | null {
  if (numTurns <= 0 || userMessages.length === 0) return null;
  const targetIndex = userMessages.length - numTurns;
  if (targetIndex <= 0) return { kind: "reset" };
  return { kind: "fork", entryId: userMessages[targetIndex]!.entryId };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface PiRpcTransport {
  readonly writeCommand: (command: RpcCommand) => Effect.Effect<void>;
  readonly writeExtensionResponse: (response: RpcExtensionUIResponse) => Effect.Effect<void>;
  // sends a command and awaits its correlated response; times out to `undefined`
  readonly request: (
    command: RpcCommand,
    id: string,
    timeoutMs: number,
  ) => Effect.Effect<RpcResponse | undefined>;
  readonly messages: Queue.Dequeue<PiStdoutMessage>;
  readonly kill: Effect.Effect<void>;
}

export interface MakePiRpcTransportOptions {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onExit: Effect.Effect<void>;
}

export const makePiRpcTransport = (options: MakePiRpcTransportOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath || "pi", options.args, {
      env: options.env,
      extendEnv: true,
    });
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: options.cwd,
        env: options.env,
        extendEnv: true,
        shell: spawnCommand.shell,
        forceKillAfter: 5000,
      }),
    );

    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const messages = yield* Queue.unbounded<PiStdoutMessage>();
    const pendingRequests = new Map<string, Deferred.Deferred<RpcResponse>>();
    // resolved on process exit to unblock in-flight requests (fail fast, not full timeout)
    const closed = yield* Deferred.make<void>();

    const writeLine = (obj: RpcCommand | RpcExtensionUIResponse): Effect.Effect<void> =>
      Queue.offer(outgoing, Buffer.from(`${JSON.stringify(obj)}\n`)).pipe(Effect.asVoid);

    const handleLine = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = parsePiStdoutLine(line);
        if (!message) {
          yield* Effect.logWarning("Ignored malformed Pi RPC JSONL frame", { line });
          return;
        }
        if (message._tag === "unknown") {
          yield* Effect.logWarning(message.reason, { payload: message.payload });
          yield* Queue.offer(messages, message);
          return;
        }
        if (message._tag === "response") {
          if (message.id !== undefined) {
            const deferred = pendingRequests.get(message.id);
            if (deferred) {
              pendingRequests.delete(message.id);
              yield* Deferred.succeed(deferred, message.response);
              return;
            }
          }
          yield* Effect.logWarning("Unmatched Pi RPC response", {
            id: message.id,
            command: message.response.command,
          });
          return;
        }
        yield* Queue.offer(messages, message);
      });

    const onProcessExit = Deferred.succeed(closed, undefined).pipe(
      Effect.andThen(Queue.shutdown(messages)),
      Effect.andThen(Effect.sync(() => pendingRequests.clear())),
      Effect.andThen(options.onExit),
    );

    yield* Stream.fromQueue(outgoing).pipe(
      Stream.run(child.stdin),
      Effect.ignore,
      Effect.forkScoped,
    );

    // stderr drain (prevents the pipe from blocking)
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.mapAccumArray(
        () => "",
        (buffer, chunks) => {
          const records = `${buffer}${chunks.join("")}`.split("\n");
          return [records.pop() ?? "", records] as const;
        },
        { onHalt: (buffer) => (buffer.length > 0 ? [buffer] : []) },
      ),
      Stream.runForEach(handleLine),
      Effect.ignore,
      Effect.ensuring(onProcessExit),
      Effect.forkScoped,
    );

    const request = (
      command: RpcCommand,
      id: string,
      timeoutMs: number,
    ): Effect.Effect<RpcResponse | undefined> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<RpcResponse>();
        pendingRequests.set(id, deferred);
        yield* writeLine({ ...command, id });
        // resolve on response, process exit, or timeout — whichever comes first
        const outcome = yield* Deferred.await(deferred).pipe(
          Effect.map((response) => Option.some(response)),
          Effect.race(Deferred.await(closed).pipe(Effect.as(Option.none<RpcResponse>()))),
          Effect.timeoutOption(timeoutMs),
        );
        pendingRequests.delete(id);
        return outcome._tag === "None" ? undefined : Option.getOrUndefined(outcome.value);
      });

    const kill = child.kill().pipe(Effect.ignore);

    return {
      writeCommand: (command) => writeLine(command),
      writeExtensionResponse: (response) => writeLine(response),
      request,
      messages,
      kill,
    } satisfies PiRpcTransport;
  });

export type {
  AgentSessionEvent,
  ModelInfo,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
};
