// @effect-diagnostics nodeBuiltinImport:off - Workflow regressions execute isolated Bash snippets with mocked GitHub CLI calls.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import { describe, expect, it } from "vite-plus/test";

const Step = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  with: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean, Schema.Number])),
  ),
});
const Workflow = fromYaml(
  Schema.Struct({
    jobs: Schema.Record(
      Schema.String,
      Schema.Struct({
        needs: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
        if: Schema.optional(Schema.String),
        outputs: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        steps: Schema.optional(Schema.Array(Step)),
      }),
    ),
  }),
);
const decodeWorkflow = Schema.decodeUnknownSync(Workflow);
const repoRoot = NodeURL.fileURLToPath(new URL("..", import.meta.url));
const release = decodeWorkflow(
  NodeFS.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
);
const desktop = decodeWorkflow(
  NodeFS.readFileSync(new URL("../.github/workflows/desktop-build.yml", import.meta.url), "utf8"),
);
const releaseDesktop = decodeWorkflow(
  NodeFS.readFileSync(new URL("../.github/workflows/release-desktop.yml", import.meta.url), "utf8"),
);

function interpolate(script: string, values: Readonly<Record<string, string>>) {
  return script.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Unexpected workflow expression: ${key}`);
    return value;
  });
}

function prepareDesktop(upstreamTag: string, forkTags = "", autoNightly = "") {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-workflow-test-"));
  const output = NodePath.join(root, "outputs");
  try {
    const script = desktop.jobs.prepare?.steps?.find((step) => step.id === "build")?.run;
    if (script === undefined) throw new Error("Missing desktop prepare script");
    NodeChildProcess.execFileSync(
      "bash",
      [
        "-e",
        "-c",
        `
      git() { printf '%s\\n' 'dec5cf59ed'; }
      gh() {
        if [[ "$*" == *pingdotgg* ]]; then
          printf '%s\\n' "$AUTO_NIGHTLY"
        else
          printf '%s\\n' "$FORK_TAGS"
        fi
      }
      ${interpolate(script, { "inputs.target": "all", "inputs.upstream_tag": upstreamTag })}
    `,
      ],
      {
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          FORK_TAGS: forkTags,
          AUTO_NIGHTLY: autoNightly,
        },
      },
    );
    return Object.fromEntries(
      NodeFS.readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("desktop release publishing", () => {
  it.each([
    ["v1.2.3", "1.2.3", "false", "true"],
    ["v1.2.3-nightly.20260601.4", "1.2.3-nightly.20260601.5", "true", "false"],
    ["v1.2.3-preview.20260601.4", "1.2.3-preview.20260601.4", "true", "false"],
    ["v1.2.3-pr.12.4", "1.2.3-pr.12.4", "true", "false"],
    ["v1.2.3-beta.1", "1.2.3-beta.1", "true", "false"],
  ])("publishes %s on the appropriate channel", (tag, version, prerelease, latest) => {
    const output = prepareDesktop(tag);
    expect(output.version).toBe(version);
    expect(output.tag).toBe(`v${version}`);
    expect(output.is_prerelease).toBe(prerelease);
    expect(output.make_latest).toBe(latest);
    for (const key of ["is_prerelease", "make_latest"]) {
      expect(desktop.jobs.prepare?.outputs?.[key]).toBe(`\${{ steps.build.outputs.${key} }}`);
    }
    const publish = desktop.jobs.publish?.steps?.find((step) =>
      step.uses?.startsWith("softprops/action-gh-release"),
    );
    expect(publish?.with?.prerelease).toBe("${{ needs.prepare.outputs.is_prerelease }}");
    expect(publish?.with?.make_latest).toBe("${{ needs.prepare.outputs.make_latest }}");
  });

  it("keeps automatic nightlies non-latest and advances past existing fork builds", () => {
    const output = prepareDesktop(
      "",
      "v1.2.3-nightly.20260601.8\nv1.2.3-nightly.20260531.99",
      "v1.2.3-nightly.20260601.4",
    );
    expect(output.version).toBe("1.2.3-nightly.20260601.9");
    expect(output.is_prerelease).toBe("true");
    expect(output.make_latest).toBe("false");
  });
});

describe("release packaging workflow", () => {
  it("the release builds same-arch Linux archives for Windows through the reusable workflow", () => {
    const workflowText = NodeFS.readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
    for (const arch of ["x64", "arm64"]) {
      expect(workflowText).toMatch(new RegExp(`desktop_linux_${arch}:[\\s\\S]*?cli_archive: true`));
      expect(workflowText).toMatch(new RegExp(`desktop_win_${arch}:[\\s\\S]*?cli_archive: true`));
    }
    for (const name of ["desktop_linux_x64", "desktop_linux_arm64", "desktop_win_x64", "desktop_win_arm64"]) {
      expect(release.jobs[name]?.needs).toContain("build_bundle");
      expect(workflowText).toMatch(new RegExp(`${name}:[\\s\\S]*?uses: \\.\\/\\.github\\/workflows\\/release-desktop\\.yml`));
    }
    const steps = releaseDesktop.jobs.build?.steps ?? [];
    const archive = steps.find((step) => step.name === "Build CLI archive");
    const smoke = steps.find((step) => step.name === "Smoke-test CLI archive");
    const upload = steps.find((step) => step.name === "Upload CLI archive");
    const wait = steps.find((step) => step.name === "Wait for Linux CLI archive");
    const download = steps.find((step) => step.name === "Download Linux CLI archive for WSL");
    expect(archive?.run).toContain('--arch "${{ inputs.arch }}"');
    expect(archive?.run).toContain('--version "${{ inputs.version }}"');
    expect(smoke?.run).toContain("scripts/smoke-cli-archive.ts");
    expect(upload?.with?.name).toBe("cli-${{ inputs.platform }}-${{ inputs.arch }}");
    expect(wait?.if).toBe("inputs.platform == 'win'");
    expect(wait?.run).toContain("$env:ARTIFACT");
    expect(download?.if).toBe("inputs.platform == 'win'");
    expect(download?.with?.name).toBe("cli-linux-${{ inputs.arch }}");
    expect(download?.with?.path).toBe("wsl-runtime");
    expect(steps.find((step) => step.name === "Build desktop artifact")?.run).toContain(
      '--wsl-runtime "$GITHUB_WORKSPACE"/wsl-runtime/t3-*-linux-${{ inputs.arch }}.tar.gz',
    );
  });

  it("the standalone desktop build hands Windows a Linux CLI archive accepted by the packager", () => {
      const workflow = desktop;
      const prepareJob = "prepare";
      const runtime = workflow.jobs.build_wsl_runtime;
      expect(workflow.jobs.build?.needs).toContain("build_wsl_runtime");
      const runtimeScript = runtime?.steps?.find(
        (step) => step.name === "Build Linux CLI runtime",
      )?.run;
      expect(runtimeScript).toContain("vp run --filter t3 build");
      expect(runtimeScript).toContain("cli.ts build-exe");
      expect(runtimeScript).toContain("scripts/build-cli-archive.ts --platform linux --arch x64");
      expect(runtimeScript).toContain(`--version "\${{ needs.${prepareJob}.outputs.version }}"`);
      expect(runtimeScript).toContain("scripts/smoke-cli-archive.ts");
      const upload = runtime?.steps?.find((step) =>
        step.uses?.startsWith("actions/upload-artifact"),
      );
      const download = workflow.jobs.build?.steps?.find(
        (step) => step.name === "Download WSL CLI runtime",
      );
      expect(download?.if).toBe("matrix.platform == 'win'");
      expect(download?.with?.name).toBe(upload?.with?.name);
      expect(upload?.with?.path).toBe("wsl-runtime/*.tar.gz");

      const buildScript = workflow.jobs.build?.steps?.find(
        (step) => step.name === "Build desktop artifact",
      )?.run;
      if (buildScript === undefined) throw new Error("Missing desktop build script");
      const log = NodeChildProcess.execFileSync(
        "bash",
        [
          "-e",
          "-c",
          `
        vp() { printf '%s\\n' "$@"; }
        ${interpolate(buildScript, {
          "matrix.platform": "win",
          "matrix.target": "nsis",
          "matrix.arch": "x64",
          [`needs.${prepareJob}.outputs.version`]: "1.2.3",
        })}
      `,
        ],
        {
          encoding: "utf8",
          env: { GITHUB_WORKSPACE: repoRoot, RUNNER_TEMP: NodeOS.tmpdir(), PATH: process.env.PATH },
        },
      );
      const args = log
        .trim()
        .split("\n")
        .slice(log.trim().split("\n").indexOf("dist:desktop:artifact") + 1);
      expect(args).toContain("--wsl-runtime");
      expect(args).not.toContain("--wsl-prebuild");
      expect(args[args.indexOf("--wsl-runtime") + 1]).toBe(
        `${repoRoot}/wsl-runtime/t3-1.2.3-linux-x64.tar.gz`,
      );
      // --help parses the real packager's flags without running a build.
      const help = NodeChildProcess.execFileSync(
        process.execPath,
        ["scripts/build-desktop-artifact.ts", ...args, "--help"],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(help).toContain("--wsl-runtime");
    });

  it("installs libsecret prerequisites before release tests and Linux desktop compilation", () => {
    for (const [steps, consumer] of [
      [release.jobs.test?.steps, "Test"],
      [release.jobs.build_bundle?.steps, "Build JS bundle"],
      [releaseDesktop.jobs.build?.steps, "Build desktop artifact"],
    ] as const) {
      const prerequisiteIndex = (steps ?? []).findIndex((step) =>
        step.run?.includes("apt-get install -y libsecret-1-dev pkg-config"),
      );
      expect(prerequisiteIndex).toBeGreaterThanOrEqual(0);
      expect(prerequisiteIndex).toBeLessThan(
        (steps ?? []).findIndex((step) => step.name === consumer),
      );
    }
    expect(
      releaseDesktop.jobs.build?.steps?.find((step) =>
        step.run?.includes("apt-get install -y libsecret-1-dev pkg-config"),
      )?.if,
    ).toBe("inputs.platform == 'linux'");
  });
});
