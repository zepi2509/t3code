import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";

import { makePiRpcTransport } from "./PiRpcClient.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })("Pi RPC transport", (it) => {
  it.effect(
    "waits past the acknowledgement deadline for human input and confirms process shutdown",
    () =>
      Effect.gen(function* () {
        const exited = yield* Deferred.make<void>();
        const transport = yield* makePiRpcTransport({
          binaryPath: process.execPath,
          cwd: process.cwd(),
          args: [
            "-e",
            `
          const readline = require('node:readline');
          let pending;
          readline.createInterface({ input: process.stdin }).on('line', (line) => {
            const message = JSON.parse(line);
            if (message.type === 'prompt') {
              pending = message;
              console.log(JSON.stringify({ type: 'extension_ui_request', id: 'human', method: 'input', title: 'Enter text' }));
            } else if (message.type === 'extension_ui_response') {
              console.log(JSON.stringify({ type: 'response', id: pending.id, command: 'prompt', success: true, data: { disposition: 'handled' } }));
            }
          });
        `,
          ],
          env: process.env,
          onExit: Deferred.succeed(exited, undefined).pipe(Effect.asVoid),
        });
        const prompt = yield* transport
          .request({ type: "prompt", message: "interactive" }, "prompt-human", 0, () => true)
          .pipe(Effect.forkChild);
        expect((yield* Queue.take(transport.messages))._tag).toBe("extension-ui");
        yield* transport.writeExtensionResponse({
          type: "extension_ui_response",
          id: "human",
          value: "answer",
        });
        expect(yield* Fiber.join(prompt)).toMatchObject({ command: "prompt", success: true });
        yield* transport.kill;
        yield* Deferred.await(exited);
        expect(yield* Deferred.isDone(exited)).toBe(true);
      }),
  );
});
