import * as NodeURL from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessExecutablePath, HostProcessIsExecutable } from "@t3tools/shared/hostProcess";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import type {
  PiAgentEvent as AgentSessionEvent,
  PiRpcTransport,
  PiStdoutMessage,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./PiRpcClient.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const encodeApprovalArguments = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ command: Schema.String })),
);
const PI = ProviderDriverKind.make("pi");

const HarnessLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-integration-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakePiTransport {
  readonly transport: PiRpcTransport;
  readonly commands: Array<RpcCommand>;
  readonly requestTimeouts: Array<{ readonly type: string; readonly timeoutMs: number }>;
  readonly extensionResponses: Array<RpcExtensionUIResponse>;
  readonly eventsBeforeResponse: Map<string, ReadonlyArray<AgentSessionEvent>>;
  readonly pushEvent: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly pushExtensionUI: (request: RpcExtensionUIRequest) => Effect.Effect<void>;
  readonly setResponse: (commandType: string, response: RpcResponse | undefined) => void;
}

const asResponse = (value: unknown): RpcResponse => value as RpcResponse;

const makeFakePiRpcTransport = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<PiStdoutMessage>();
  const commands: Array<RpcCommand> = [];
  const requestTimeouts: Array<{ type: string; timeoutMs: number }> = [];
  const extensionResponses: Array<RpcExtensionUIResponse> = [];
  const responses = new Map<string, RpcResponse | undefined>();
  const eventsBeforeResponse = new Map<string, ReadonlyArray<AgentSessionEvent>>();
  responses.set(
    "get_state",
    asResponse({
      type: "response",
      id: "x",
      command: "get_state",
      success: true,
      data: { sessionFile: "/tmp/pi-session.json" },
    }),
  );
  responses.set(
    "get_entries",
    asResponse({
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [], leafId: null },
    }),
  );
  responses.set(
    "get_session_stats",
    asResponse({
      type: "response",
      id: "x",
      command: "get_session_stats",
      success: true,
      data: {
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        toolCalls: 0,
      },
    }),
  );
  responses.set(
    "prompt",
    asResponse({ type: "response", id: "x", command: "prompt", success: true }),
  );
  responses.set(
    "steer",
    asResponse({ type: "response", id: "x", command: "steer", success: true }),
  );
  responses.set(
    "follow_up",
    asResponse({ type: "response", id: "x", command: "follow_up", success: true }),
  );
  responses.set(
    "clear_queue",
    asResponse({ type: "response", id: "x", command: "clear_queue", success: true }),
  );
  responses.set(
    "abort",
    asResponse({ type: "response", id: "x", command: "abort", success: true }),
  );
  responses.set(
    "get_commands",
    asResponse({
      type: "response",
      id: "x",
      command: "get_commands",
      success: true,
      data: { commands: [{ name: "t3-approval-gate", source: "extension" }] },
    }),
  );

  const transport: PiRpcTransport = {
    writeCommand: (command) =>
      Effect.sync(() => {
        commands.push(command);
      }),
    writeExtensionResponse: (response) =>
      Effect.sync(() => {
        extensionResponses.push(response);
      }),
    request: (command, _id, timeoutMs) =>
      Effect.gen(function* () {
        commands.push(command);
        requestTimeouts.push({ type: command.type, timeoutMs });
        for (const event of eventsBeforeResponse.get(command.type) ?? []) {
          yield* Queue.offer(messages, { _tag: "event", event });
        }
        return responses.get(command.type);
      }),
    messages,
    kill: Effect.void,
  };

  return {
    transport,
    commands,
    requestTimeouts,
    extensionResponses,
    eventsBeforeResponse,
    pushEvent: (event) => Queue.offer(messages, { _tag: "event", event }).pipe(Effect.asVoid),
    pushExtensionUI: (request) =>
      Queue.offer(messages, { _tag: "extension-ui", request }).pipe(Effect.asVoid),
    setResponse: (commandType, response) => {
      responses.set(commandType, response);
    },
  } satisfies FakePiTransport;
});

const makePiAdapterForTest = (settings: PiSettings) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePiRpcTransport;
    const adapter = yield* makePiAdapter(settings, {
      makeTransport: () => Effect.succeed(fake.transport),
    });
    return { adapter, fake } as const;
  });

const collectEvents = (
  adapter: PiAdapterShape,
  threadId: ThreadId,
  isTerminal: (event: ProviderRuntimeEvent) => boolean,
) =>
  Effect.gen(function* () {
    const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.takeUntil(isTerminal),
      Stream.runForEach((event) => Ref.update(store, (events) => [...events, event])),
      Effect.forkChild,
    );
    return { store, fiber } as const;
  });

const enabledSettings = (overrides: Record<string, unknown> = {}) =>
  decodePiSettings({ enabled: true, ...overrides });

