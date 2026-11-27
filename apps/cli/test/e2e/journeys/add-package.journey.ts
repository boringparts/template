import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { templatePresets } from "@boringparts/template-content";
import { releaseToolchainSnapshot } from "@boringparts/template-workspace/release-toolchain-snapshot";
import { execa } from "execa";

import { planPreset } from "../../support/preset-planning.ts";
import type { CliJourney, CliJourneyCommand } from "../journey.ts";

async function requireLinkableAddition(): Promise<{
  readonly presetName: string;
  readonly consumerPath: string;
  readonly role: string;
}> {
  for (const member of templatePresets) {
    const preset = member.definition;
    if (
      !preset.operations.includes("init") ||
      !preset.operations.includes("add")
    ) {
      continue;
    }
    const plan = await planPreset(member);
    const consumer = plan.packages.find(
      ({ path: packagePath, role }) =>
        packagePath !== "." && role === "shared-library",
    );
    if (consumer !== undefined) {
      return {
        presetName: preset.metadata.alias,
        consumerPath: consumer.path,
        role: consumer.role,
      };
    }
  }
  throw new Error(
    "add package journey requires a linkable preset in the content collection",
  );
}

const {
  presetName: addablePresetName,
  consumerPath,
  role: addablePresetRole,
} = await requireLinkableAddition();
const initializationPresets = templatePresets.filter((member) =>
  member.definition.operations.includes("init"),
);
const additionPresets = templatePresets.filter(
  (member) =>
    member.definition.operations.includes("add") &&
    Object.keys(member.definition.nodes).length === 1,
);
const presetMatrix = initializationPresets.flatMap((initialization) =>
  additionPresets.map((addition) => ({ initialization, addition })),
);
const legacyCommandOffset = 10;
const matrixCommandOffset = legacyCommandOffset + 3;

async function snapshot(
  root: string,
  relative = "",
): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const files: { path: string; content: string }[] = [];
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await snapshot(root, child)));
    } else if (entry.isFile()) {
      files.push({
        path: child.split(path.sep).join("/"),
        content: (await readFile(path.join(root, child))).toString("base64"),
      });
    }
  }
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

type RootManifest = {
  readonly devEngines?: {
    readonly runtime?: {
      readonly name?: string;
      readonly version?: string;
      readonly onFail?: string;
    };
  };
  readonly engines?: { readonly node?: string };
  readonly packageManager?: string;
};

async function readRootManifest(project: string): Promise<RootManifest> {
  return JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ) as RootManifest;
}

