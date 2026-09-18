import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { PiDriver } from "./PiDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest({ enableProviderUpdateChecks: false })),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Pi discovery must not make an HTTP request")),
    ),
  ),
);

const makeHarness = Effect.fn("makeHarness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-project-resources-" });
  const binaryPath = path.join(dir, "pi");
  const logPath = path.join(dir, "requests.log");
  yield* fs.writeFileString(logPath, "");
  yield* fs.writeFileString(
    binaryPath,
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const cwd = process.cwd();
const project = path.basename(cwd);
const home = process.env.PI_CODING_AGENT_DIR;
const log = (command) => fs.appendFileSync(process.env.PI_PROBE_LOG, command + "\\n");
if (process.argv.includes("--version")) {
  log("--version");
  console.log("pi 0.84.4");
  process.exit(0);
}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  log(request.type);
  const response = { type: "response", id: request.id, command: request.type, success: true };
  if (request.type === "get_available_models") {
    response.data = { models: [{ provider: "openai", id: "gpt-test" }] };
  } else if (fs.existsSync(path.join(cwd, "fail-discovery"))) {
    const failure = fs.readFileSync(path.join(cwd, "fail-discovery"), "utf8");
    if (failure === "exit") process.exit(0);
    response.success = failure === "malformed";
    response.error = "Discovery failed";
  } else {
    response.data = { commands: project === "empty" ? [] : [
      { name: "global", source: "extension", path: path.join(home, "extensions", "global.ts") },
      { name: project + "-review", source: "prompt", location: "project", path: path.join(cwd, ".pi", "prompts", "review.md") },
      { name: "skill:" + project, description: "Project skill", source: "skill", location: "project", path: path.join(cwd, ".pi", "skills", project, "SKILL.md") },
      { name: "compact", source: "extension", description: "Must not replace built-in" }
    ] };
  }
  console.log(JSON.stringify(response));
});
`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const create = Effect.fn("create")(function* (id = "pi-projects") {
    const instance = yield* PiDriver.create({
      instanceId: ProviderInstanceId.make(id),
      displayName: id,
      accentColor: "#123456",
      enabled: true,
      environment: [
        { name: "PI_CODING_AGENT_DIR", value: path.join(dir, id), sensitive: false },
        { name: "PI_PROBE_LOG", value: logPath, sensitive: false },
      ],
      config: { ...PiDriver.defaultConfig(), binaryPath, customModels: ["custom/model"] },
    });
    yield* instance.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.versionAdvisory !== undefined),
      Stream.runHead,
    );
    return instance;
  });
  const workspace = Effect.fn("workspace")(function* (name: string) {
    const cwd = path.join(dir, name);
    yield* fs.makeDirectory(cwd);
    return cwd;
  });
  return { fs, path, dir, logPath, create, workspace };
});

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

it.layer(testLayer)("PiDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "replaces project commands and skills without re-probing models or changing the machine snapshot",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const instance = yield* harness.create();
        const machine = yield* instance.snapshot.getSnapshot;
        expect(machine.status).toBe("ready");
        expect(machine.models.map((model) => model.slug)).toEqual([
          "openai/gpt-test",
          "custom/model",
        ]);

        for (const project of ["project-a", "project-b", "empty"]) {
          const cwd = yield* harness.workspace(project);
          const scoped = yield* instance.snapshotForCwd!(cwd);
          expect(scoped).toEqual({
            ...machine,
            slashCommands: scoped.slashCommands,
            skills: scoped.skills,
          });
          expect(scoped.models).toBe(machine.models);
          expect(scoped.slashCommands.filter((command) => command.name === "compact")).toEqual(
            machine.slashCommands.filter((command) => command.name === "compact"),
          );
          expect(scoped.slashCommands.map((command) => command.name)).toEqual(
            project === "empty" ? ["compact"] : ["compact", "global", `${project}-review`],
          );
          expect(scoped.skills).toEqual(
            project === "empty"
              ? []
              : [
                  {
                    name: project,
                    description: "Project skill",
                    shortDescription: "Project skill",
                    displayName: project,
                    enabled: true,
                    scope: "project",
                    path: harness.path.join(cwd, ".pi", "skills", project, "SKILL.md"),
                  },
                ],
          );
        }
        const after = yield* instance.snapshot.getSnapshot;
        expect(after.skills).toEqual(machine.skills);
        expect(after.slashCommands).toEqual(machine.slashCommands);
        expect((yield* harness.fs.readFileString(harness.logPath)).trim().split("\n")).toEqual([
          "--version",
          "get_available_models",
          "get_commands",
          "get_commands",
          "get_commands",
          "get_commands",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("uses each instance's environment for the same project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const cwd = yield* harness.workspace("project");
      for (const id of ["pi-one", "pi-two"]) {
        const instance = yield* harness.create(id);
        const snapshot = yield* instance.snapshotForCwd!(cwd);
        expect(snapshot.instanceId).toBe(id);
        expect(
          snapshot.slashCommands.find((command) => command.name === "global")?.sourcePath,
        ).toBe(harness.path.join(harness.dir, id, "extensions", "global.ts"));
      }
      expect((yield* harness.fs.readFileString(harness.logPath)).trim().split("\n")).toEqual([
        "--version",
        "get_available_models",
        "get_commands",
        "get_commands",
        "--version",
        "get_available_models",
        "get_commands",
        "get_commands",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "keeps failed discovery retryable instead of returning an empty catalog",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const cwd = yield* harness.workspace("project");
        const marker = harness.path.join(cwd, "fail-discovery");
        const instance = yield* harness.create();
        for (const failure of ["error", "malformed", "exit"]) {
          yield* harness.fs.writeFileString(marker, failure);
          const result = yield* instance.snapshotForCwd!(cwd).pipe(Effect.result);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              _tag: "ProviderDriverError",
              driver: "pi",
              instanceId: instance.instanceId,
            });
            expect(result.failure.detail).toContain(cwd);
          }
        }
        yield* harness.fs.remove(marker);
        expect((yield* instance.snapshotForCwd!(cwd)).skills.map((skill) => skill.name)).toEqual([
          "project",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("returns the disabled snapshot without spawning a workspace probe", () =>
    Effect.gen(function* () {
      const instance = yield* PiDriver.create({
        instanceId: ProviderInstanceId.make("pi-disabled"),
        displayName: undefined,
        enabled: false,
        environment: [],
        config: { ...PiDriver.defaultConfig(), enabled: true },
      });
      const machine = yield* instance.snapshot.getSnapshot;
      expect(machine.status).toBe("disabled");
      expect(yield* instance.snapshotForCwd!("/not/a/workspace")).toBe(machine);
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("Disabled Pi must not spawn a process")),
      ),
      Effect.scoped,
    ),
  );
});