it.layer(HarnessLayer)("PiAdapter integration", (it) => {
  it.effect("refreshes a changed native session before publishing turn completion", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePiRpcTransport;
      const syncStarted = yield* Deferred.make<void>();
      const nativeStateReady = yield* Deferred.make<RpcResponse>();
      let changedSession = false;
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: () =>
          Effect.succeed({
            ...fake.transport,
            request: (command, id, timeout) => {
              if (changedSession && command.type === "get_state") {
                return Deferred.succeed(syncStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(nativeStateReady)),
                );
              }
              return fake.transport.request(command, id, timeout);
            },
          }),
      });
      const threadId = ThreadId.make("pi-native-state-before-completion");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const turn = yield* adapter.sendTurn({ threadId, input: "native session change" });
      const done = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      changedSession = true;
      yield* fake.pushEvent({
        type: "agent_settled",
        messages: [],
        interrupted: false,
      } as AgentSessionEvent);
      yield* Deferred.await(syncStarted);
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(turn.turnId);
      yield* Deferred.succeed(
        nativeStateReady,
        asResponse({
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionFile: "/tmp/pi-changed-session.json" },
        }),
      );
      yield* Fiber.join(done.fiber);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
        sessionFile: "/tmp/pi-changed-session.json",
      });
    }),
  );

  it.effect("does not overwrite native work starting during a boundary snapshot", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-snapshot-race");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const started = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.started",
      );
      fake.eventsBeforeResponse.set("get_entries", [
        { type: "agent_start" },
        {
          type: "entry_appended",
          entry: { id: "background", parentId: null, type: "message", message: { role: "user" } },
        },
        { type: "turn_start" },
      ] as AgentSessionEvent[]);
      const turn = yield* adapter.sendTurn({ threadId, input: "redirect background work" });
      yield* Fiber.join(started.fiber);
      expect(turn.turnId).toBe(
        (yield* Ref.get(started.store)).find((event) => event.type === "turn.started")?.turnId,
      );
      expect(fake.commands.at(-1)).toMatchObject({
        type: "steer",
        message: "redirect background work",
      });
      expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(turn.turnId);
    }),
  );

  it.effect(
    "records independent native turns and refuses continuations without a forkable boundary",
    () =>
      Effect.gen(function* () {
        for (const hasUserEntry of [true, false]) {
          const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
          const threadId = ThreadId.make(`pi-background-boundary-${hasUserEntry}`);
          yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
          const original = yield* adapter.sendTurn({ threadId, input: "A" });
          const firstDone = yield* collectEvents(
            adapter,
            threadId,
            (event) => event.type === "turn.completed",
          );
          yield* fake.pushEvent({
            type: "entry_appended",
            entry: {
              id: "after-A",
              type: "message",
              parentId: "A",
              message: { role: "assistant" },
            },
          } as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "agent_settled",
            messages: [],
            interrupted: false,
          } as AgentSessionEvent);
          yield* Fiber.join(firstDone.fiber);
          const backgroundDone = yield* collectEvents(
            adapter,
            threadId,
            (event) => event.type === "turn.completed",
          );
          yield* fake.pushEvent({ type: "agent_start" } as AgentSessionEvent);
          if (hasUserEntry)
            yield* fake.pushEvent({
              type: "entry_appended",
              entry: {
                id: "B",
                parentId: "after-A",
                type: "message",
                message: { role: "user" },
              },
            } as AgentSessionEvent);
          yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "agent_settled",
            messages: [],
            interrupted: false,
          } as AgentSessionEvent);
          yield* Fiber.join(backgroundDone.fiber);
          fake.setResponse(
            "get_entries",
            asResponse({
              type: "response",
              command: "get_entries",
              success: true,
              data: {
                leafId: "B",
                entries: [
                  { id: "B", parentId: "after-A", type: "message", message: { role: "user" } },
                ],
              },
            }),
          );
          fake.setResponse(
            "fork",
            asResponse({ type: "response", command: "fork", success: true }),
          );
          const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
          if (hasUserEntry) {
            expect(Result.isSuccess(result)).toBe(true);
            expect(fake.commands).toContainEqual({ type: "fork", entryId: "B" });
            expect((yield* adapter.readThread(threadId)).turns.map((turn) => turn.id)).toEqual([
              original.turnId,
            ]);
          } else {
            expect(Result.isFailure(result)).toBe(true);
            expect(
              fake.commands.some(
                (command) => command.type === "fork" || command.type === "new_session",
              ),
            ).toBe(false);
          }
        }
      }),
  );

  it.effect("stops a timed-out manual compaction before reporting failure", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-compact-timeout");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const compaction = adapter.compaction;
      if (compaction?.type !== "native") throw new Error("missing compaction");
      fake.setResponse("compact", undefined);
      expect(Result.isFailure(yield* compaction.start(threadId).pipe(Effect.result))).toBe(true);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("allows human dialogs to outlast compaction and rewind acknowledgement deadlines", () =>
    Effect.gen(function* () {
      for (const operation of ["compact", "fork"] as const) {
        const fake = yield* makeFakePiRpcTransport;
        const answered = yield* Deferred.make<void>();
        const deadlineReached = yield* Deferred.make<void>();
        const adapter = yield* makePiAdapter(enabledSettings(), {
          makeTransport: () =>
            Effect.succeed({
              ...fake.transport,
              writeExtensionResponse: (response) =>
                fake.transport
                  .writeExtensionResponse(response)
                  .pipe(Effect.andThen(Deferred.succeed(answered, undefined)), Effect.asVoid),
              request: (command, id, timeout, waitForInput) => {
                if (command.type !== operation) return fake.transport.request(command, id, timeout);
                return Effect.gen(function* () {
                  yield* fake.pushExtensionUI({
                    type: "extension_ui_request",
                    id: "human-hook",
                    method: "input",
                    title: "Confirm context",
                  });
                  const drained = yield* Deferred.make<void>();
                  yield* Queue.offer(fake.transport.messages, { _tag: "drain", deferred: drained });
                  yield* Deferred.await(drained);
                  // Reach the deadline while the callback still awaits the client.
                  const waiting = waitForInput?.() === true;
                  yield* Deferred.succeed(deadlineReached, undefined);
                  if (!waiting) return undefined;
                  yield* Deferred.await(answered);
                  return asResponse({ type: "response", command: operation, success: true });
                });
              },
            }),
        });
        const threadId = ThreadId.make(`pi-human-hook-${operation}`);
        yield* adapter.startSession({
          threadId,
          provider: PI,
          runtimeMode: "full-access",
          resumeCursor: {
            sessionFile: "/tmp/pi-session.json",
            turnStartEntryIds: ["prior"],
            lastEntryId: "prior",
          },
        });
        fake.setResponse(
          "get_entries",
          asResponse({
            type: "response",
            command: "get_entries",
            success: true,
            data: {
              leafId: "user",
              entries: [
                { id: "user", parentId: "prior", type: "message", message: { role: "user" } },
              ],
            },
          }),
        );
        const question = yield* collectEvents(
          adapter,
          threadId,
          (event) => event.type === "user-input.requested",
        );
        const compaction = adapter.compaction;
        if (compaction?.type !== "native") throw new Error("missing compaction");
        const action = yield* (
          operation === "compact" ? compaction.start(threadId) : adapter.rollbackThread(threadId, 1)
        ).pipe(Effect.asVoid, Effect.result, Effect.forkChild);
        yield* Fiber.join(question.fiber);
        const request = (yield* Ref.get(question.store)).find(
          (event) => event.type === "user-input.requested",
        );
        if (request?.type !== "user-input.requested") throw new Error("missing question");
        yield* Deferred.await(deadlineReached);
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(request.requestId!), {
          [request.payload.questions[0]!.id]: "continue",
        });
        expect(Result.isSuccess(yield* Fiber.join(action))).toBe(true);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect(fake.extensionResponses).toContainEqual({
          type: "extension_ui_response",
          id: "human-hook",
          value: "continue",
        });
      }
    }),
  );

  it.effect("materializes a binary archive's approval asset as a readable external extension", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-binary-asset-test-" });
      const source = NodeURL.fileURLToPath(
        new URL("../assets/pi/t3-approvals.ts", import.meta.url),
      );
      const bundled = path.join(directory, "assets/pi/t3-approvals.ts");
      yield* fs.makeDirectory(path.dirname(bundled), { recursive: true });
      yield* fs.copyFile(source, bundled);
      const fake = yield* makeFakePiRpcTransport;
      let extension: string | undefined;
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: (options) => {
          extension = options.args[options.args.indexOf("--extension") + 1];
          return Effect.succeed(fake.transport);
        },
      }).pipe(
        Effect.provideService(HostProcessIsExecutable, true),
        Effect.provideService(HostProcessExecutablePath, path.join(directory, "t3")),
      );
      yield* adapter.startSession({
        threadId: ThreadId.make("pi-binary-asset"),
        provider: PI,
        runtimeMode: "approval-required",
      });
      expect(extension).toBeDefined();
      expect(extension).not.toBe(bundled);
      expect(yield* fs.readFileString(extension!)).toBe(yield* fs.readFileString(source));
    }),
  );

  it.effect("rejects unsupported Plan mode before issuing a prompt", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-plan-mode");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const result = yield* adapter
        .sendTurn({ threadId, input: "plan", interactionMode: "plan" })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(fake.commands.some((command) => command.type === "prompt")).toBe(false);
    }),
  );

  it.effect("stops native execution before reporting an unacknowledged prompt as failed", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePiRpcTransport;
      const killStarted = yield* Deferred.make<void>();
      const killed = yield* Deferred.make<void>();
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: () =>
          Effect.succeed({
            ...fake.transport,
            kill: Deferred.succeed(killStarted, undefined).pipe(
              Effect.andThen(Deferred.await(killed)),
            ),
          }),
      });
      const threadId = ThreadId.make("pi-ack-timeout");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "session.exited",
      );
      fake.setResponse("prompt", undefined);
      const submit = yield* adapter
        .sendTurn({ threadId, input: "never acknowledged" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(killStarted);
      expect(
        (yield* Ref.get(collected.store)).some((event) => event.type === "turn.completed"),
      ).toBe(false);
      yield* Deferred.succeed(killed, undefined);
      expect(Result.isFailure(yield* Fiber.join(submit))).toBe(true);
      yield* Fiber.join(collected.fiber);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(
        (yield* Ref.get(collected.store)).some(
          (event) => event.type === "turn.completed" && event.payload.state === "failed",
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "completes ordinary input consumed by an extension without leaving a running turn",
    () =>
      Effect.gen(function* () {
        for (const disposition of ["handled", undefined]) {
          const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
          const threadId = ThreadId.make(`pi-input-handled-${disposition ?? "legacy"}`);
          yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
          fake.setResponse(
            "prompt",
            asResponse({
              type: "response",
              command: "prompt",
              success: true,
              data: { disposition },
            }),
          );
          fake.setResponse(
            "get_state",
            asResponse({
              type: "response",
              command: "get_state",
              success: true,
              data: { sessionFile: "/tmp/pi-session.json", isStreaming: false },
            }),
          );
          const collected = yield* collectEvents(
            adapter,
            threadId,
            (event) => event.type === "turn.completed",
          );
          yield* adapter.sendTurn({ threadId, input: "ordinary extension input" });
          yield* Fiber.join(collected.fiber);
          const session = (yield* adapter.listSessions())[0];
          expect(session?.status).toBe("ready");
          expect(session?.activeTurnId).toBeUndefined();
        }
      }),
  );

  it.effect(
    "keeps a legacy extension command running when native activity starts during reconciliation",
    () =>
      Effect.gen(function* () {
        const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
        const threadId = ThreadId.make("pi-command-starting-work");
        fake.setResponse(
          "get_commands",
          asResponse({
            type: "response",
            command: "get_commands",
            success: true,
            data: {
              commands: [
                { name: "busy-command", source: "extension" },
                { name: "t3-approval-gate", source: "extension" },
              ],
            },
          }),
        );
        yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
        fake.setResponse(
          "get_state",
          asResponse({
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionFile: "/tmp/pi-session.json", isStreaming: true },
          }),
        );
        fake.eventsBeforeResponse.set("get_state", [{ type: "agent_start" } as AgentSessionEvent]);
        const turn = yield* adapter.sendTurn({ threadId, input: "/busy-command" });
        expect((yield* adapter.listSessions())[0]?.activeTurnId).toBe(turn.turnId);
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
      }),
  );

  it.effect("interrupts manual compaction even when no conversation turn is active", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-stop-manual-compaction");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "full-access" });
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "session.state.changed" && event.payload.state === "waiting",
      );
      yield* fake.pushEvent({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
      yield* Fiber.join(collected.fiber);
      const ready = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      );
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(ready.fiber);
      expect(fake.commands.slice(-2).map((command) => command.type)).toEqual([
        "clear_queue",
        "abort",
      ]);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }),
  );

  it.effect(
    "rewinds all steering messages with their T3 turn and persists the native boundary",
    () =>
      Effect.gen(function* () {
        const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
        const threadId = ThreadId.make("pi-native-rewind-boundary");
        const cursor = {
          sessionFile: "/tmp/pi-session.json",
          turnStartEntryIds: ["before"],
          lastEntryId: "before",
        };
        yield* adapter.startSession({
          threadId,
          provider: PI,
          runtimeMode: "full-access",
          resumeCursor: cursor,
        });
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(cursor);
        fake.setResponse(
          "get_entries",
          asResponse({
            type: "response",
            command: "get_entries",
            success: true,
            data: {
              leafId: "steer",
              entries: [
                { id: "prompt", parentId: "before", type: "message", message: { role: "user" } },
                { id: "steer", parentId: "prompt", type: "message", message: { role: "user" } },
              ],
            },
          }),
        );
        fake.setResponse("fork", asResponse({ type: "response", command: "fork", success: true }));
        fake.setResponse(
          "get_state",
          asResponse({
            type: "response",
            command: "get_state",
            success: true,
            data: { sessionFile: "/tmp/pi-rewound.json" },
          }),
        );
        yield* adapter.rollbackThread(threadId, 1);
        expect(fake.commands).toContainEqual({ type: "fork", entryId: "prompt" });
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual({
          sessionFile: "/tmp/pi-rewound.json",
        });
        yield* adapter.stopSession(threadId);
        const resumed = yield* adapter.startSession({
          threadId,
          provider: PI,
          runtimeMode: "full-access",
          resumeCursor: { sessionFile: "/tmp/pi-rewound.json" },
        });
        expect(resumed.resumeCursor).toEqual({ sessionFile: "/tmp/pi-rewound.json" });
      }),
  );

  it.effect("fails and stops instead of accepting a fork without a new session cursor", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-unknown-fork-cursor");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        runtimeMode: "full-access",
        resumeCursor: {
          sessionFile: "/tmp/pi-session.json",
          turnStartEntryIds: [null],
          lastEntryId: null,
        },
      });
      fake.setResponse(
        "new_session",
        asResponse({ type: "response", command: "new_session", success: true }),
      );
      fake.setResponse("get_state", undefined);
      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "rollbackThread",
        });
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("reports usage once across internal turns and resets it for the next T3 turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-turn-usage");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      for (let index = 0; index < 2; index++) {
        const collected = yield* collectEvents(
          adapter,
          threadId,
          (event) => event.type === "turn.completed",
        );
        yield* adapter.sendTurn({ threadId, input: "private prompt", attachments: [] });
        const message = {
          role: "assistant",
          content: [],
          stopReason: "toolUse",
          usage: {
            input: 10,
            output: 3,
            cacheRead: 20,
            cacheWrite: 5,
            totalTokens: 38,
            cost: { total: 123 },
          },
        };
        if (index === 0) {
          yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
          yield* fake.pushEvent({ type: "message_start", message } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({ type: "message_end", message } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({ type: "message_end", message } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "turn_end",
            message,
            toolResults: [],
          } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "agent_end",
            messages: [message],
            willRetry: true,
          } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "compaction_end",
            reason: "overflow",
            result: { summary: "private summary", tokensBefore: 500, usage: message.usage },
            aborted: false,
            willRetry: true,
          } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "message_end",
            message: { ...message, role: "toolResult" },
          } as unknown as AgentSessionEvent);
          yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
          yield* fake.pushEvent({
            type: "message_end",
            message: { ...message, stopReason: "stop" },
          } as unknown as AgentSessionEvent);
        }
        yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);
        yield* Fiber.join(collected.fiber);
        const events = yield* Ref.get(collected.store);
        const completed = events.find((event) => event.type === "turn.completed");
        expect(completed?.payload.tokenUsage).toEqual(
          index === 0
            ? {
                usageScope: "main_agent",
                usageStatus: "complete",
                hasSubagents: false,
                inputTokens: 70,
                outputTokens: 6,
                cachedInputTokens: 40,
                cacheCreationTokens: 10,
              }
            : { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false },
        );
        expect(completed?.raw).toBeUndefined();
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      }
    }),
  );

  it.effect("drains message endings queued before the abort response before reporting usage", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-interrupt-usage-drain");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "inspect", attachments: [] });
      fake.eventsBeforeResponse.set("abort", [
        { type: "turn_start" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "aborted",
            usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 5 },
          },
        },
      ] as unknown as AgentSessionEvent[]);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(collected.fiber);
      const events = yield* Ref.get(collected.store);
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: {
          state: "interrupted",
          tokenUsage: { usageStatus: "partial", inputTokens: 35, outputTokens: 3 },
        },
      });
    }),
  );

  it.effect("starts a session, streams assistant text, and completes the turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-basic");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      expect(session.provider).toBe("pi");
      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toEqual({ sessionFile: "/tmp/pi-session.json" });
      expect(fake.requestTimeouts.slice(0, 2)).toEqual([
        { type: "get_state", timeoutMs: 30_000 },
        { type: "get_commands", timeoutMs: 30_000 },
      ]);

      const turn = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      expect(turn.turnId).toBeDefined();
      expect(fake.commands.some((c) => c.type === "prompt")).toBe(true);

      yield* fake.pushEvent({ type: "agent_start" } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Checking files" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
          ],
        },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const types = events.map((event) => event.type);
      expect(types).toContain("session.started");
      expect(types).toContain("turn.started");

      const delta = events.find((event) => event.type === "content.delta");
      expect(delta).toBeDefined();
      if (delta && delta.type === "content.delta") {
        expect(delta.payload.streamKind).toBe("assistant_text");
        expect(delta.payload.delta).toBe("hi");
        expect(delta.raw?.source).toBe("pi.rpc.event");
      }
      const assistantCompleted = events.filter(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "assistant_message",
      );
      expect(assistantCompleted).toHaveLength(1);
      expect(assistantCompleted[0]).toMatchObject({
        payload: { detail: "hi", status: "completed" },
      });
      const completed = events.find((event) => event.type === "turn.completed");
      if (completed && completed.type === "turn.completed") {
        expect(completed.payload.state).toBe("completed");
      }

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("fails a turn when Pi exhausts retries with an assistant error", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-provider-error");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "fail", attachments: [] });
      yield* fake.pushEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider quota exhausted",
        },
      } as unknown as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "auto_retry_end",
        success: false,
        finalError: "provider quota exhausted",
        attempt: 3,
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: { state: "failed", errorMessage: "provider quota exhausted" },
      });
    }),
  );

  it.effect("does not send file attachments through Pi's image field", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-file-attachment");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "read the attached file path from the prompt",
        attachments: [
          {
            type: "file",
            id: "pi-file-attachment",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
          },
        ],
      });

      expect(fake.commands.findLast((command) => command.type === "prompt")).toEqual({
        type: "prompt",
        message: "read the attached file path from the prompt",
      });
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores cumulative token totals while post-compaction usage is unknown", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "get_session_stats",
        asResponse({
          type: "response",
          command: "get_session_stats",
          success: true,
          data: {
            tokens: { input: 80_000, output: 20_000, cacheRead: 0, cacheWrite: 0, total: 100_000 },
            contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
            toolCalls: 2,
          },
        }),
      );
      const threadId = ThreadId.make("pi-int-null-context-usage");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "thread.metadata.updated",
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "after compaction", attachments: [] });
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "session_info_changed", name: "done" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(false);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("finishes manual compaction without leaving the session waiting", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "compact",
        asResponse({ type: "response", command: "compact", success: true }),
      );
      const threadId = ThreadId.make("pi-int-compact");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "thread.state.changed",
      );

      const compaction = adapter.compaction;
      if (compaction?.type !== "native") throw new Error("Pi must support native compaction");
      yield* compaction.start(threadId);
      yield* fake.pushEvent({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "compaction_end",
        reason: "manual",
        result: {
          summary: "Compacted",
          firstKeptEntryId: "entry-1",
          tokensBefore: 100_000,
          estimatedTokensAfter: 10_000,
        },
        aborted: false,
        willRetry: false,
      } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session.state.changed",
          payload: { state: "ready" },
        }),
      );
      expect(events.some((event) => event.type === "thread.state.changed")).toBe(true);
      expect(fake.requestTimeouts.find((request) => request.type === "compact")?.timeoutMs).toBe(
        180_000,
      );
    }),
  );

  it.effect("does not report an aborted compaction as successful", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-compact-aborted");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "session.state.changed" && event.payload.state === "ready",
      );

      yield* fake.pushEvent({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "compaction_end",
        reason: "manual",
        aborted: true,
        willRetry: false,
      } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      expect(events.some((event) => event.type === "thread.state.changed")).toBe(false);
    }),
  );

  it.effect("keeps internal extension state out of the work log and composer", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-extension-state");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "search", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "entry_appended",
        entry: {
          type: "custom",
          customType: "web-search-results",
          data: { urls: [] },
        },
      } as AgentSessionEvent);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "async-state",
        method: "set_editor_text",
        text: '\u001b[0mPI_SUBAGENT_ASYNC_JSON:{"kind":"pi-subagents.async-status-snapshot"}',
      } as RpcExtensionUIRequest);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      expect(events.some((event) => event.type === "runtime.warning")).toBe(false);
      expect(events.some((event) => event.type === "provider.ui")).toBe(false);
    }),
  );

  it.effect("surfaces extension failures without poisoning the Pi session", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-extension-error");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "search", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "extension_error",
        extensionPath: "/tmp/web-search.ts",
        event: "tool_result",
        error: "Fetch failed",
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const warning = events.find((event) => event.type === "runtime.warning");
      expect(warning?.payload.message).toBe("Pi extension error: Fetch failed");
      expect(events.some((event) => event.type === "runtime.error")).toBe(false);
    }),
  );

  it.effect("maps thinking_delta to a reasoning_text content delta", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-reasoning");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "why" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const reasoning = events.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      expect(reasoning).toBeDefined();
    }),
  );

  it.effect("does not finalize on agent_end; completion waits for agent_settled", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-retry");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "retry please", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: true,
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      } as AgentSessionEvent);
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(collected.store)).some((event) => event.type === "turn.completed"),
      ).toBe(false);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const completions = events.filter((event) => event.type === "turn.completed");
      expect(completions).toHaveLength(1);
      const completed = completions[0];
      if (completed && completed.type === "turn.completed") {
        expect(completed.payload.state).toBe("completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps a tool execution lifecycle to item events", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-tool");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run ls", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
        partialResult: {
          content: [{ type: "text", text: "accumulated" }],
          details: { progress: 50 },
        },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: "file.txt",
        isError: false,
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const started = events.find((event) => event.type === "item.started");
      const updated = events.find((event) => event.type === "item.updated");
      const completed = events.find((event) => event.type === "item.completed");
      expect(started).toBeDefined();
      expect(updated?.payload.data).toMatchObject({
        partialResult: {
          content: [{ type: "text", text: "accumulated" }],
          details: { progress: 50 },
        },
      });
      expect(completed).toBeDefined();
      if (started && started.type === "item.started") {
        expect(started.payload.itemType).toBe("command_execution");
      }
    }),
  );

  it.effect("clears Pi's queue, awaits abort, and closes an in-flight tool on interrupt", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-interrupt");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const toolStarted = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.completed"),
        Stream.runForEach((event) =>
          Ref.update(store, (events) => [...events, event]).pipe(
            Effect.andThen(
              event.type === "item.started"
                ? Deferred.succeed(toolStarted, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "run forever", attachments: [] });
      yield* fake.pushEvent({
        type: "tool_execution_start",
        toolCallId: "interrupt-tool",
        toolName: "bash",
        args: { command: "sleep 100" },
      } as AgentSessionEvent);
      yield* Deferred.await(toolStarted);

      const commandCount = fake.commands.length;
      yield* adapter.interruptTurn(threadId, TurnId.make("stale-turn"));
      expect(fake.commands).toHaveLength(commandCount);
      yield* adapter.interruptTurn(threadId, turn.turnId);

      const events = yield* Fiber.join(fiber).pipe(Effect.flatMap(() => Ref.get(store)));
      expect(fake.commands.slice(-2).map((command) => command.type)).toEqual([
        "clear_queue",
        "abort",
      ]);
      expect(
        events.find(
          (event) => event.type === "item.completed" && event.itemId === "interrupt-tool",
        ),
      ).toMatchObject({ payload: { status: "failed" } });
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: { state: "interrupted" },
      });
    }),
  );

  it.effect("stops an older Pi session when its RPC cannot clear queued messages", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "clear_queue",
        asResponse({
          type: "response",
          command: "clear_queue",
          success: false,
          error: "Unknown command: clear_queue",
        }),
      );
      const threadId = ThreadId.make("pi-int-legacy-interrupt");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "run forever", attachments: [] });

      yield* adapter.interruptTurn(threadId, turn.turnId);

      expect(yield* adapter.hasSession(threadId)).toBe(false);
      expect(fake.commands.some((command) => command.type === "abort")).toBe(false);
    }),
  );

  it.effect("bridges a confirm request to an approval round-trip", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-approval");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const resolved = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(store, (events) => [...events, event]);
            if (event.type === "request.opened" && event.requestId !== undefined) {
              yield* Deferred.succeed(opened, ApprovalRequestId.make(String(event.requestId))).pipe(
                Effect.ignore,
              );
            }
            if (event.type === "request.resolved") {
              yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "edit file", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: "[t3-tool-approval] Run bash?",
        message: "ls -la",
      } as RpcExtensionUIRequest);

      const requestId = yield* Deferred.await(opened);
      yield* adapter.respondToRequest(threadId, requestId, "accept");
      yield* Deferred.await(resolved);
      yield* Fiber.interrupt(fiber);

      const events = yield* Ref.get(store);
      const requestOpened = events.find((event) => event.type === "request.opened");
      expect(requestOpened).toBeDefined();
      if (requestOpened && requestOpened.type === "request.opened") {
        expect(requestOpened.raw?.source).toBe("pi.rpc.extension-ui");
      }
      expect(fake.extensionResponses).toContainEqual({
        type: "extension_ui_response",
        id: "ui-1",
        confirmed: true,
      });
    }),
  );

  it.effect("session approvals distinguish complete arguments and tool names", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-complete-approval-identity");
      yield* adapter.startSession({ threadId, provider: PI, runtimeMode: "approval-required" });
      const requests = yield* Queue.unbounded<ProviderRuntimeEvent>();
      yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId && event.type === "request.opened"),
        Stream.runForEach((event) => Queue.offer(requests, event)),
        Effect.forkChild,
      );
      const command = `${"x".repeat(3000)}; echo first`;
      const approve = Effect.fn(function* (id: string, title: string, value: string) {
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id,
          method: "confirm",
          title,
          message: encodeApprovalArguments({ command: value }),
        });
        const request = yield* Queue.take(requests);
        expect(request.type).toBe("request.opened");
        if (request.type !== "request.opened") throw new Error("missing approval");
        expect(request.payload.args).toMatchObject({ command: value });
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(request.requestId!),
          "acceptForSession",
        );
      });
      yield* approve("long-first", "[t3-tool-approval] Run bash?", command);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "same",
        method: "confirm",
        title: "[t3-tool-approval] Run bash?",
        message: encodeApprovalArguments({ command }),
      });
      const drained = yield* Deferred.make<void>();
      yield* Queue.offer(fake.transport.messages, { _tag: "drain", deferred: drained });
      yield* Deferred.await(drained);
      expect(fake.extensionResponses).toContainEqual({
        type: "extension_ui_response",
        id: "same",
        confirmed: true,
      });
      yield* approve(
        "long-second",
        "[t3-tool-approval] Run bash?",
        `${"x".repeat(3000)}; echo second`,
      );
      yield* approve("other-tool", "[t3-tool-approval] Run shell?", command);
    }),
  );

  it.effect("bridges a select request to a user-input round-trip", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-userinput");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const resolved = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(store, (events) => [...events, event]);
            if (event.type === "user-input.requested" && event.requestId !== undefined) {
              yield* Deferred.succeed(opened, ApprovalRequestId.make(String(event.requestId))).pipe(
                Effect.ignore,
              );
            }
            if (event.type === "user-input.resolved") {
              yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "pick one", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "ui-2",
        method: "select",
        title: "Choose an option",
        options: ["Option A", "Option B"],
      } as RpcExtensionUIRequest);

      const requestId = yield* Deferred.await(opened);
      const events0 = yield* Ref.get(store);
      const requested = events0.find((event) => event.type === "user-input.requested");
      expect(requested).toBeDefined();
      if (requested && requested.type === "user-input.requested") {
        const questionId = requested.payload.questions[0]?.id;
        expect(questionId).toBeDefined();
        yield* adapter.respondToUserInput(threadId, requestId, {
          [String(questionId)]: "Option A",
        });
      }
      yield* Deferred.await(resolved);
      yield* Fiber.interrupt(fiber);

      expect(
        fake.extensionResponses.some(
          (response) => "value" in response && response.value === "Option A",
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "bridges every RPC extension UI method without turning normal confirm into approval",
    () =>
      Effect.gen(function* () {
        const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
        const threadId = ThreadId.make("pi-int-all-extension-ui");
        const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
        const ready = yield* Deferred.make<void>();
        const fiber = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) =>
            Ref.updateAndGet(store, (events) => [...events, event]).pipe(
              Effect.flatMap((events) => {
                const dialogs = events.filter(
                  (entry) => entry.type === "user-input.requested",
                ).length;
                const effects = events.filter((entry) => entry.type === "provider.ui").length;
                return dialogs === 4 && effects === 5
                  ? Deferred.succeed(ready, undefined).pipe(Effect.ignore)
                  : Effect.void;
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* adapter.startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });

        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "select",
          method: "select",
          title: "Pick",
          options: ["A", "B"],
          timeout: 1000,
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "confirm",
          method: "confirm",
          title: "Clear session?",
          message: "All messages will be lost.",
          timeout: 2000,
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "input",
          method: "input",
          title: "Name",
          placeholder: "Ada",
          timeout: 3000,
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "editor",
          method: "editor",
          title: "Edit",
          prefill: "line 1\nline 2",
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "notify",
          method: "notify",
          message: "Heads up",
          notifyType: "warning",
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "status",
          method: "setStatus",
          statusKey: "ext",
          statusText: "running",
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "widget",
          method: "setWidget",
          widgetKey: "ext",
          widgetLines: ["one", "two"],
          widgetPlacement: "belowEditor",
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "title",
          method: "setTitle",
          title: "Pi title",
        });
        yield* fake.pushExtensionUI({
          type: "extension_ui_request",
          id: "editor-text",
          method: "set_editor_text",
          text: "composer text",
        });
        yield* Deferred.await(ready);

        const events = yield* Ref.get(store);
        expect(events.some((event) => event.type === "request.opened")).toBe(false);
        const dialogs = events.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "user-input.requested" }> =>
            event.type === "user-input.requested",
        );
        expect(dialogs.map((event) => event.payload.questions[0]?.inputKind)).toEqual([
          "select",
          "confirm",
          "input",
          "editor",
        ]);
        expect(dialogs[1]?.payload.questions[0]).toMatchObject({
          title: "Clear session?",
          message: "All messages will be lost.",
          timeoutMs: 2000,
        });
        expect(dialogs[2]?.payload.questions[0]).toMatchObject({ placeholder: "Ada" });
        expect(dialogs[3]?.payload.questions[0]).toMatchObject({
          prefill: "line 1\nline 2",
          multiline: true,
        });

        const answers: ReadonlyArray<unknown> = ["B", "No", "Ada Lovelace", null];
        for (let index = 0; index < dialogs.length; index += 1) {
          const dialog = dialogs[index]!;
          const questionId = dialog.payload.questions[0]!.id;
          yield* adapter.respondToUserInput(
            threadId,
            ApprovalRequestId.make(String(dialog.requestId)),
            { [questionId]: answers[index] },
          );
        }
        expect(fake.extensionResponses).toEqual([
          { type: "extension_ui_response", id: "select", value: "B" },
          { type: "extension_ui_response", id: "confirm", confirmed: false },
          { type: "extension_ui_response", id: "input", value: "Ada Lovelace" },
          { type: "extension_ui_response", id: "editor", cancelled: true },
        ]);
        const effects = events.flatMap((event) =>
          event.type === "provider.ui" ? [event.payload.effect] : [],
        );
        expect(effects.map((effect) => effect.method)).toEqual([
          "notify",
          "setStatus",
          "setWidget",
          "setTitle",
          "set_editor_text",
        ]);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect("fails closed when the approval gate does not load", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "get_commands",
        asResponse({
          type: "response",
          id: "x",
          command: "get_commands",
          success: true,
          data: { commands: [] },
        }),
      );
      const threadId = ThreadId.make("pi-int-failclosed");
      const result = yield* adapter
        .startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure.message)).toMatch(/approval gate|ungated/i);
      }
    }),
  );

  it.effect("rejects a full-access session when the RPC startup handshake fails", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "get_state",
        asResponse({
          type: "response",
          command: "get_state",
          success: false,
          error: "process unavailable",
        }),
      );
      const threadId = ThreadId.make("pi-int-startup-handshake");

      const result = yield* adapter
        .startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure.message)).toContain("get_state startup handshake");
      }
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("rejects startSession when the provider does not match", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-mismatch");
      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("fails the active turn and emits session.exited before process scope teardown", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePiRpcTransport;
      let processExit: Effect.Effect<void> | undefined;
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: (input) =>
          Effect.sync(() => {
            processExit = input.onExit;
            return fake.transport;
          }),
      });
      const threadId = ThreadId.make("pi-int-process-exit");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const toolStarted = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "session.exited"),
        Stream.runForEach((event) =>
          Ref.update(store, (events) => [...events, event]).pipe(
            Effect.andThen(
              event.type === "item.started"
                ? Deferred.succeed(toolStarted, undefined).pipe(Effect.ignore)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run", attachments: [] });
      yield* fake.pushEvent({
        type: "tool_execution_start",
        toolCallId: "exit-tool",
        toolName: "bash",
        args: { command: "sleep 100" },
      } as AgentSessionEvent);
      yield* Deferred.await(toolStarted);
      yield* processExit!;

      const events = yield* Fiber.join(fiber).pipe(Effect.flatMap(() => Ref.get(store)));
      expect(events.find((event) => event.type === "item.completed")).toMatchObject({
        payload: { status: "failed" },
      });
      expect(events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: { state: "failed", errorMessage: "Pi process exited unexpectedly." },
      });
      expect(events.at(-1)?.type).toBe("session.exited");
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("keeps a replacement session when the previous Pi process exits late", () =>
    Effect.gen(function* () {
      const fakes: FakePiTransport[] = [];
      const exits: Array<Effect.Effect<void>> = [];
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: (input) =>
          makeFakePiRpcTransport.pipe(
            Effect.tap((fake) =>
              Effect.sync(() => {
                fake.setResponse(
                  "get_state",
                  asResponse({
                    type: "response",
                    command: "get_state",
                    success: true,
                    data: { sessionFile: `/tmp/pi-session-${fakes.length + 1}.json` },
                  }),
                );
                fakes.push(fake);
              }),
            ),
            Effect.tap(() => Effect.sync(() => exits.push(input.onExit))),
            Effect.map((fake) => fake.transport),
          ),
      });
      const threadId = ThreadId.make("pi-int-replace");

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const replacement = yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* exits[0]!;

      expect(yield* adapter.hasSession(threadId)).toBe(true);
      expect(replacement.resumeCursor).toEqual({ sessionFile: "/tmp/pi-session-2.json" });
    }),
  );

  it.effect("invokes extension commands with prompt even while Pi is streaming", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "get_commands",
        asResponse({
          type: "response",
          command: "get_commands",
          success: true,
          data: { commands: [{ name: "hello", source: "extension" }] },
        }),
      );
      const threadId = ThreadId.make("pi-int-extension-command");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* fake.pushEvent({ type: "agent_start" } as AgentSessionEvent);
      const second = yield* adapter.sendTurn({ threadId, input: "/hello now", attachments: [] });
      expect(second.turnId).toBe(first.turnId);
      expect(fake.commands.at(-2)).toMatchObject({ type: "prompt", message: "/hello now" });
      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);
    }),
  );

  it.effect("steers a running turn instead of opening a second turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-steer");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      const second = yield* adapter.sendTurn({ threadId, input: "steer me", attachments: [] });
      expect(second.turnId).toBe(first.turnId);
      yield* fake.pushEvent({
        type: "queue_update",
        steering: ["steer me"],
        followUp: ["after this"],
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "queue_update",
        steering: [],
        followUp: [],
      } as AgentSessionEvent);

      yield* fake.pushEvent({ type: "agent_settled" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const turnStarts = events.filter((event) => event.type === "turn.started");
      expect(turnStarts.length).toBe(1);
      expect(fake.commands.some((command) => command.type === "steer")).toBe(true);
      const queueWidgets = events.filter(
        (event) =>
          event.type === "provider.ui" &&
          event.payload.effect.method === "setWidget" &&
          event.payload.effect.widgetKey === "pi-follow-up-queue",
      );
      expect(queueWidgets).toHaveLength(2);
      expect(queueWidgets[0]).toMatchObject({
        payload: {
          effect: { widgetLines: ["Queued messages", "1. after this"] },
        },
      });
      expect(queueWidgets[1]).toMatchObject({
        payload: {
          effect: { method: "setWidget", widgetKey: "pi-follow-up-queue" },
        },
      });
    }),
  );

  it.effect("queues a follow-up when explicitly requested mid-turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-follow-up");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      const second = yield* adapter.sendTurn({
        threadId,
        input: "after this",
        attachments: [],
        deliveryMode: "follow-up",
      });

      expect(second.turnId).toBe(first.turnId);
      expect(fake.commands.at(-1)).toMatchObject({ type: "follow_up", message: "after this" });
    }),
  );
});