async function rewriteRootManifest(
  project: string,
  toolchain: { readonly node: string; readonly packageManager: string },
): Promise<void> {
  const manifestPath = path.join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  delete manifest.engines;
  manifest.devEngines = {
    runtime: { name: "node", version: toolchain.node, onFail: "download" },
  };
  manifest.packageManager = toolchain.packageManager;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const upgradedNode = "24.18.0";
const upgradedPackageManager = "pnpm@10.5.0";

const journey: CliJourney = {
  name: "add-package",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    const commands: CliJourneyCommand[] = [
      {
        name: "initialize base",
        args: [
          "init",
          "project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
        ],
      },
      {
        name: "dry-run addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
          "--dry-run",
        ],
      },
      {
        name: "apply addition",
        cwd: project,
        async prepare() {
          await assert.rejects(stat(path.join(project, "packages/utility")), {
            code: "ENOENT",
          });
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
        ],
      },
      {
        name: "repeat addition",
        cwd: project,
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "utility",
          "--path",
          "packages/utility",
          "--link-from",
          consumerPath,
        ],
      },
      {
        name: "missing required options",
        cwd: project,
        args: ["add", "package"],
      },
      {
        name: "add package on the target root current toolchain",
        cwd: project,
        async prepare() {
          const root = await readRootManifest(project);
          await writeFile(
            path.join(context.workDir, "toolchain-history.json"),
            JSON.stringify({
              rootNode: root.devEngines?.runtime?.version,
              rootPackageManager: root.packageManager,
            }),
          );
          await rewriteRootManifest(project, {
            node: upgradedNode,
            packageManager: upgradedPackageManager,
          });
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "upgraded",
          "--path",
          "packages/upgraded",
        ],
      },
      {
        name: "canonical metadata conflict",
        cwd: project,
        async prepare() {
          const generationPath = path.join(
            project,
            ".template/generation.json",
          );
          const generation = JSON.parse(
            await readFile(generationPath, "utf8"),
          ) as unknown;
          await writeFile(generationPath, JSON.stringify(generation));
          await writeFile(
            path.join(context.workDir, "conflict-before.json"),
            JSON.stringify(await snapshot(project)),
          );
          await writeFile(
            path.join(context.workDir, "root-after-current-addition.json"),
            await readFile(path.join(project, "package.json"), "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "second",
          "--path",
          "packages/second",
        ],
      },
      {
        name: "add package on an unusable root toolchain declaration",
        cwd: project,
        async prepare() {
          await writeFile(
            path.join(context.workDir, "conflict-after.json"),
            JSON.stringify(await snapshot(project)),
          );
          const manifestPath = path.join(project, "package.json");
          await rewriteRootManifest(project, {
            node: `>=${upgradedNode}`,
            packageManager: upgradedPackageManager,
          });
          await writeFile(
            path.join(context.workDir, "invalid-root-package.json"),
            await readFile(manifestPath, "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "rejected",
          "--path",
          "packages/rejected",
        ],
      },
      {
        name: "add package on a target root without a pnpm declaration",
        cwd: project,
        async prepare() {
          // Capture the untouched root manifest bytes from the previous rejection before crafting a missing packageManager declaration.
          await writeFile(
            path.join(context.workDir, "invalid-root-unchanged.json"),
            await readFile(path.join(project, "package.json"), "utf8"),
          );
          const manifestPath = path.join(project, "package.json");
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          delete manifest.engines;
          manifest.devEngines = {
            runtime: {
              name: "node",
              version: upgradedNode,
              onFail: "download",
            },
          };
          delete manifest.packageManager;
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          await writeFile(
            path.join(context.workDir, "missing-pm-root-package.json"),
            await readFile(manifestPath, "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "missing-pm",
          "--path",
          "packages/missing-pm",
          "--output",
          "text",
        ],
      },
      {
        name: "add package on a target root with only legacy engines.node",
        cwd: project,
        async prepare() {
          await writeFile(
            path.join(context.workDir, "missing-pm-after-add.json"),
            await readFile(path.join(project, "package.json"), "utf8"),
          );
          const manifestPath = path.join(project, "package.json");
          const manifest = JSON.parse(
            await readFile(manifestPath, "utf8"),
          ) as Record<string, unknown>;
          delete manifest.devEngines;
          manifest.engines = { node: upgradedNode };
          manifest.packageManager = upgradedPackageManager;
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          await writeFile(
            path.join(context.workDir, "legacy-engines-before.json"),
            JSON.stringify(await snapshot(project)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "legacy-engines",
          "--path",
          "packages/legacy-engines",
        ],
      },
    ];

    const legacyProject = path.join(context.workDir, "legacy-project");
    const legacySnapshot = path.join(context.workDir, "legacy-before.json");
    const legacyAddition = [
      "add",
      "package",
      "--preset",
      addablePresetName,
      "--name",
      "legacy-addition",
      "--path",
      "packages/legacy-addition",
    ];
    commands.push(
      {
        name: "initialize a project before testing legacy record rejection",
        args: [
          "init",
          "legacy-project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
        ],
      },
      {
        name: "old v2 dry-run rejection without writes",
        cwd: legacyProject,
        async prepare() {
          const recordPath = path.join(
            legacyProject,
            ".template/generation.json",
          );
          const record = JSON.parse(await readFile(recordPath, "utf8")) as {
            schemaVersion: number;
          };
          record.schemaVersion = 2;
          await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
          await writeFile(
            legacySnapshot,
            JSON.stringify(await snapshot(legacyProject)),
          );
        },
        args: [...legacyAddition, "--dry-run"],
      },
      {
        name: "old v2 execute rejection without writes",
        cwd: legacyProject,
        async prepare() {
          assert.deepEqual(
            await snapshot(legacyProject),
            JSON.parse(await readFile(legacySnapshot, "utf8")),
            "Legacy v2 dry-run must leave the target untouched",
          );
        },
        args: legacyAddition,
      },
    );

    for (const { initialization, addition } of presetMatrix) {
      const initializationAlias = initialization.definition.metadata.alias;
      const additionAlias = addition.definition.metadata.alias;
      const targetName = `matrix-${initializationAlias}-${additionAlias}`;
      const project = path.join(context.workDir, targetName);
      commands.push(
        {
          name: `initialize ${initializationAlias} project for adding ${additionAlias} preset`,
          args: [
            "init",
            targetName,
            "--preset",
            initializationAlias,
            "--scope",
            "acme",
          ],
        },
        {
          name: `add ${additionAlias} preset to ${initializationAlias} project`,
          cwd: project,
          async prepare() {
            await writeFile(
              path.join(
                context.workDir,
                `${targetName}-before-add-record.json`,
              ),
              await readFile(
                path.join(project, ".template/generation.json"),
                "utf8",
              ),
            );
            await writeFile(
              path.join(
                context.workDir,
                `${targetName}-before-add-blueprint.json`,
              ),
              await readFile(
                path.join(project, ".template/blueprint.json"),
                "utf8",
              ),
            );
          },
          args: [
            "add",
            "package",
            "--preset",
            additionAlias,
            "--name",
            `${initializationAlias}-${additionAlias}`,
            "--path",
            `packages/${initializationAlias}-${additionAlias}`,
          ],
        },
      );
    }
    const identityProject = path.join(
      context.workDir,
      "identity-conflict-project",
    );
    const identitySnapshot = path.join(
      context.workDir,
      "identity-conflict-before.json",
    );
    commands.push(
      {
        name: "initialize project for package identity conflict",
        args: [
          "init",
          "identity-conflict-project",
          "--preset",
          addablePresetName,
          "--scope",
          "acme",
        ],
      },
      {
        name: "identity conflict dry-run performs zero writes",
        cwd: identityProject,
        async prepare() {
          await writeFile(
            identitySnapshot,
            JSON.stringify(await snapshot(identityProject)),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "tooling-config",
          "--path",
          "packages/rejected",
          "--dry-run",
        ],
      },
      {
        name: "identity conflict apply performs zero writes",
        cwd: identityProject,
        async prepare() {
          assert.deepEqual(
            await snapshot(identityProject),
            JSON.parse(await readFile(identitySnapshot, "utf8")),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          addablePresetName,
          "--name",
          "tooling-config",
          "--path",
          "packages/rejected",
        ],
      },
    );
    return commands;
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0);

    const previewResult = JSON.parse(results[1]?.stdout ?? "");
    assert.equal(previewResult.variant, "planned");
    const preview = previewResult.data;
    assert.equal(results[1]?.exitCode, 0);
    assert.equal(preview.dryRun, true);
    assert.ok(
      preview.actions.some(
        (action: { path: string }) =>
          action.path === "packages/utility/package.json",
      ),
    );

    assert.equal(results[2]?.exitCode, 0);
    assert.equal(JSON.parse(results[2]?.stdout ?? "").kind, "data");
    assert.match(
      await readFile(
        path.join(context.workDir, "project/packages/utility/package.json"),
        "utf8",
      ),
      /"name": "@acme\/utility"/u,
    );

    assert.deepEqual(JSON.parse(results[3]?.stdout ?? "").data.actions, []);
    assert.equal(results[4]?.exitCode, 2);
    assert.equal(results[4]?.stdout, "");
    assert.equal(JSON.parse(results[4]?.stderr ?? "").kind, "usageFailure");

    const project = path.join(context.workDir, "project");
    const history = JSON.parse(
      await readFile(
        path.join(context.workDir, "toolchain-history.json"),
        "utf8",
      ),
    ) as {
      readonly rootNode: string;
      readonly rootPackageManager: string;
    };
    assert.equal(
      history.rootNode,
      releaseToolchainSnapshot.nodeVersion,
      "Initialized root devEngines.runtime.version should match the exact Node version from the CLI release snapshot",
    );
    assert.equal(
      history.rootPackageManager,
      releaseToolchainSnapshot.packageManagerPin,
      "Initialized root packageManager should match the exact pnpm pin from the CLI release snapshot",
    );
    assert.notEqual(history.rootNode, upgradedNode);
    assert.notEqual(history.rootPackageManager, upgradedPackageManager);

    assert.equal(results[5]?.exitCode, 0);
    assert.equal(JSON.parse(results[5]?.stdout ?? "").kind, "data");
    const upgradedManifest = JSON.parse(
      await readFile(
        path.join(project, "packages/upgraded/package.json"),
        "utf8",
      ),
    ) as {
      readonly name: string;
      readonly engines?: unknown;
    };
    assert.equal(upgradedManifest.engines, undefined);
    const devcontainerAfterAddition = JSON.parse(
      await readFile(
        path.join(project, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ) as {
      readonly build?: { readonly args?: Record<string, unknown> };
    };
    assert.equal(
      devcontainerAfterAddition.build?.args?.NODE_VERSION,
      upgradedNode,
    );
    const rootAfterAddition = JSON.parse(
      await readFile(
        path.join(context.workDir, "root-after-current-addition.json"),
        "utf8",
      ),
    ) as RootManifest;
    assert.equal(rootAfterAddition.engines, undefined);
    assert.deepEqual(rootAfterAddition.devEngines, {
      runtime: { name: "node", version: upgradedNode, onFail: "download" },
    });
    assert.equal(rootAfterAddition.packageManager, upgradedPackageManager);

    const rejectedResult = JSON.parse(results[7]?.stderr ?? "");
    assert.equal(rejectedResult.variant, "operationFailed");
    const rejected = rejectedResult.data as {
      readonly error: { readonly message: string; readonly suggestion: string };
    };
    assert.equal(results[7]?.exitCode, 1);
    // JSON output must identify the invalid field, its actual value, and the corrective action.
    assert.match(rejected.error.message, /devEngines\.runtime/u);
    assert.ok(
      rejected.error.message.includes(`">=${upgradedNode}"`),
      `JSON diagnostic should include the actual declared value, got: ${rejected.error.message}`,
    );
    assert.match(
      rejected.error.suggestion,
      /Fix devEngines\.runtime in root package\.json/u,
    );
    await assert.rejects(stat(path.join(project, "packages/rejected")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(
        path.join(context.workDir, "invalid-root-unchanged.json"),
        "utf8",
      ),
      await readFile(
        path.join(context.workDir, "invalid-root-package.json"),
        "utf8",
      ),
    );

    // Negative text output case: missing packageManager must also provide an actionable field-level diagnostic.
    const missingPm = results[8];
    assert.equal(missingPm?.exitCode, 1);
    assert.equal(missingPm?.stdout, "");
    assert.match(
      missingPm?.stderr ?? "",
      /package\.json packageManager/u,
      "Text output should name the packageManager field",
    );
    assert.match(
      missingPm?.stderr ?? "",
      /got null/u,
      "Text output should report the actual value",
    );
    assert.match(
      missingPm?.stderr ?? "",
      /Fix packageManager in root package\.json/u,
      "Text output should provide a corrective action",
    );
    assert.ok(
      !/Package addition operation failed/u.test(missingPm?.stderr ?? ""),
      "Field-level diagnostics must not fall back to the generic failure message",
    );
    await assert.rejects(stat(path.join(project, "packages/missing-pm")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(
        path.join(context.workDir, "missing-pm-after-add.json"),
        "utf8",
      ),
      await readFile(
        path.join(context.workDir, "missing-pm-root-package.json"),
        "utf8",
      ),
    );

    const legacyEnginesRejectedResult = JSON.parse(results[9]?.stderr ?? "");
    assert.equal(results[9]?.exitCode, 1);
    assert.equal(legacyEnginesRejectedResult.variant, "operationFailed");
    assert.match(
      legacyEnginesRejectedResult.data.error.message,
      /devEngines\.runtime/u,
    );
    assert.match(
      legacyEnginesRejectedResult.data.error.suggestion,
      /Fix devEngines\.runtime in root package\.json/u,
    );
    await assert.rejects(stat(path.join(project, "packages/legacy-engines")), {
      code: "ENOENT",
    });
    assert.deepEqual(
      await snapshot(project),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "legacy-engines-before.json"),
          "utf8",
        ),
      ),
    );

    const conflictResult = JSON.parse(results[6]?.stderr ?? "");
    assert.equal(conflictResult.variant, "conflict");
    const conflict = conflictResult.data;
    assert.equal(results[6]?.exitCode, 1);
    assert.deepEqual(conflict.actions, []);
    assert.ok(
      conflict.conflicts.some(
        (entry: { path: string; driver: string }) =>
          entry.path === ".template/generation.json" &&
          entry.driver === "canonical",
      ),
    );
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(context.workDir, "conflict-after.json"),
          "utf8",
        ),
      ) as unknown,
      JSON.parse(
        await readFile(
          path.join(context.workDir, "conflict-before.json"),
          "utf8",
        ),
      ) as unknown,
    );

    await rewriteRootManifest(project, {
      node: releaseToolchainSnapshot.nodeVersion,
      packageManager: releaseToolchainSnapshot.packageManagerPin,
    });

    const utilityManifestPath = path.join(
      project,
      "packages/utility/package.json",
    );
    const utilityManifest = JSON.parse(
      await readFile(utilityManifestPath, "utf8"),
    ) as {
      readonly name: string;
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    // Build a real dependency chain where utility keeps the ^build task config without defining a build script.
    delete utilityManifest.scripts.build;
    utilityManifest.dependencies = {
      ...utilityManifest.dependencies,
      [upgradedManifest.name]: "workspace:*",
    };
    await writeFile(
      utilityManifestPath,
      `${JSON.stringify(utilityManifest, null, 2)}\n`,
    );
    await execa("pnpm", ["install"], { cwd: project });

    const blueprint = JSON.parse(
      await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly name: string;
        readonly path: string;
        readonly role: string;
      }[];
    };
    const packageRole = (packagePath: string): string => {
      const definition = blueprint.packages.find(
        (candidate) => candidate.path === packagePath,
      );
      assert.notStrictEqual(
        definition,
        undefined,
        `Blueprint should record the identity for ${packagePath}`,
      );
      return definition!.role;
    };
    const packageTagsForRole = (role: string): readonly string[] => {
      switch (role) {
        case "cli-tool":
        case "runtime-service":
        case "browser-app":
          return ["app"];
        case "shared-library":
        case "node-library":
          return ["library"];
        case "native-package":
          return ["native"];
        default:
          throw new Error(`Unrecognized PackageDefinition.role: ${role}`);
      }
    };
    const consumerManifest = JSON.parse(
      await readFile(path.join(project, consumerPath, "package.json"), "utf8"),
    ) as { readonly name: string };
    const nativeDirectory = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "query",
        "{ packages { items { name tags tasks { items { name tags script } } } } }",
      ],
      { cwd: project },
    );
    const nativePackages = (
      JSON.parse(nativeDirectory.stdout) as {
        readonly data: {
          readonly packages: {
            readonly items: readonly {
              readonly name: string;
              readonly tags: readonly string[];
              readonly tasks: {
                readonly items: readonly {
                  readonly name: string;
                  readonly tags: readonly string[];
                  readonly script: string | null;
                }[];
              };
            }[];
          };
        };
      }
    ).data.packages.items;
    const nativePackage = (name: string) => {
      const result = nativePackages.find(
        (candidate) => candidate.name === name,
      );
      assert.notStrictEqual(
        result,
        undefined,
        `Turbo native directory is missing ${name}`,
      );
      return result!;
    };
    const utility = nativePackage(utilityManifest.name);
    const consumer = nativePackage(consumerManifest.name);
    const upgraded = nativePackage(upgradedManifest.name);
    assert.deepStrictEqual(
      utility.tags,
      packageTagsForRole(packageRole("packages/utility")),
    );
    assert.deepStrictEqual(
      consumer.tags,
      packageTagsForRole(packageRole(consumerPath)),
    );
    assert.deepStrictEqual(
      upgraded.tags,
      packageTagsForRole(packageRole("packages/upgraded")),
    );
    for (const packageTasks of [consumer, upgraded]) {
      for (const name of ["build", "typecheck"] as const) {
        const task = packageTasks.tasks.items.find(
          (candidate) => candidate.name === name,
        );
        assert.notStrictEqual(
          task,
          undefined,
          `${packageTasks.name} should discover ${name}`,
        );
        assert.deepStrictEqual(
          task!.tags,
          name === "build" ? ["work:preparation"] : ["quality:light"],
        );
        assert.notStrictEqual(task!.script, null);
      }
    }
    const utilityBuild = utility.tasks.items.find(
      (candidate) => candidate.name === "build",
    );
    assert.notStrictEqual(utilityBuild, undefined);
    assert.deepStrictEqual(utilityBuild!.tags, ["work:preparation"]);
    assert.strictEqual(utilityBuild!.script, null);
    const utilityTypecheck = utility.tasks.items.find(
      (candidate) => candidate.name === "typecheck",
    );
    assert.notStrictEqual(utilityTypecheck, undefined);
    assert.strictEqual(utilityTypecheck!.script === null, false);

    const taskPlanResult = await execa(
      "pnpm",
      [
        "exec",
        "turbo",
        "run",
        "build",
        "typecheck",
        `--filter=${consumerManifest.name}`,
        "--dry-run=json",
      ],
      { cwd: project },
    );
    const taskPlan = (
      JSON.parse(taskPlanResult.stdout) as {
        readonly tasks: readonly {
          readonly taskId: string;
          readonly directory: string;
          readonly dependencies: readonly string[];
          readonly command: string;
          readonly resolvedTaskDefinition: {
            readonly dependsOn: readonly string[];
          };
        }[];
      }
    ).tasks;
    for (const name of ["build", "typecheck"] as const) {
      const consumerTask = taskPlan.find(
        (task) => task.taskId === `${consumerManifest.name}#${name}`,
      );
      const utilityTask = taskPlan.find(
        (task) => task.taskId === `${utilityManifest.name}#${name}`,
      );
      const upgradedTask = taskPlan.find(
        (task) => task.taskId === `${upgradedManifest.name}#${name}`,
      );
      assert.notStrictEqual(consumerTask, undefined);
      assert.notStrictEqual(utilityTask, undefined);
      assert.notStrictEqual(upgradedTask, undefined);
      assert.strictEqual(consumerTask!.directory, consumerPath);
      assert.strictEqual(utilityTask!.directory, "packages/utility");
      assert.strictEqual(upgradedTask!.directory, "packages/upgraded");
      assert.ok(
        consumerTask!.dependencies.includes(utilityTask!.taskId),
        `${utilityTask!.taskId} should run before ${consumerTask!.taskId}`,
      );
    }
    const consumerBuild = taskPlan.find(
      (task) => task.taskId === `${consumerManifest.name}#build`,
    )!;
    const utilityBuildPlan = taskPlan.find(
      (task) => task.taskId === `${utilityManifest.name}#build`,
    )!;
    const upgradedBuild = taskPlan.find(
      (task) => task.taskId === `${upgradedManifest.name}#build`,
    )!;
    assert.strictEqual(utilityBuildPlan.command, "<NONEXISTENT>");
    assert.deepStrictEqual(utilityBuildPlan.resolvedTaskDefinition.dependsOn, [
      "^build",
    ]);
    assert.ok(
      consumerBuild.dependencies.includes(utilityBuildPlan.taskId) &&
        utilityBuildPlan.dependencies.includes(upgradedBuild.taskId),
      `${upgradedBuild.taskId} should run before ${consumerBuild.taskId} via commandless ${utilityBuildPlan.taskId}`,
    );

    assert.equal(results[legacyCommandOffset]?.exitCode, 0);
    const legacyProject = path.join(context.workDir, "legacy-project");
    const legacyFailures = results.slice(
      legacyCommandOffset + 1,
      matrixCommandOffset,
    );
    assert.equal(legacyFailures.length, 2);
    for (const result of legacyFailures) {
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      const failure = JSON.parse(result.stderr);
      assert.equal(failure.variant, "operationFailed");
      assert.equal(typeof failure.data.error.message, "string");
      assert.notEqual(failure.data.error.message.length, 0);
    }
    assert.deepEqual(
      await snapshot(legacyProject),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "legacy-before.json"),
          "utf8",
        ),
      ),
    );
    await assert.rejects(
      stat(path.join(legacyProject, "packages/legacy-addition")),
      { code: "ENOENT" },
    );

    const matrixResultCount = presetMatrix.length * 2;
    const matrixResults = results.slice(
      matrixCommandOffset,
      matrixCommandOffset + matrixResultCount,
    );
    assert.equal(matrixResults.length, presetMatrix.length * 2);
    for (const [
      index,
      { initialization, addition },
    ] of presetMatrix.entries()) {
      const initializationAlias = initialization.definition.metadata.alias;
      const additionAlias = addition.definition.metadata.alias;
      const targetName = `matrix-${initializationAlias}-${additionAlias}`;
      const project = path.join(context.workDir, targetName);
      const initializationResult = matrixResults[index * 2]!;
      const additionResult = matrixResults[index * 2 + 1]!;

      assert.equal(
        initializationResult.exitCode,
        0,
        initializationResult.stderr,
      );
      const initialized = JSON.parse(initializationResult.stdout).data;
      assert.equal(initialized.resolved.preset, initializationAlias);
      assert.deepEqual(
        initialized.generationRecord,
        JSON.parse(
          await readFile(
            path.join(context.workDir, `${targetName}-before-add-record.json`),
            "utf8",
          ),
        ),
      );
      assert.deepEqual(
        initialized.blueprint,
        JSON.parse(
          await readFile(
            path.join(
              context.workDir,
              `${targetName}-before-add-blueprint.json`,
            ),
            "utf8",
          ),
        ),
      );
      for (const packageEntry of initialized.resolved.packages as readonly {
        readonly name: string;
        readonly path: string;
      }[]) {
        const manifest = JSON.parse(
          await readFile(
            path.join(project, packageEntry.path, "package.json"),
            "utf8",
          ),
        ) as { readonly name: string };
        assert.equal(manifest.name, packageEntry.name);
      }

      assert.equal(additionResult.exitCode, 0, additionResult.stderr);
      const added = JSON.parse(additionResult.stdout);
      assert.equal(added.variant, "added");
      const addedPath = `packages/${initializationAlias}-${additionAlias}`;
      const packageName = `@acme/${initializationAlias}-${additionAlias}`;
      assert.ok(
        added.data.actions.some(
          (action: { readonly path: string }) =>
            action.path === `${addedPath}/package.json`,
        ),
      );
      const packageManifest = JSON.parse(
        await readFile(path.join(project, addedPath, "package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly engines?: { readonly node?: string };
      };
      assert.equal(packageManifest.name, packageName);
      if (additionAlias === "ts-cli") {
        assert.equal(
          packageManifest.engines?.node,
          `^${releaseToolchainSnapshot.nodeVersion}`,
        );
      } else if (additionAlias === "node-lib") {
        assert.deepEqual(packageManifest.engines, { node: ">=24.0.0" });
      } else {
        assert.equal(packageManifest.engines, undefined);
      }

      const blueprint = JSON.parse(
        await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
      );
      const addedDefinition = blueprint.packages.find(
        (definition: { readonly name: string; readonly path: string }) =>
          definition.name === packageName && definition.path === addedPath,
      );
      assert.notEqual(addedDefinition, undefined);
      const generationRecord = JSON.parse(
        await readFile(path.join(project, ".template/generation.json"), "utf8"),
      );
      assert.equal(generationRecord.schemaVersion, 6);
      assert.ok(
        generationRecord.packages.some(
          (record: { readonly packageDefinitionId: string }) =>
            record.packageDefinitionId === addedDefinition.packageDefinitionId,
        ),
      );
      assert.ok(
        generationRecord.selections.some(
          (selection: {
            readonly presetIdentity: { readonly packageName: string } | null;
          }) =>
            selection.presetIdentity?.packageName ===
            addition.identity.packageName,
        ),
      );
    }

    const identityConflictResult =
      results[matrixCommandOffset + matrixResultCount + 1];
    const identityCommitConflictResult =
      results[matrixCommandOffset + matrixResultCount + 2];
    assert.equal(identityConflictResult?.exitCode, 1);
    assert.equal(identityCommitConflictResult?.exitCode, 1);
    for (const [result, dryRun] of [
      [identityConflictResult, true],
      [identityCommitConflictResult, false],
    ] as const) {
      assert.equal(result?.stdout, "");
      const identityConflict = JSON.parse(result?.stderr ?? "{}");
      assert.equal(identityConflict.variant, "conflict");
      assert.equal(identityConflict.data.dryRun, dryRun);
      assert.deepEqual(identityConflict.data.actions, []);
      assert.equal(identityConflict.data.conflicts.length, 1);
      assert.equal(identityConflict.data.conflicts[0].kind, "identity");
      assert.deepEqual(identityConflict.data.conflicts[0].requested, {
        name: "@acme/tooling-config",
        path: "packages/rejected",
        role: addablePresetRole,
      });
    }
    assert.deepEqual(
      await snapshot(path.join(context.workDir, "identity-conflict-project")),
      JSON.parse(
        await readFile(
          path.join(context.workDir, "identity-conflict-before.json"),
          "utf8",
        ),
      ),
    );
  },
};

export default journey;
