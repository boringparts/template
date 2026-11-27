import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { execa } from "execa";

const taskGatesPath = fileURLToPath(
  import.meta.resolve("@boringparts/reference-workspace-root/task-gates"),
);
const turboExecutablePath = fileURLToPath(import.meta.resolve("turbo"));
const gateEntries = [
  {
    label: "template direct entry",
    scriptPath: taskGatesPath,
    command: "node --conditions=source scripts/task-gates.ts",
  },
  {
    label: "source wrapper entry",
    scriptPath: fileURLToPath(
      new URL("../scripts/run-task-gate.ts", import.meta.url),
    ),
    command: "node --conditions=source scripts/run-task-gate.ts",
  },
];

function taskScript(gate: string): string {
  return `node record.cjs ${gate}`;
}

function workspaceProcessOptions(root: string) {
  return {
    cwd: root,
    env: {
      ...process.env,
      TURBO_CACHE_DIR: path.join(root, ".turbo", "cache"),
      TURBO_CACHE: "local:rw",
    },
  };
}

async function readRuns(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "runs.log"), "utf8"))
      .trim()
      .split("\n")
      .filter((run) => run.length > 0);
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
    readonly entryCommand?: string;
    readonly invalidCheckCustom?: boolean;
    readonly commandOnlyTask?: boolean;
    readonly failRootLight?: boolean;
    readonly waitRootLight?: boolean;
    readonly failRootHeavy?: boolean;
    readonly withConditionalHeavyTask?: boolean;
    readonly reportConditionalTask?: boolean;
  } = {},
): Promise<string> {
  const entryCommand =
    options.entryCommand ?? "node --conditions=source scripts/task-gates.ts";
  const root = await mkdtemp(path.join(os.tmpdir(), "template-task-gates-"));
  await mkdir(path.join(root, "packages", "app"), { recursive: true });
  await mkdir(path.join(root, "scripts"));
  await writeFile(
    path.join(root, "scripts", "task-gates.ts"),
    await readFile(taskGatesPath),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "task-gates-fixture",
        private: true,
        type: "module",
        packageManager: "pnpm@12.9.1",
        scripts: {
          check: `${entryCommand} check`,
          "check:heavy": `${entryCommand} check:heavy`,
          "check:full": `${entryCommand} check:full`,
          "format:check": taskScript(
            options.failRootLight === true
              ? "root-light-failure"
              : options.waitRootLight === true
                ? "root-light-wait"
                : "root-light",
          ),
          typecheck: taskScript("root-typecheck"),
          build: taskScript("root-build"),
          test: taskScript(
            options.failRootHeavy === true
              ? "root-heavy-failure"
              : "root-heavy",
          ),
          "verify:generated": taskScript("root-custom-light"),
          fix: `${entryCommand} fix`,
          dev: taskScript("root-dev"),
          publish: taskScript("root-release"),
          ...(options.invalidCheckCustom === true
            ? { "check:custom": taskScript("root-check-custom") }
            : {}),
        },
        devDependencies: { turbo: "2.11.7" },
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
    path.join(root, "packages", "app", "package.json"),
    JSON.stringify(
      {
        name: "@task-gates/app",
        private: true,
        scripts: {
          build: "node ../../record.cjs package-build",
          "format:check": "node ../../record.cjs package-light",
          test: "node ../../record.cjs package-heavy",
          "verify:generated": "node ../../record.cjs package-custom-light",
          prepare: "node ../../record.cjs package-lifecycle",
          ...(options.withConditionalHeavyTask === true ||
          options.reportConditionalTask === true
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
          "format:check": {
            dependsOn: ["build"],
            tags: ["quality:light"],
          },
          test: {
            dependsOn: [],
            tags: ["quality:heavy"],
            ...(options.withConditionalHeavyTask === true
              ? { with: ["verify:conditional"] }
              : {}),
          },
          "verify:generated": {
            dependsOn: [],
            tags: ["quality:light"],
          },
          prepare: { dependsOn: [], tags: ["work:lifecycle"] },
          ...(options.withConditionalHeavyTask === true ||
          options.reportConditionalTask === true
            ? {
                "verify:conditional": {
                  dependsOn: [],
                  tags: ["quality:conditional"],
                },
              }
            : {}),
          ...(options.commandOnlyTask === true
            ? {
                "verify:command": {
                  command: ["node", "../../record.cjs", "package-command-only"],
                  tags: ["quality:light"],
                },
              }
            : {}),
        },
      },
      null,
      2,
    ),
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
          "//#format:check": { tags: ["quality:light"] },
          "//#typecheck": { tags: ["quality:light"] },
          "//#build": { tags: ["work:preparation"] },
          "//#test": { tags: ["quality:heavy"] },
          "//#verify:generated": { tags: ["quality:light"] },
          "//#fix": { tags: ["work:repair"] },
          "//#dev": { tags: ["work:development"] },
          "//#publish": { tags: ["work:release"] },
          ...(options.invalidCheckCustom === true
            ? { "//#check:custom": { tags: ["work:repair"] } }
            : {}),
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(root, "record.cjs"),
    [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'fs.appendFileSync(path.join(__dirname, "runs.log"), `${process.argv[2]}\\n`);',
      'if (process.argv[2].endsWith("-failure")) process.exitCode = 1;',
      'if (process.argv[2] === "root-light-wait") {',
      '  for (const signal of ["SIGINT", "SIGTERM"]) {',
      "    process.on(signal, () => {",
      '      fs.appendFileSync(path.join(__dirname, "runs.log"), "root-light-signal-" + signal + "\\n");',
      '      process.exit(signal === "SIGINT" ? 130 : 143);',
      "    });",
      "  }",
      "  setInterval(() => {}, 1000);",
      "}",
      "",
    ].join("\n"),
  );

  try {
    await mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
    await symlink(
      turboExecutablePath,
      path.join(root, "node_modules", ".bin", "turbo"),
    );
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
  tags: readonly string[] = [],
): Promise<void> {
  const packagePath = path.join(root, "package.json");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    scripts: Record<string, string>;
  };
  packageManifest.scripts[name] = taskScript(name);
  await writeFile(packagePath, JSON.stringify(packageManifest, null, 2));

  const turboPath = path.join(root, "turbo.json");
  const turboConfig = JSON.parse(await readFile(turboPath, "utf8")) as {
    tasks: Record<string, unknown>;
  };
  turboConfig.tasks[`//#${name}`] = { tags };
  await writeFile(turboPath, JSON.stringify(turboConfig, null, 2));
}

for (const entry of gateEntries) {
  void it(`${entry.label} rejects missing, unknown, and extra arguments without running tasks`, async () => {
    const root = await createWorkspace({ entryCommand: entry.command });
    try {
      for (const args of [[], ["unknown"], ["check", "unexpected"]]) {
        const result = await execa(
          "node",
          ["--conditions=source", entry.scriptPath, ...args],
          { ...workspaceProcessOptions(root), reject: false },
        );
        assert.equal(result.exitCode, 2, result.stderr);
        assert.equal(
          result.stderr,
          `Usage: ${entry.command} <check|check:heavy|check:full|fix>`,
        );
        assert.deepEqual(await readRuns(root), []);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it(`${entry.label} executes the requested public scope and propagates task exit status`, async () => {
    const root = await createWorkspace({
      entryCommand: entry.command,
      failRootHeavy: true,
    });
    try {
      const light = await execa(
        "node",
        ["--conditions=source", entry.scriptPath, "check"],
        { ...workspaceProcessOptions(root), reject: false },
      );
      assert.equal(light.exitCode, 0, light.stderr);
      assert.ok((await readRuns(root)).includes("root-light"));
      assert.ok(!(await readRuns(root)).includes("root-heavy-failure"));

      const heavy = await execa(
        "node",
        ["--conditions=source", entry.scriptPath, "check:heavy"],
        { ...workspaceProcessOptions(root), reject: false },
      );
      assert.equal(heavy.exitCode, 1, heavy.stderr);
      assert.ok((await readRuns(root)).includes("root-heavy-failure"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("check runs light tasks and their native preparation dependencies", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set([
        "package-build",
        "root-light",
        "root-typecheck",
        "root-custom-light",
        "package-light",
        "package-custom-light",
      ]),
      `${result.stdout}\n${result.stderr}`,
    );
    assert.ok(runs.indexOf("package-build") < runs.indexOf("package-light"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects dangling role tags on commandless nodes", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turboConfig = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turboConfig.tasks["//#orphan-root"] = {
      tags: ["work:preparation"],
    };
    await writeFile(turboPath, JSON.stringify(turboConfig, null, 2));

    const appTurboPath = path.join(root, "packages", "app", "turbo.json");
    const appTurboConfig = JSON.parse(await readFile(appTurboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    appTurboConfig.tasks["verify:placeholder"] = {
      tags: ["work:repair"],
    };
    await writeFile(appTurboPath, JSON.stringify(appTurboConfig, null, 2));

    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0, result.stdout);
    assert.match(result.stderr, /#orphan-root/u);
    assert.match(result.stderr, /work:preparation/u);
    assert.match(result.stderr, /@task-gates\/app#verify:placeholder/u);
    assert.match(result.stderr, /work:repair/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("preserves native dependency traversal through roleless transit nodes", async () => {
  const root = await createWorkspace();
  try {
    await mkdir(path.join(root, "packages", "provider"), { recursive: true });
    await mkdir(path.join(root, "packages", "upstream"), { recursive: true });

    const appManifestPath = path.join(root, "packages", "app", "package.json");
    const appManifest = JSON.parse(await readFile(appManifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    appManifest.dependencies = { "@task-gates/provider": "workspace:*" };
    await writeFile(appManifestPath, JSON.stringify(appManifest, null, 2));

    const appTurboPath = path.join(root, "packages", "app", "turbo.json");
    const appTurboConfig = JSON.parse(await readFile(appTurboPath, "utf8")) as {
      tasks: Record<
        string,
        {
          readonly dependsOn?: readonly string[];
          readonly tags?: readonly string[];
        }
      >;
    };
    appTurboConfig.tasks["verify:generated"] = {
      ...appTurboConfig.tasks["verify:generated"],
      dependsOn: ["@task-gates/provider#build"],
    };
    await writeFile(appTurboPath, JSON.stringify(appTurboConfig, null, 2));

    await writeFile(
      path.join(root, "packages", "provider", "package.json"),
      JSON.stringify(
        {
          name: "@task-gates/provider",
          private: true,
          dependencies: { "@task-gates/upstream": "workspace:*" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "provider", "turbo.json"),
      JSON.stringify(
        {
          extends: ["//"],
          tags: ["task-gates-provider"],
          tasks: { build: { dependsOn: ["^build"] } },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "upstream", "package.json"),
      JSON.stringify(
        {
          name: "@task-gates/upstream",
          private: true,
          scripts: { build: "node ../../record.cjs provider-upstream-build" },
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(root, "packages", "upstream", "turbo.json"),
      JSON.stringify(
        {
          extends: ["//"],
          tags: ["task-gates-upstream"],
          tasks: {
            build: { dependsOn: [], tags: ["work:preparation"] },
          },
        },
        null,
        2,
      ),
    );

    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);

    const runs = await readRuns(root);
    assert.ok(runs.includes("provider-upstream-build"), result.stdout);
    assert.ok(
      runs.indexOf("provider-upstream-build") <
        runs.indexOf("package-custom-light"),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("check:heavy runs heavy verification tasks without light tasks", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check:heavy"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set(["root-heavy", "package-heavy"]),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("check:full runs the light layer before the heavy layer", async () => {
  const root = await createWorkspace();
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    const lightTasks = [
      "root-light",
      "root-typecheck",
      "root-custom-light",
      "package-light",
      "package-custom-light",
    ];
    const heavyTasks = ["root-heavy", "package-heavy"];
    assert.ok(
      lightTasks.every((task) => runs.includes(task)),
      runs.join("\n"),
    );
    assert.ok(
      heavyTasks.every((task) => runs.includes(task)),
      runs.join("\n"),
    );
    assert.ok(
      Math.max(...lightTasks.map((task) => runs.indexOf(task))) <
        Math.min(...heavyTasks.map((task) => runs.indexOf(task))),
      runs.join("\n"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("does not start the heavy layer after a light task fails", async () => {
  const root = await createWorkspace({ failRootLight: true });
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);

    const runs = await readRuns(root);
    assert.ok(runs.includes("root-light-failure"), runs.join("\n"));
    assert.ok(!runs.includes("root-heavy"), runs.join("\n"));
    assert.ok(!runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function verifyFullGateCancellation(
  signal: NodeJS.Signals,
  expectedExitCode: number,
): Promise<void> {
  const root = await createWorkspace({ waitRootLight: true });
  const child = spawn("node", [taskGatesPath, "check:full"], {
    ...workspaceProcessOptions(root),
    stdio: "pipe",
  });
  const childOutput: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) =>
    childOutput.push(chunk.toString()),
  );
  child.stderr?.on("data", (chunk: Buffer) =>
    childOutput.push(chunk.toString()),
  );
  try {
    let started = false;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        const runs = await readFile(path.join(root, "runs.log"), "utf8");
        if (runs.includes("root-light-wait")) {
          started = true;
          break;
        }
      } catch {
        // The workspace task has not created the log file yet.
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    assert.ok(
      started,
      `the selected light task did not start:\n${childOutput.join("")}`,
    );

    const exited = new Promise<{
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolveExit) =>
      child.once("close", (code, signal) => resolveExit({ code, signal })),
    );
    assert.equal(child.kill(signal), true);
    let exitTimeout: NodeJS.Timeout | undefined;
    let result: Awaited<typeof exited>;
    try {
      result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          exitTimeout = setTimeout(
            () =>
              reject(
                new Error(`the quality gate did not exit after ${signal}`),
              ),
            30000,
          );
        }),
      ]);
    } finally {
      if (exitTimeout !== undefined) {
        clearTimeout(exitTimeout);
      }
    }
    assert.equal(result.code, expectedExitCode);
    assert.equal(result.signal, null);

    const runs = await readRuns(root);
    assert.ok(
      runs.includes(
        `root-light-signal-${signal === "SIGTERM" ? "SIGINT" : signal}`,
      ),
      runs.join("\n"),
    );
    assert.ok(!runs.includes("root-heavy"), runs.join("\n"));
    assert.ok(!runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) =>
        child.once("close", () => resolveExit()),
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

for (const [signal, exitCode] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  void it(`forwards ${signal} through the active Turbo process tree before starting the next layer`, async () => {
    await verifyFullGateCancellation(signal, exitCode);
  });
}

void it("continues independent heavy tasks after one task fails", async () => {
  const root = await createWorkspace({ failRootHeavy: true });
  try {
    const result = await execa("pnpm", ["run", "check:heavy"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);

    const runs = await readRuns(root);
    assert.ok(runs.includes("root-heavy-failure"), runs.join("\n"));
    assert.ok(runs.includes("package-heavy"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects a light task whose native dependency closure includes heavy verification", async () => {
  const root = await createWorkspace();
  try {
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    packageTurbo.tasks["format:check"]!.dependsOn = ["test"];
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo, null, 2));

    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /light check cannot transitively trigger heavy verification/u,
    );

    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("preflights with closures and does not run light work when heavy includes a conditional task", async () => {
  const root = await createWorkspace({ withConditionalHeavyTask: true });
  try {
    const result = await execa("pnpm", ["run", "check:full"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /standard verification cannot transitively trigger conditional verification/u,
    );

    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("reports conditional tasks as unexecuted when ordinary checks exclude them", async () => {
  const root = await createWorkspace({ reportConditionalTask: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(
      result.stderr,
      /Conditional verification tasks not run: @task-gates\/app#verify:conditional/u,
    );

    const runs = await readRuns(root);
    assert.ok(!runs.includes("package-conditional"), runs.join("\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("runs quality-tagged native command tasks without package scripts", async () => {
  const root = await createWorkspace({ commandOnlyTask: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);

    const runs = await readRuns(root);
    assert.ok(
      runs.includes("package-command-only"),
      `${result.stdout}\n${result.stderr}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects custom check-family tasks assigned to a work role before execution", async () => {
  const root = await createWorkspace({ invalidCheckCustom: true });
  try {
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /is a reserved verification task and cannot be assigned non-verification role work:repair/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects custom test-family tasks assigned to a work role before execution", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "test:custom", ["work:repair"]);
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /\/\/#test:custom is a reserved verification task.*work:repair/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const name of ["lint", "typecheck", "format:check"]) {
  void it(`rejects ${name} when assigned to a work role`, async () => {
    const root = await createWorkspace();
    try {
      await addRootTask(root, name, ["work:repair"]);
      const result = await execa("pnpm", ["run", "check"], {
        ...workspaceProcessOptions(root),
        reject: false,
      });

      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        new RegExp(`${name}.*is a reserved verification task`),
      );
      const runs = await readRuns(root);
      assert.deepEqual(runs, []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("rejects an unclassified script added only to the root manifest", async () => {
  const root = await createWorkspace();
  try {
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["verify:unclassified"] = taskScript("unclassified");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /\/\/#verify:unclassified is missing a unique role tag/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects an executable root task with an unknown role", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:unknown", ["quality:unknown"]);
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /\/\/#verify:unknown uses unknown role tag quality:unknown/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects an executable root task with conflicting roles", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:conflicting", [
      "quality:light",
      "work:repair",
    ]);
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /\/\/#verify:conflicting has multiple role tags/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects a package task whose role tag was cleared", async () => {
  const root = await createWorkspace();
  try {
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as { tasks: Record<string, Record<string, unknown>> };
    const generatedTask = packageTurbo.tasks["verify:generated"];
    assert.ok(generatedTask);
    packageTurbo.tasks["verify:generated"] = { ...generatedTask, tags: [] };
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo, null, 2));
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /@task-gates\/app#verify:generated is missing a unique role tag/u,
    );
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("limits quality:entry to the three public root gate tasks", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "verify:entry", ["quality:entry"]);
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });

    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /\/\/#verify:entry cannot use quality:entry/u);
    const runs = await readRuns(root);
    assert.deepEqual(runs, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("fix discovers differently named repair tasks by role while keeping required light checks and preparation", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "rewrite:generated", [
      "work:repair",
      "area:generated",
    ]);
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, { dependsOn?: string[] }>;
    };
    turbo.tasks["//#rewrite:generated"]!.dependsOn = ["typecheck", "build"];
    await writeFile(turboPath, JSON.stringify(turbo));

    const packagePath = path.join(root, "packages", "app", "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["normalize:assets"] =
      "node ../../record.cjs package-repair";
    await writeFile(packagePath, JSON.stringify(manifest));
    const packageTurboPath = path.join(root, "packages", "app", "turbo.json");
    const packageTurbo = JSON.parse(
      await readFile(packageTurboPath, "utf8"),
    ) as {
      tasks: Record<string, unknown>;
    };
    packageTurbo.tasks["normalize:assets"] = {
      tags: ["work:repair"],
      dependsOn: ["build"],
    };
    await writeFile(packageTurboPath, JSON.stringify(packageTurbo));

    const result = await execa("pnpm", ["run", "fix"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    const runs = await readRuns(root);
    assert.deepEqual(
      new Set(runs),
      new Set([
        "rewrite:generated",
        "root-typecheck",
        "root-build",
        "package-repair",
        "package-build",
      ]),
    );
    assert.ok(
      runs.indexOf("root-typecheck") < runs.indexOf("rewrite:generated"),
    );
    assert.ok(runs.indexOf("package-build") < runs.indexOf("package-repair"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("fix rejects an unclassified script added only to a manifest and does not treat package tags as task roles", async () => {
  const root = await createWorkspace();
  try {
    const packagePath = path.join(root, "packages", "app", "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["unclassified"] = "node ../../record.cjs unclassified";
    await writeFile(packagePath, JSON.stringify(manifest));
    const turboPath = path.join(root, "packages", "app", "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tags: string[];
    };
    turbo.tags.push("quality:light");
    await writeFile(turboPath, JSON.stringify(turbo));

    const result = await execa("pnpm", ["run", "fix"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /@task-gates\/app#unclassified is missing a unique role tag/u,
    );
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("allows arbitrary extra tags and explicit on-demand tasks while keeping leaf tasks directly callable", async () => {
  const root = await createWorkspace();
  try {
    await addRootTask(root, "inspect:cache", [
      "work:on-demand",
      "area:local",
      "custom-label",
    ]);
    await addRootTask(root, "verify:custom", [
      "quality:light",
      "area:local",
      "custom-label",
    ]);
    const check = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(check.exitCode, 0, check.stderr);
    const runs = await readRuns(root);
    assert.ok(runs.includes("verify:custom"));
    assert.ok(!runs.includes("inspect:cache"));

    const direct = await execa("pnpm", ["run", "inspect:cache"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(direct.exitCode, 0, direct.stderr);
    assert.ok((await readRuns(root)).includes("inspect:cache"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("allows commandless aggregate nodes with a role to drive executable work through the native graph", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, unknown>;
    };
    turbo.tasks["//#verify:aggregate"] = {
      tags: ["quality:light"],
      dependsOn: ["build"],
    };
    await writeFile(turboPath, JSON.stringify(turbo));
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok((await readRuns(root)).includes("root-build"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("enforces gate closure rules on commandless aggregate node roles", async () => {
  const root = await createWorkspace();
  try {
    const turboPath = path.join(root, "turbo.json");
    const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
      tasks: Record<string, { tags?: string[]; dependsOn?: string[] }>;
    };
    turbo.tasks["//#release:aggregate"] = {
      tags: ["work:release"],
      dependsOn: ["build"],
    };
    turbo.tasks["//#format:check"]!.dependsOn = ["release:aggregate"];
    await writeFile(turboPath, JSON.stringify(turbo));
    const result = await execa("pnpm", ["run", "check"], {
      ...workspaceProcessOptions(root),
      reject: false,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr,
      /release:aggregate.*transitively triggering role work:release is not allowed/u,
    );
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [gate, role] of [
  ["check", "work:repair"],
  ["check:heavy", "work:development"],
  ["fix", "quality:heavy"],
  ["fix", "work:on-demand"],
] as const) {
  void it(`${gate} rejects transitively running ${role} from the native dependency graph`, async () => {
    const root = await createWorkspace();
    try {
      await addRootTask(root, "dependency:custom", [role]);
      await addRootTask(root, "entry:custom", [
        gate === "fix"
          ? "work:repair"
          : gate === "check"
            ? "quality:light"
            : "quality:heavy",
      ]);
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { dependsOn?: string[] }>;
      };
      turbo.tasks["//#entry:custom"]!.dependsOn = ["dependency:custom"];
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("pnpm", ["run", gate], {
        ...workspaceProcessOptions(root),
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /dependency:custom.*transitively triggering role .* is not allowed/u,
      );
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const entry of ["check", "fix"]) {
  void it(`rejects dependencies that loop back into public gate entry ${entry}`, async () => {
    const root = await createWorkspace();
    try {
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { dependsOn?: string[] }>;
      };
      turbo.tasks["//#format:check"]!.dependsOn = [entry];
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("pnpm", ["run", "check"], {
        ...workspaceProcessOptions(root),
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /leaf tasks cannot depend on public aggregate gate entries/u,
      );
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const mutation of ["missing", "script", "command", "role"] as const) {
  void it(`detects miswired public gate entry when invoking shared implementation directly: ${mutation}`, async () => {
    const root = await createWorkspace();
    try {
      const manifestPath = path.join(root, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      const turboPath = path.join(root, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { tags?: string[]; command?: string[] }>;
      };
      if (mutation === "missing") {
        delete manifest.scripts["check"];
        delete turbo.tasks["//#check"];
      } else if (mutation === "script") {
        manifest.scripts["check"] = taskScript("bypassed-check");
      } else if (mutation === "command") {
        turbo.tasks["//#check"]!.command = [
          "node",
          "record.cjs",
          "bypassed-check",
        ];
      } else {
        turbo.tasks["//#check"]!.tags = ["quality:light"];
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(turboPath, JSON.stringify(turbo));
      const result = await execa("node", ["scripts/task-gates.ts", "fix"], {
        ...workspaceProcessOptions(root),
        reject: false,
      });
      assert.notEqual(result.exitCode, 0);
      assert.match(result.stderr, /public gate entry/u);
      assert.deepEqual(await readRuns(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

void it("fails when light check selects no tasks and explicitly skips empty heavy verification or fix layers", async () => {
  const root = await createWorkspace();
  try {
    for (const directory of [root, path.join(root, "packages", "app")]) {
      const manifestPath = path.join(directory, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        scripts: Record<string, string>;
      };
      const turboPath = path.join(directory, "turbo.json");
      const turbo = JSON.parse(await readFile(turboPath, "utf8")) as {
        tasks: Record<string, { tags?: string[] }>;
      };
      for (const [name, task] of Object.entries(turbo.tasks)) {
        if (
          task.tags?.some(
            (tag) => tag === "quality:light" || tag === "quality:heavy",
          ) === true
        ) {
          delete turbo.tasks[name];
          delete manifest.scripts[name.replace(/^\/\/#/u, "")];
        }
      }
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(turboPath, JSON.stringify(turbo));
    }
    for (const gate of ["check", "check:full", "check:heavy", "fix"]) {
      const result = await execa("pnpm", ["run", gate], {
        ...workspaceProcessOptions(root),
        reject: false,
      });
      if (gate === "check" || gate === "check:full") {
        assert.notEqual(result.exitCode, 0);
        assert.match(
          result.stderr,
          /Light check selected no executable tasks/u,
        );
      } else {
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stderr, /selected no tasks; skipping execution/u);
      }
    }
    assert.deepEqual(await readRuns(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
