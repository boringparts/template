import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const taskGatesPath = fileURLToPath(
  import.meta.resolve("@boringparts/reference-workspace-root/task-gates"),
);
const rootTaskGatesEntryPath = fileURLToPath(
  new URL("../scripts/task-gates.ts", import.meta.url),
);
const turboExecutablePath = fileURLToPath(import.meta.resolve("turbo"));
const defaultEntryCommand = "node --conditions=source scripts/task-gates.ts";

type CommandOutput = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly keepStdinOpen?: boolean;
    readonly timeoutMs?: number;
  },
): Promise<CommandOutput> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TURBO_CACHE_DIR: path.join(options.cwd, ".turbo", "cache"),
        TURBO_CACHE: "local:rw",
      },
      stdio: [
        options.keepStdinOpen === true ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString("utf8"));
    });
    child.once("error", (error) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      rejectPromise(error);
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.once("close", (exitCode) => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (
        options.keepStdinOpen === true &&
        child.stdin !== null &&
        !child.stdin.destroyed
      ) {
        child.stdin.destroy();
      }
      resolvePromise({
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        timedOut,
      });
    });
  });
}

function taskScript(label: string): string {
  return `node record.cjs ${label}`;
}

async function readRuns(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "runs.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((entry) => entry.length > 0);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function createWorkspace(
  options: {
    readonly failRootLight?: boolean;
    readonly failRootHeavy?: boolean;
    readonly readStdinInLight?: boolean;
    readonly readStdinInRepair?: boolean;
    readonly assertTurboStdinEof?: boolean;
    readonly withConditionalHeavyTask?: boolean;
  } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-task-gates-"));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts", "task-gates.ts"),
    await readFile(taskGatesPath),
  );
  await writeFile(
    path.join(root, "read-stdin.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const content = fs.readFileSync(0, "utf8");',
      'fs.appendFileSync(path.join(__dirname, "runs.log"), `${process.argv[2]}:${content.length}\\n`);',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "record.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'fs.appendFileSync(path.join(__dirname, "runs.log"), `${process.argv[2]}\\n`);',
      'if (process.argv[2].endsWith("-failure")) process.exitCode = 1;',
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "task-gates-fixture",
        private: true,
        type: "module",
        packageManager: "pnpm@12.21.0",
        scripts: {
          check: `${defaultEntryCommand} check`,
          "check:heavy": `${defaultEntryCommand} check:heavy`,
          "check:full": `${defaultEntryCommand} check:full`,
          fix: `${defaultEntryCommand} fix`,
          "format:check":
            options.readStdinInLight === true
              ? "node read-stdin.cjs root-light-stdin"
              : taskScript(
                  options.failRootLight === true
                    ? "root-light-failure"
                    : "root-light",
                ),
          "format:write":
            options.readStdinInRepair === true
              ? "node read-stdin.cjs root-repair-stdin"
              : taskScript("root-repair"),
          typecheck: taskScript("root-typecheck"),
          build: taskScript("root-build"),
          test: taskScript(
            options.failRootHeavy === true
              ? "root-heavy-failure"
              : "root-heavy",
          ),
          dev: taskScript("root-dev"),
          "inspect:cache": taskScript("root-on-demand"),
        },
        devDependencies: { turbo: "2.11.13" },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "pnpm-workspace.yaml"),
    'packages: ["packages/*"]\nverifyDepsBeforeRun: false\n',
  );
  await writeFile(
    path.join(root, "turbo.json"),
    JSON.stringify(
      {
        futureFlags: { experimentalTaskCommand: true },
        tags: ["task-gates-root"],
        tasks: {
          "//#check": { tags: ["quality:entry"] },
          "//#check:heavy": { tags: ["quality:entry"] },
          "//#check:full": { tags: ["quality:entry"] },
          "//#fix": { tags: ["work:repair"] },
          "//#format:check": { tags: ["quality:light"] },
          "//#format:write": { tags: ["work:repair"] },
          "//#typecheck": { tags: ["quality:light"] },
          "//#build": { tags: ["work:preparation"] },
          "//#test": { tags: ["quality:heavy"] },
          "//#dev": { tags: ["work:development"] },
          "//#inspect:cache": { tags: ["work:on-demand"] },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify(
      {
        name: "@task-gates/app",
        private: true,
        scripts: {
          build: "node ../../record.cjs package-build",
          "format:check": "node ../../record.cjs package-light",
          "format:write": "node ../../record.cjs package-repair",
          test: "node ../../record.cjs package-heavy",
          ...(options.withConditionalHeavyTask === true
            ? {
                "verify:conditional":
                  "node ../../record.cjs package-conditional",
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "packages", "app", "turbo.json"),
    JSON.stringify(
      {
        extends: ["//"],
        tags: ["task-gates-app"],
        tasks: {
          build: { dependsOn: [], tags: ["work:preparation"] },
          "format:check": { dependsOn: ["build"], tags: ["quality:light"] },
          "format:write": { dependsOn: [], tags: ["work:repair"] },
          test: {
            dependsOn: [],
            tags: ["quality:heavy"],
            ...(options.withConditionalHeavyTask === true
              ? { with: ["verify:conditional"] }
              : {}),
          },
          ...(options.withConditionalHeavyTask === true
            ? {
                "verify:conditional": {
                  dependsOn: [],
                  tags: ["quality:conditional"],
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
  );

  try {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    if (options.assertTurboStdinEof === true) {
      const turboShimPath = path.join(root, "node_modules", ".bin", "turbo");
      await writeFile(
        turboShimPath,
        [
          "#!/usr/bin/env node",
          'const { execFileSync } = require("node:child_process");',
          'const fs = require("node:fs");',
          'const stdinContent = fs.readFileSync(0, "utf8");',
          "if (stdinContent.length > 0) {",
          "  process.stderr.write(`unexpected stdin bytes: ${stdinContent.length}\\n`);",
          "  process.exit(99);",
          "}",
          "try {",
          `  execFileSync(${JSON.stringify(turboExecutablePath)}, process.argv.slice(2), { stdio: ["ignore", "inherit", "inherit"] });`,
          "} catch (error) {",
          "  process.exit(typeof error?.status === 'number' ? error.status : 1);",
          "}",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
    } else {
      await symlink(
        turboExecutablePath,
        path.join(root, "node_modules", ".bin", "turbo"),
      );
    }
    await writeFile(path.join(root, "runs.log"), "");
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return root;
}

async function addRootTask(
  root: string,
  name: string,
  tags?: readonly string[],
  dependsOn?: readonly string[],
): Promise<void> {
  const packagePath = path.join(root, "package.json");
  const parsedManifest: unknown = JSON.parse(
    await readFile(packagePath, "utf8"),
  );
  assert.ok(
    typeof parsedManifest === "object" &&
      parsedManifest !== null &&
      "scripts" in parsedManifest &&
      typeof parsedManifest.scripts === "object" &&
      parsedManifest.scripts !== null,
  );
  await writeFile(
    packagePath,
    JSON.stringify(
      {
        ...parsedManifest,
        scripts: {
          ...parsedManifest.scripts,
          [name]: taskScript(name),
        },
      },
      null,
      2,
    ),
  );

  if (tags !== undefined) {
    const turboPath = path.join(root, "turbo.json");
    const parsedTurbo: unknown = JSON.parse(await readFile(turboPath, "utf8"));
    assert.ok(
      typeof parsedTurbo === "object" &&
        parsedTurbo !== null &&
        "tasks" in parsedTurbo &&
        typeof parsedTurbo.tasks === "object" &&
        parsedTurbo.tasks !== null,
    );
    await writeFile(
      turboPath,
      JSON.stringify(
        {
          ...parsedTurbo,
          tasks: {
            ...parsedTurbo.tasks,
            [`//#${name}`]: {
              tags,
              ...(dependsOn === undefined ? {} : { dependsOn }),
            },
          },
        },
        null,
        2,
      ),
    );
  }
}

void describe("task-gates public gate entry", () => {
  void it("runs valid light, heavy, full, and fix scopes and rejects invalid CLI args", async () => {
    const root = await createWorkspace();
    try {
      for (const args of [[], ["unknown"], ["check", "extra"]]) {
        const usage = await runCommand(
          "node",
          ["--conditions=source", rootTaskGatesEntryPath, ...args],
          { cwd: path.dirname(path.dirname(rootTaskGatesEntryPath)) },
        );
        assert.equal(usage.exitCode, 2, usage.stderr);
        assert.equal(
          usage.stderr.trim(),
          `Usage: ${defaultEntryCommand} <check|check:heavy|check:full|fix>`,
        );
      }

      const check = await runCommand("pnpm", ["run", "check"], { cwd: root });
      assert.equal(check.exitCode, 0, check.stderr);
      const checkRuns = await readRuns(root);
      assert.deepStrictEqual(
        new Set(checkRuns),
        new Set([
          "package-build",
          "root-light",
          "root-typecheck",
          "package-light",
        ]),
      );
      assert.ok(
        checkRuns.indexOf("package-build") < checkRuns.indexOf("package-light"),
      );

      await writeFile(path.join(root, "runs.log"), "");
      const full = await runCommand("pnpm", ["run", "check:full"], {
        cwd: root,
      });
      assert.equal(full.exitCode, 0, full.stderr);
      const fullRuns = await readRuns(root);
      assert.ok(fullRuns.includes("root-heavy"));
      assert.ok(fullRuns.includes("package-heavy"));
      assert.ok(
        fullRuns.indexOf("root-light") < fullRuns.indexOf("root-heavy"),
      );

      await writeFile(path.join(root, "runs.log"), "");
      const fix = await runCommand("pnpm", ["run", "fix"], { cwd: root });
      assert.equal(fix.exitCode, 0, fix.stderr);
      assert.deepStrictEqual(
        new Set(await readRuns(root)),
        new Set(["root-repair", "package-repair"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("rejects missing, unknown, conflicting, reserved, or miswired scriptRole configurations", async () => {
    const missingRoot = await createWorkspace();
    try {
      await addRootTask(missingRoot, "verify:unclassified");
      const result = await runCommand("pnpm", ["run", "check"], {
        cwd: missingRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /\/\/#verify:unclassified is missing a unique role tag/u,
      );
      assert.deepStrictEqual(await readRuns(missingRoot), []);
    } finally {
      await rm(missingRoot, { recursive: true, force: true });
    }

    const unknownRoot = await createWorkspace();
    try {
      await addRootTask(unknownRoot, "verify:unknown", ["quality:unknown"]);
      const result = await runCommand("pnpm", ["run", "check"], {
        cwd: unknownRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /\/\/#verify:unknown uses unknown role tag quality:unknown/u,
      );
      assert.deepStrictEqual(await readRuns(unknownRoot), []);
    } finally {
      await rm(unknownRoot, { recursive: true, force: true });
    }

    const conflictingRoot = await createWorkspace();
    try {
      await addRootTask(conflictingRoot, "verify:conflicting", [
        "quality:light",
        "work:repair",
      ]);
      const result = await runCommand("pnpm", ["run", "check"], {
        cwd: conflictingRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /\/\/#verify:conflicting has multiple role tags/u,
      );
      assert.deepStrictEqual(await readRuns(conflictingRoot), []);
    } finally {
      await rm(conflictingRoot, { recursive: true, force: true });
    }

    const reservedRoot = await createWorkspace();
    try {
      await addRootTask(reservedRoot, "test:custom", ["work:repair"]);
      const result = await runCommand("pnpm", ["run", "check"], {
        cwd: reservedRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /\/\/#test:custom is a reserved verification task.*work:repair/u,
      );
      assert.deepStrictEqual(await readRuns(reservedRoot), []);
    } finally {
      await rm(reservedRoot, { recursive: true, force: true });
    }

    const transitiveRoot = await createWorkspace();
    try {
      await addRootTask(
        transitiveRoot,
        "verify:illegal",
        ["quality:light"],
        ["inspect:cache"],
      );
      const result = await runCommand("pnpm", ["run", "check"], {
        cwd: transitiveRoot,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /inspect:cache.*transitively triggering role work:on-demand is not allowed/u,
      );
      assert.deepStrictEqual(await readRuns(transitiveRoot), []);
    } finally {
      await rm(transitiveRoot, { recursive: true, force: true });
    }
  });

  void it("delivers immediate stdin EOF to child scripts during check and fix without hanging", async () => {
    const root = await createWorkspace({
      readStdinInLight: true,
      readStdinInRepair: true,
      assertTurboStdinEof: true,
    });
    try {
      const checkResult = await runCommand(
        "node",
        [
          "--conditions=source",
          path.join(root, "scripts/task-gates.ts"),
          "check",
        ],
        { cwd: root, keepStdinOpen: true, timeoutMs: 5000 },
      );
      assert.equal(
        checkResult.timedOut,
        false,
        `check hung waiting on stdin:\n${checkResult.stderr}`,
      );
      assert.equal(checkResult.exitCode, 0, checkResult.stderr);

      const fixResult = await runCommand(
        "node",
        [
          "--conditions=source",
          path.join(root, "scripts/task-gates.ts"),
          "fix",
        ],
        { cwd: root, keepStdinOpen: true, timeoutMs: 5000 },
      );
      assert.equal(
        fixResult.timedOut,
        false,
        `fix hung waiting on stdin:\n${fixResult.stderr}`,
      );
      assert.equal(fixResult.exitCode, 0, fixResult.stderr);

      const runs = await readRuns(root);
      assert.ok(runs.includes("root-light-stdin:0"), runs.join("\n"));
      assert.ok(runs.includes("root-repair-stdin:0"), runs.join("\n"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
