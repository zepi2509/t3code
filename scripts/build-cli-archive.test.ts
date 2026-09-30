import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { CliArchiveInputMissingError, stageCliArchiveAssets } from "./build-cli-archive.ts";

it.layer(NodeServices.layer)("CLI archive assets", (it) => {
  it.effect("preserves the Pi extension at the archive root through a tar round trip", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-assets-test-" });
        const serverDistDir = path.join(root, "dist");
        const stem = "t3-1.2.3-linux-x64";
        const contentDir = path.join(root, stem);
        const asset = "assets/pi/t3-approvals.ts";
        const source =
          "// Approval gate source, not a bundled module.\nexport default function approvals() {}\n";
        yield* fs.makeDirectory(path.dirname(path.join(serverDistDir, asset)), { recursive: true });
        yield* fs.writeFileString(path.join(serverDistDir, asset), source);
        yield* stageCliArchiveAssets({ serverDistDir, contentDir });
        assert.equal(yield* fs.readFileString(path.join(contentDir, asset)), source);
        assert.isFalse(yield* fs.exists(path.join(contentDir, "apps/server/dist")));

        const archive = path.join(root, "runtime.tar.gz");
        const extracted = path.join(root, "extracted");
        yield* fs.makeDirectory(extracted);
        for (const args of [
          ["-czf", archive, "-C", root, stem],
          ["-xzf", archive, "-C", extracted],
        ]) {
          const child = yield* spawner.spawn(ChildProcess.make("tar", args));
          assert.equal(Number(yield* child.exitCode), 0);
        }
        assert.equal(yield* fs.readFileString(path.join(extracted, stem, asset)), source);
      }),
    ),
  );

  for (const invalidInput of ["missing", "empty", "directory"] as const) {
    it.effect(`rejects a ${invalidInput} Pi extension before staging an archive`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cli-assets-test-" });
          const sourcePath = path.join(root, "dist/assets/pi/t3-approvals.ts");
          if (invalidInput === "directory") {
            yield* fs.makeDirectory(sourcePath, { recursive: true });
          } else if (invalidInput === "empty") {
            yield* fs.makeDirectory(path.dirname(sourcePath), { recursive: true });
            yield* fs.writeFileString(sourcePath, "");
          }
          const contentDir = path.join(root, "content");
          const error = yield* stageCliArchiveAssets({
            serverDistDir: path.join(root, "dist"),
            contentDir,
          }).pipe(Effect.flip);
          assert.instanceOf(error, CliArchiveInputMissingError);
          assert.equal(error.inputPath, sourcePath);
          assert.include(error.hint, "vp run --filter t3 build");
          assert.isFalse(yield* fs.exists(contentDir));
        }),
      ),
    );
  }
});
