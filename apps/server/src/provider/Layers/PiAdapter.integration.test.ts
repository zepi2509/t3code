import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import type {
  AgentSessionEvent,
  PiRpcTransport,
  PiStdoutMessage,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./PiRpcClient.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");

const HarnessLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-integration-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakePiTransport {
  readonly transport: PiRpcTransport;
  readonly commands: Array<RpcCommand>;
  readonly extensionResponses: Array<RpcExtensionUIResponse>;
  readonly pushEvent: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly pushExtensionUI: (request: RpcExtensionUIRequest) => Effect.Effect<void>;
  readonly setResponse: (commandType: string, response: RpcResponse) => void;
}

const asResponse = (value: unknown): RpcResponse => value as RpcResponse;

const makeFakePiRpcTransport = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<PiStdoutMessage>();
  const commands: Array<RpcCommand> = [];
  const extensionResponses: Array<RpcExtensionUIResponse> = [];
  const responses = new Map<string, RpcResponse>();
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
    request: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return responses.get((command as { type: string }).type);
      }),
    messages,
    kill: Effect.void,
  };

  return {
    transport,
    commands,
    extensionResponses,
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

      const turn = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      expect(turn.turnId).toBeDefined();
      expect(fake.commands.some((c) => c.type === "prompt")).toBe(true);

      yield* fake.pushEvent({ type: "agent_start" } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
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
      const completed = events.find((event) => event.type === "turn.completed");
      if (completed && completed.type === "turn.completed") {
        expect(completed.payload.state).toBe("completed");
      }

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
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
