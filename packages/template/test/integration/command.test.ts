import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml } from "yaml";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import {
  executeCliRuntime,
  type InternalCliRuntime,
} from "../../src/cli-runner.ts";
import {
  type PackageRole,
  type PresetDefinition,
  type WorkspaceEnvironment,
  type WorkspaceTemplateRoots,
} from "../../src/core/index.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";
import {
  loadBuiltInPresets,
  resolveTemplateWorkspaceRoots,
} from "../../src/presets/index.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    cwd: options.cwd ?? process.cwd(),
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

function testOverrideRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly presets?: readonly PresetDefinition[];
    readonly workspaceRoots?: WorkspaceTemplateRoots;
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const runtime: InternalCliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    cwd: options.cwd ?? process.cwd(),
    ...(options.presets === undefined ? {} : { presets: options.presets }),
    ...(options.workspaceRoots === undefined
      ? {}
      : { workspaceRoots: options.workspaceRoots }),
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "template-cli-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

function rolePreset(
  alias: string,
  role: PackageRole,
  defaultName: string,
  defaultParentDir = "packages",
): PresetDefinition {
  const tsLib = loadBuiltInPresets().find(
    (preset) => preset.alias === "ts-lib",
  )!;
  const baseDef = tsLib.nodes[0]!.referencePackage;
  return {
    alias,
    title: `Role ${role}`,
    description: `Synthetic test preset for role ${role}`,
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "main",
        defaultName,
        defaultPath: `${defaultParentDir}/${defaultName}`,
        referencePackage: {
          ...baseDef,
          role,
        },
      },
    ],
  };
}

void describe("CLI contract", () => {
  void it("exposes help, version, and native v6 contract discovery with replayable examples", async () => {
    const version = testRuntime(["--version"]);
    assert.equal(await runCli(version.runtime), 0);
    assert.equal(
      version.stdout(),
      `${identity.commandName} ${identity.version}\n`,
    );

    const help = testRuntime(["--help"]);
    assert.equal(await runCli(help.runtime), 0);
    assert.ok(help.stdout().includes(identity.commandName));
    assert.ok(help.stdout().includes("presets"));
    assert.ok(help.stdout().includes("init"));
    assert.ok(help.stdout().includes("--schema"));

    const directory = testRuntime(["--schema"]);
    assert.equal(await runCli(directory.runtime), 0);
    assert.equal(directory.stderr(), "");
    assert.partialDeepStrictEqual(JSON.parse(directory.stdout()), {
      kind: "directory",
      schemaVersion: "6",
      name: identity.commandName,
      children: [
        { command: "presets", kind: "command", name: "presets" },
        { command: "init", kind: "command", name: "init" },
      ],
    });

    for (const commandName of ["presets", "init"] as const) {
      const summary = testRuntime([commandName, "--schema"]);
      assert.equal(await runCli(summary.runtime), 0);
      assert.equal(summary.stderr(), "");
      const summaryDoc = JSON.parse(summary.stdout()) as {
        readonly examples: readonly { readonly argv: readonly string[] }[];
      };
      assert.ok(summaryDoc.examples.length >= 2);
      for (const example of summaryDoc.examples) {
        await withTempDir(async (cwd) => {
          const replay = testRuntime(example.argv, { cwd });
          assert.equal(await runCli(replay.runtime), 0);
          assert.equal(replay.stderr(), "");
        });
      }
    }

    const initInputQuery = testRuntime(["init", "--schema=input"]);
    assert.equal(await runCli(initInputQuery.runtime), 0);
    assert.partialDeepStrictEqual(JSON.parse(initInputQuery.stdout()), {
      kind: "input",
      schemaVersion: "6",
      command: "init",
    });
  });

  void it("lists built-in presets in structured and text modes", async () => {
    const structured = testRuntime(["presets"]);
    assert.equal(await runCli(structured.runtime), 0);
    assert.equal(structured.stderr(), "");
    const payload = JSON.parse(structured.stdout()) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly presets: readonly {
          readonly name: string;
          readonly title: string;
          readonly description: string;
          readonly topology: string;
          readonly roles: readonly string[];
        }[];
      };
    };
    assert.equal(payload.kind, "data");
    assert.equal(payload.variant, "listed");
    const tsLib = payload.data.presets.find((p) => p.name === "ts-lib");
    assert.ok(tsLib !== undefined);
    assert.equal(tsLib.topology, "configurable-primary-package");
    assert.deepStrictEqual(tsLib.roles, ["shared-library"]);

    const human = testRuntime(["presets", "--output", "text"]);
    assert.equal(await runCli(human.runtime), 0);
    assert.equal(human.stderr(), "");
    assert.ok(human.stdout().includes("ts-lib"));
  });

  void it("initializes a clean native ts-lib monorepo without metadata or TODO.md", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-sdk");
      const run = testRuntime(["init", targetDir, "--preset", "ts-lib"]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const doc = JSON.parse(run.stdout()) as {
        readonly kind: string;
        readonly variant: string;
        readonly data: {
          readonly dryRun: boolean;
          readonly scope: string;
          readonly repositoryName: string;
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
            readonly role: string;
            readonly preset: string;
          }[];
          readonly files: readonly string[];
        };
      };
      assert.equal(doc.kind, "data");
      assert.equal(doc.variant, "initialized");
      assert.equal(doc.data.dryRun, false);
      assert.equal(doc.data.scope, "acme-sdk");
      assert.equal(doc.data.repositoryName, "acme-sdk");
      assert.deepStrictEqual(doc.data.packages, [
        {
          name: "@acme-sdk/lib",
          path: "packages/lib",
          role: "shared-library",
          preset: "ts-lib",
        },
      ]);

      // Zero .template/ or TODO.md
      assert.equal(existsSync(path.join(targetDir, ".template")), false);
      assert.equal(existsSync(path.join(targetDir, "TODO.md")), false);

      // Shared base, Changesets, task-gates, workflows, devcontainer, vscode
      for (const expected of [
        "AGENTS.md",
        ".gitignore",
        "package.json",
        "turbo.json",
        "pnpm-workspace.yaml",
        "scripts/task-gates.ts",
        ".changeset/config.json",
        ".github/workflows/check.yml",
        ".github/workflows/release.yml",
        ".github/dependabot.yml",
        ".devcontainer/Dockerfile",
        ".devcontainer/devcontainer.json",
        ".vscode/extensions.json",
        ".vscode/settings.json",
        "packages/tooling-config/package.json",
        "packages/lib/package.json",
        "packages/lib/src/index.ts",
        "packages/lib/test/greet.test.ts",
      ]) {
        assert.equal(
          existsSync(path.join(targetDir, expected)),
          true,
          `Missing expected generated file: ${expected}`,
        );
      }

      // Root package.json & turbo.json
      const rootPkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly scripts: Record<string, string>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(rootPkg.name, "acme-sdk");
      assert.ok("publication:pack" in rootPkg.scripts);
      assert.ok("publication:publish" in rootPkg.scripts);
      assert.equal(
        rootPkg.devDependencies["@acme-sdk/tooling-config"],
        "workspace:*",
      );
      assert.equal(rootPkg.devDependencies["@changesets/cli"], "catalog:");

      const rootTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "turbo.json"), "utf8"),
      ) as { readonly tasks: Record<string, { readonly tags: string[] }> };
      assert.deepStrictEqual(rootTurbo.tasks["//#check"]?.tags, [
        "quality:entry",
      ]);
      assert.deepStrictEqual(rootTurbo.tasks["//#fix"]?.tags, ["work:repair"]);

      // Shared tooling-config manifest rewritten without ./package.json or ./reference leak
      const toolingPkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/tooling-config/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly exports: Record<string, unknown>;
      };
      assert.equal(toolingPkg.name, "@acme-sdk/tooling-config");
      assert.equal(Object.hasOwn(toolingPkg.exports, "./package.json"), false);
      assert.equal(Object.hasOwn(toolingPkg.exports, "./reference"), false);

      // Generated ts-lib package manifest, exports, tsconfig, and test specifiers rewritten
      const libPkg = JSON.parse(
        readFileSync(path.join(targetDir, "packages/lib/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly exports: Record<string, unknown>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(libPkg.name, "@acme-sdk/lib");
      assert.equal(Object.hasOwn(libPkg.exports, "./package.json"), false);
      assert.equal(Object.hasOwn(libPkg.exports, "./reference"), false);
      assert.equal(
        libPkg.devDependencies["@acme-sdk/tooling-config"],
        "workspace:*",
      );

      const libTest = readFileSync(
        path.join(targetDir, "packages/lib/test/greet.test.ts"),
        "utf8",
      );
      assert.ok(libTest.includes('from "@acme-sdk/lib"'));
      assert.equal(libTest.includes("@boringparts/reference-ts-lib"), false);

      const rootOxfmt = readFileSync(
        path.join(targetDir, "oxfmt.config.ts"),
        "utf8",
      );
      assert.ok(rootOxfmt.includes("@acme-sdk/tooling-config/oxfmt"));
      const rootOxlint = readFileSync(
        path.join(targetDir, "oxlint.config.ts"),
        "utf8",
      );
      assert.ok(rootOxlint.includes("@acme-sdk/tooling-config/oxlint"));
      const rootTsConfig = readFileSync(
        path.join(targetDir, "tsconfig.config.json"),
        "utf8",
      );
      assert.ok(rootTsConfig.includes("@acme-sdk/tooling-config/node.json"));

      const libBuildTsconfig = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/lib/tsconfig.build.json"),
          "utf8",
        ),
      ) as {
        readonly compilerOptions: {
          readonly lib: string[];
          readonly types: string[];
          readonly customConditions: string[];
        };
      };
      assert.deepStrictEqual(libBuildTsconfig.compilerOptions.lib, ["es2024"]);
      assert.deepStrictEqual(libBuildTsconfig.compilerOptions.types, []);
      assert.deepStrictEqual(
        libBuildTsconfig.compilerOptions.customConditions,
        [],
      );

      // Pruned pnpm-workspace.yaml catalog
      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly packages: string[];
        readonly catalog: Record<string, string>;
        readonly catalogs?: unknown;
        readonly minimumReleaseAgeExclude?: unknown;
      };
      assert.deepStrictEqual(workspaceYaml.packages, ["packages/*"]);
      assert.ok("zod" in workspaceYaml.catalog);
      assert.ok("@changesets/cli" in workspaceYaml.catalog);
      assert.equal("vue" in workspaceYaml.catalog, false);
      assert.equal("@playwright/test" in workspaceYaml.catalog, false);
      assert.equal(workspaceYaml.catalogs, undefined);
      assert.equal(workspaceYaml.minimumReleaseAgeExclude, undefined);

      // Generated dependabot.yml
      const dependabot = parseYaml(
        readFileSync(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
      ) as {
        readonly updates: readonly {
          readonly "package-ecosystem": string;
          readonly directory: string;
        }[];
      };
      assert.deepStrictEqual(
        dependabot.updates.map((u) => [u["package-ecosystem"], u.directory]),
        [
          ["devcontainers", "/"],
          ["npm", "/"],
          ["github-actions", "/"],
          ["docker", "/.devcontainer"],
        ],
      );
    });
  });

  void it("supports repeatable --preset instances, --link, --scope normalization, and zero-write --dry-run", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "multi-lib-repo");
      const baseArgs = [
        "init",
        targetDir,
        "--preset",
        "ts-lib:core",
        "--preset",
        "ts-lib:utils:libs/utils",
        "--link",
        "libs/utils:packages/core",
        "--scope",
        "@acme-org",
      ];

      const dry = testRuntime([...baseArgs, "--dry-run"]);
      assert.equal(await runCli(dry.runtime), 0);
      assert.equal(dry.stderr(), "");
      const dryDoc = JSON.parse(dry.stdout()) as {
        readonly variant: string;
        readonly data: {
          readonly dryRun: boolean;
          readonly scope: string;
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
          }[];
          readonly links: readonly {
            readonly consumer: string;
            readonly provider: string;
          }[];
          readonly files: readonly string[];
        };
      };
      assert.equal(dryDoc.variant, "planned");
      assert.equal(dryDoc.data.dryRun, true);
      assert.equal(dryDoc.data.scope, "acme-org");
      assert.deepStrictEqual(
        dryDoc.data.packages.map((p) => [p.name, p.path]),
        [
          ["@acme-org/core", "packages/core"],
          ["@acme-org/utils", "libs/utils"],
        ],
      );
      assert.deepStrictEqual(dryDoc.data.links, [
        { consumer: "libs/utils", provider: "packages/core" },
      ]);
      assert.ok(dryDoc.data.files.includes("packages/core/package.json"));
      assert.ok(dryDoc.data.files.includes("libs/utils/package.json"));
      assert.equal(existsSync(targetDir), false);

      // Execute without --dry-run and unprefixed --scope
      const real = testRuntime([
        "init",
        targetDir,
        "--preset",
        "ts-lib:core",
        "--preset",
        "ts-lib:utils:libs/utils",
        "--link",
        "libs/utils:packages/core",
        "--scope",
        "acme-org",
      ]);
      assert.equal(await runCli(real.runtime), 0);
      assert.equal(real.stderr(), "");

      const utilsPkg = JSON.parse(
        readFileSync(path.join(targetDir, "libs/utils/package.json"), "utf8"),
      ) as {
        readonly dependencies: Record<string, string>;
      };
      assert.equal(utilsPkg.dependencies["@acme-org/core"], "workspace:*");

      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as { readonly packages: string[] };
      assert.deepStrictEqual(workspaceYaml.packages, ["libs/*", "packages/*"]);
    });
  });

  void it("fails fast with exit code 2 (invalidRequest) and zero disk writes on invalid inputs and role boundary violations", async () => {
    const fixedPreset: PresetDefinition = {
      ...rolePreset("fixed-app", "browser-app", "web", "apps"),
      topology: "fixed",
    };
    const testPresets = [
      ...loadBuiltInPresets(),
      fixedPreset,
      rolePreset("node-lib", "node-library", "node-lib"),
      rolePreset("ts-cli", "cli-tool", "cli"),
      rolePreset("vue-app", "browser-app", "web", "apps"),
      rolePreset("rust-bin", "native-package", "worker", "crates"),
    ];

    const invalidCases: readonly {
      readonly label: string;
      readonly dirName: string;
      readonly args: readonly string[];
      readonly expectedCode: string;
    }[] = [
      {
        label: "unknown preset",
        dirName: "valid-repo",
        args: ["--preset", "unknown-preset"],
        expectedCode: "PRESET_UNKNOWN",
      },
      {
        label: "fixed topology override",
        dirName: "valid-repo",
        args: ["--preset", "fixed-app:custom"],
        expectedCode: "FIXED_TOPOLOGY_OVERRIDE",
      },
      {
        label: "invalid preset syntax",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:"],
        expectedCode: "INVALID_PRESET_SPEC",
      },
      {
        label: "invalid link syntax",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib", "--link", "bad-link-syntax"],
        expectedCode: "INVALID_LINK_SPEC",
      },
      {
        label: "invalid package leaf name (uppercase)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:BadName"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (Node builtin)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:fs"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (reserved node_modules)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:node_modules"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (reserved favicon.ico)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:favicon.ico"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (leading dot)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:.core"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (leading underscore)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:_core"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (leading hyphen)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:-core"],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid package leaf name (exceeds 214 characters)",
        dirName: "valid-repo",
        args: ["--preset", `ts-lib:${"a".repeat(215)}`],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label:
          "invalid scoped package name (combined @scope/name exceeds 214 characters)",
        dirName: "valid-repo",
        args: [
          "--scope",
          "a".repeat(200),
          "--preset",
          `ts-lib:${"b".repeat(20)}`,
        ],
        expectedCode: "INVALID_PACKAGE_NAME",
      },
      {
        label: "invalid single-segment package path",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:core:single"],
        expectedCode: "INVALID_PACKAGE_PATH",
      },
      {
        label: "invalid traversal package path",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:core:../escape"],
        expectedCode: "INVALID_PACKAGE_PATH",
      },
      ...(
        [
          ".git",
          ".github",
          ".devcontainer",
          ".vscode",
          ".local",
          "node_modules",
          "dist",
          "target",
          "coverage",
          "playwright-report",
          "test-results",
        ] as const
      ).map((reserved) => ({
        label: `reserved path ${reserved}`,
        dirName: "valid-repo",
        args: ["--preset", `ts-lib:core:${reserved}/core`],
        expectedCode: "RESERVED_PACKAGE_PATH",
      })),
      {
        label: "invalid explicit scope",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib", "--scope", "Bad Scope"],
        expectedCode: "INVALID_PACKAGE_SCOPE",
      },
      {
        label: "invalid explicit scope (leading underscore)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib", "--scope", "_bad"],
        expectedCode: "INVALID_PACKAGE_SCOPE",
      },
      {
        label: "invalid explicit scope (leading dot)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib", "--scope", ".bad"],
        expectedCode: "INVALID_PACKAGE_SCOPE",
      },
      {
        label: "invalid explicit scope (exceeds 214 characters)",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib", "--scope", "a".repeat(215)],
        expectedCode: "INVALID_PACKAGE_SCOPE",
      },
      {
        label: "un-derivable repository scope",
        dirName: "Invalid_Repo",
        args: ["--preset", "ts-lib"],
        expectedCode: "INVALID_REPOSITORY_SCOPE",
      },
      {
        label: "conflict with packages/tooling-config",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:tooling-config"],
        expectedCode: "CONFLICTING_PACKAGE_IDENTITY",
      },
      {
        label: "duplicate package name",
        dirName: "valid-repo",
        args: [
          "--preset",
          "ts-lib:core:packages/one",
          "--preset",
          "ts-lib:core:packages/two",
        ],
        expectedCode: "CONFLICTING_PACKAGE_IDENTITY",
      },
      {
        label: "duplicate package path",
        dirName: "valid-repo",
        args: [
          "--preset",
          "ts-lib:one:packages/shared",
          "--preset",
          "ts-lib:two:packages/shared",
        ],
        expectedCode: "CONFLICTING_PACKAGE_IDENTITY",
      },
      {
        label: "unknown link endpoint",
        dirName: "valid-repo",
        args: [
          "--preset",
          "ts-lib:core",
          "--link",
          "packages/core:packages/missing",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "shared-library cannot link node-library",
        dirName: "valid-repo",
        args: [
          "--preset",
          "ts-lib",
          "--preset",
          "node-lib",
          "--link",
          "packages/lib:packages/node-lib",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "browser-app cannot link node-library",
        dirName: "valid-repo",
        args: [
          "--preset",
          "vue-app",
          "--preset",
          "node-lib",
          "--link",
          "apps/web:packages/node-lib",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "native-package cannot link shared-library",
        dirName: "valid-repo",
        args: [
          "--preset",
          "rust-bin",
          "--preset",
          "ts-lib",
          "--link",
          "crates/worker:packages/lib",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "cli-tool cannot be linked as provider",
        dirName: "valid-repo",
        args: [
          "--preset",
          "ts-cli",
          "--preset",
          "ts-cli:other",
          "--link",
          "packages/other:packages/cli",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
    ];

    await withTempDir(async (workspaceDir) => {
      for (const testCase of invalidCases) {
        const targetDir = path.join(workspaceDir, testCase.dirName);
        const run = testOverrideRuntime(["init", targetDir, ...testCase.args], {
          presets: testPresets,
        });
        assert.equal(await executeCliRuntime(run.runtime), 2, testCase.label);
        assert.equal(run.stdout(), "", testCase.label);
        const failure = JSON.parse(run.stderr()) as {
          readonly kind: string;
          readonly variant: string;
          readonly data: {
            readonly issues: readonly { readonly code: string }[];
          };
        };
        assert.equal(failure.kind, "failure", testCase.label);
        assert.equal(failure.variant, "invalidRequest", testCase.label);
        assert.ok(
          failure.data.issues.some(
            (issue) => issue.code === testCase.expectedCode,
          ),
          `${testCase.label}: expected ${testCase.expectedCode}, got ${JSON.stringify(failure.data.issues)}`,
        );
        assert.equal(existsSync(targetDir), false, testCase.label);
      }

      // Allowed cross-role links succeed in dry-run
      const allowedRun = testOverrideRuntime(
        [
          "init",
          path.join(workspaceDir, "allowed-repo"),
          "--preset",
          "ts-cli",
          "--preset",
          "node-lib",
          "--preset",
          "ts-lib",
          "--link",
          "packages/cli:packages/node-lib",
          "--link",
          "packages/cli:packages/lib",
          "--link",
          "packages/node-lib:packages/lib",
          "--dry-run",
        ],
        { presets: testPresets },
      );
      assert.equal(await executeCliRuntime(allowedRun.runtime), 0);
      assert.equal(allowedRun.stderr(), "");

      // Valid restricted leaf names and scopes with dots, underscores, and hyphens succeed in dry-run
      const validCustomRun = testOverrideRuntime(
        [
          "init",
          path.join(workspaceDir, "custom-name-repo"),
          "--scope",
          "my_scope.v2-org",
          "--preset",
          "ts-lib:my_pkg.v2-core:packages/my-core",
          "--dry-run",
        ],
        { presets: testPresets },
      );
      assert.equal(await executeCliRuntime(validCustomRun.runtime), 0);
      assert.equal(validCustomRun.stderr(), "");
    });
  });

  void it("returns exit code 1 (operationFailed) without modifying an existing non-empty directory", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "existing-repo");
      const sentinel = path.join(targetDir, "existing.txt");
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(sentinel, "preserve me\n", "utf8");

      const run = testRuntime(["init", targetDir, "--preset", "ts-lib"]);
      assert.equal(await runCli(run.runtime), 1);
      assert.equal(run.stdout(), "");
      assert.partialDeepStrictEqual(JSON.parse(run.stderr()), {
        kind: "failure",
        variant: "operationFailed",
        data: { targetDir },
      });
      assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n");
      assert.equal(existsSync(path.join(targetDir, "package.json")), false);
    });
  });

  void it("exits 0 on stdout EPIPE and 70 on unexpected runtime errors without leaking internals", async () => {
    const presetsRun = testRuntime(["presets"]);
    assert.equal(
      await runCli({
        ...presetsRun.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      0,
    );

    const failRun = testRuntime(["presets"]);
    assert.equal(
      await runCli({
        ...failRun.runtime,
        write: async () => {
          throw new Error("disk failure");
        },
      }),
      70,
    );

    const brokenArgv = ["node", identity.commandName];
    Object.defineProperty(brokenArgv, "slice", {
      value() {
        throw new Error("secret internal failure");
      },
    });
    assert.equal(await runCli({ ...failRun.runtime, argv: brokenArgv }), 70);
    assert.ok(failRun.stderr().includes("Command execution failed"));
    assert.equal(failRun.stderr().includes("secret internal failure"), false);
  });

  void it("auto-discovers data/ and executable scripts without manual file lists and excludes .local/ in .gitignore", async () => {
    await withTempDir(async (workspaceDir) => {
      const fixtureRefDir = path.join(workspaceDir, "fixture-ref");
      const targetDir = path.join(workspaceDir, "data-business-repo");
      const basePreset = loadBuiltInPresets().find(
        (preset) => preset.alias === "ts-lib",
      )!;
      const baseNode = basePreset.nodes[0]!;

      cpSync(baseNode.referencePackage.packageDir, fixtureRefDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== "node_modules",
      });
      mkdirSync(path.join(fixtureRefDir, "data"), { recursive: true });
      writeFileSync(
        path.join(fixtureRefDir, "data", "catalog.json"),
        '{"items":["alpha"]}\n',
      );
      mkdirSync(path.join(fixtureRefDir, "scripts"), { recursive: true });
      const fixtureScript = path.join(fixtureRefDir, "scripts", "check.sh");
      writeFileSync(fixtureScript, "#!/usr/bin/env sh\nexit 0\n");
      chmodSync(fixtureScript, 0o755);

      const fixturePreset: PresetDefinition = {
        ...basePreset,
        alias: "ts-lib-with-data",
        nodes: [
          {
            ...baseNode,
            referencePackage: {
              ...baseNode.referencePackage,
              packageDir: fixtureRefDir,
            },
          },
        ],
      };

      const run = testOverrideRuntime(
        ["init", targetDir, "--preset", "ts-lib-with-data"],
        { presets: [fixturePreset] },
      );
      assert.equal(await executeCliRuntime(run.runtime), 0);
      assert.equal(run.stderr(), "");
      assert.equal(
        readFileSync(
          path.join(targetDir, "packages/lib/data/catalog.json"),
          "utf8",
        ),
        '{"items":["alpha"]}\n',
      );
      assert.notEqual(
        statSync(path.join(targetDir, "packages/lib/scripts/check.sh")).mode &
          0o111,
        0,
      );
      const gitignore = readFileSync(
        path.join(targetDir, ".gitignore"),
        "utf8",
      );
      assert.ok(gitignore.split(/\r?\n/u).includes(".local/"));
      assert.ok(gitignore.split(/\r?\n/u).includes("*.tsbuildinfo"));
      assert.equal(gitignore.split(/\r?\n/u).includes("data/"), false);
    });
  });

  void it("excludes .gitignore-ignored files from source-mode reference packages while preserving data/ and failing when workspace-root toolchain fields are missing", async () => {
    const tsLibRefDir = loadBuiltInPresets().find(
      (preset) => preset.alias === "ts-lib",
    )!.nodes[0]!.referencePackage.packageDir;
    const localDir = path.join(tsLibRefDir, ".local");
    const localExisted = existsSync(localDir);
    const ignoredLocalFile = path.join(localDir, "mc02-ignored-probe.txt");
    const ignoredEnvFile = path.join(tsLibRefDir, ".env");

    await withTempDir(async (workspaceDir) => {
      try {
        mkdirSync(localDir, { recursive: true });
        writeFileSync(ignoredLocalFile, "secret local state\n", "utf8");
        writeFileSync(ignoredEnvFile, "SECRET_TOKEN=local\n", "utf8");

        const targetDir = path.join(workspaceDir, "clean-source-repo");
        const run = testRuntime(["init", targetDir, "--preset", "ts-lib"]);
        assert.equal(await runCli(run.runtime), 0, run.stderr());
        assert.equal(
          existsSync(
            path.join(targetDir, "packages/lib/.local/mc02-ignored-probe.txt"),
          ),
          false,
        );
        assert.equal(
          existsSync(path.join(targetDir, "packages/lib/.env")),
          false,
        );
      } finally {
        rmSync(ignoredLocalFile, { force: true });
        rmSync(ignoredEnvFile, { force: true });
        if (!localExisted) {
          rmSync(localDir, { recursive: true, force: true });
        }
      }

      // Removing packageManager from workspace-root/package.json must fail rather than falling back to hardcoded defaults.
      const defaultRoots = resolveTemplateWorkspaceRoots();
      const customRootRefDir = path.join(workspaceDir, "custom-workspace-root");
      cpSync(defaultRoots.workspaceRoot.packageDir, customRootRefDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== "node_modules",
      });
      const baselineTargetDir = path.join(workspaceDir, "baseline-root-ok");
      const validCustomRoots: WorkspaceTemplateRoots = {
        ...defaultRoots,
        workspaceRoot: {
          ...defaultRoots.workspaceRoot,
          packageDir: customRootRefDir,
        },
      };
      const validRun = testOverrideRuntime(
        ["init", baselineTargetDir, "--preset", "ts-lib", "--dry-run"],
        { workspaceRoots: validCustomRoots },
      );
      assert.equal(await executeCliRuntime(validRun.runtime), 0);

      // Modifying workspace-root/turbo.json reflects deterministically in generated root turbo.json.
      const customRootTurbo = JSON.parse(
        readFileSync(path.join(customRootRefDir, "turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<string, Record<string, unknown>>;
      };
      customRootTurbo.tasks["smoke:check"] = {
        dependsOn: ["lint:fix", "^build"],
        outputs: ["coverage/**"],
        tags: ["quality:light"],
      };
      writeFileSync(
        path.join(customRootRefDir, "turbo.json"),
        `${JSON.stringify(customRootTurbo, null, 2)}\n`,
      );
      const customTurboRepoDir = path.join(workspaceDir, "custom-root-turbo");
      const customTurboRun = testOverrideRuntime(
        ["init", customTurboRepoDir, "--preset", "ts-lib"],
        { workspaceRoots: validCustomRoots },
      );
      assert.equal(await executeCliRuntime(customTurboRun.runtime), 0);
      const generatedRootTurbo = JSON.parse(
        readFileSync(path.join(customTurboRepoDir, "turbo.json"), "utf8"),
      ) as {
        readonly extends?: unknown;
        readonly tags?: unknown;
        readonly globalDependencies: readonly string[];
        readonly tasks: Record<
          string,
          {
            readonly dependsOn?: readonly string[];
            readonly outputs?: readonly string[];
            readonly tags?: readonly string[];
          }
        >;
      };
      assert.equal(generatedRootTurbo.extends, undefined);
      assert.equal(generatedRootTurbo.tags, undefined);
      assert.equal("//#build" in generatedRootTurbo.tasks, false);
      assert.deepStrictEqual(generatedRootTurbo.tasks["//#smoke:check"], {
        dependsOn: ["//#lint:fix", "^build"],
        outputs: ["coverage/**"],
        tags: ["quality:light"],
      });
      assert.deepStrictEqual(generatedRootTurbo.globalDependencies, [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        "packages/tooling-config/oxfmt.config.ts",
        "packages/tooling-config/oxlint.config.ts",
      ]);

      const invalidPkgJson = JSON.parse(
        readFileSync(path.join(customRootRefDir, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      delete invalidPkgJson.packageManager;
      writeFileSync(
        path.join(customRootRefDir, "package.json"),
        `${JSON.stringify(invalidPkgJson, null, 2)}\n`,
      );
      const invalidTargetDir = path.join(workspaceDir, "missing-pm-fail");
      const invalidRun = testOverrideRuntime(
        ["init", invalidTargetDir, "--preset", "ts-lib", "--dry-run"],
        { workspaceRoots: validCustomRoots },
      );
      assert.equal(await executeCliRuntime(invalidRun.runtime), 70);
      assert.equal(existsSync(invalidTargetDir), false);
    });
  });

  void it("rejects base singleton --link requests and multi-CLI bin collisions", async () => {
    await withTempDir(async (workspaceDir) => {
      const rootLinkDir = path.join(workspaceDir, "root-link");
      const rootLinkRun = testRuntime([
        "init",
        rootLinkDir,
        "--preset",
        "ts-lib",
        "--link",
        "packages/lib:.",
      ]);
      assert.equal(await runCli(rootLinkRun.runtime), 2);
      assert.ok(
        (
          JSON.parse(rootLinkRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some((issue) => issue.code === "INVALID_PACKAGE_PATH"),
      );
      assert.equal(existsSync(rootLinkDir), false);

      const toolingLinkDir = path.join(workspaceDir, "tooling-link");
      const toolingLinkRun = testRuntime([
        "init",
        toolingLinkDir,
        "--preset",
        "ts-lib",
        "--link",
        "packages/lib:packages/tooling-config",
      ]);
      assert.equal(await runCli(toolingLinkRun.runtime), 2);
      assert.ok(
        (
          JSON.parse(toolingLinkRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some((issue) => issue.code === "UNSUPPORTED_LINK"),
      );
      assert.equal(existsSync(toolingLinkDir), false);

      const cliCollisionDir = path.join(workspaceDir, "cli-collision");
      const cliCollisionRun = testRuntime([
        "init",
        cliCollisionDir,
        "--preset",
        "ts-cli:tool:packages/tool-one",
        "--preset",
        "ts-cli:tool:packages/tool-two",
      ]);
      assert.equal(await runCli(cliCollisionRun.runtime), 2);
      const cliCollisionIssues = (
        JSON.parse(cliCollisionRun.stderr()) as {
          readonly data: {
            readonly issues: readonly {
              readonly code: string;
              readonly message: string;
            }[];
          };
        }
      ).data.issues;
      assert.ok(
        cliCollisionIssues.some(
          (issue) =>
            issue.code === "CONFLICTING_PACKAGE_IDENTITY" &&
            issue.message.includes("Duplicate CLI command name"),
        ),
      );
      assert.equal(existsSync(cliCollisionDir), false);
    });
  });

  void it("deduplicates equivalent environment metadata across multiple apps and enables unified root dev", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "multi-web");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "vue-app:web-a",
        "--preset",
        "vue-app:web-b",
      ]);
      assert.equal(await runCli(run.runtime), 0, run.stderr());
      assert.equal(run.stderr(), "");

      const rootPkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      ) as { readonly scripts: Record<string, string> };
      assert.equal(rootPkg.scripts.dev, "turbo run dev");

      const dockerfile = readFileSync(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.equal(
        dockerfile.split("ARG PLAYWRIGHT_CLI_PACKAGE").length - 1,
        1,
        "Equivalent browser-test layers must deduplicate idempotently",
      );

      const extensions = JSON.parse(
        readFileSync(path.join(targetDir, ".vscode/extensions.json"), "utf8"),
      ) as { readonly recommendations: readonly string[] };
      assert.deepStrictEqual(extensions.recommendations, [
        "oxc.oxc-vscode",
        "Vue.volar",
        "bradlc.vscode-tailwindcss",
        "vitest.explorer",
      ]);
    });
  });

  void it("fails fast on non-equivalent environment metadata conflicts and directory ownership violations", async () => {
    await withTempDir(async (workspaceDir) => {
      const basePreset = loadBuiltInPresets().find(
        (preset) => preset.alias === "ts-lib",
      )!;
      const baseNode = basePreset.nodes[0]!;

      const makeMetaPreset = (
        alias: string,
        defaultName: string,
        environment: WorkspaceEnvironment,
      ): PresetDefinition => ({
        ...basePreset,
        alias,
        nodes: [
          {
            ...baseNode,
            defaultName,
            defaultPath: `packages/${defaultName}`,
            referencePackage: {
              ...baseNode.referencePackage,
              environment,
            },
          },
        ],
      });

      const conflictCases: readonly {
        readonly label: string;
        readonly metaA: WorkspaceEnvironment;
        readonly metaB: WorkspaceEnvironment;
      }[] = [
        {
          label: "conflicting devcontainer buildArgs",
          metaA: { devcontainer: { buildArgs: { TOOL_VER: "1.0.0" } } },
          metaB: { devcontainer: { buildArgs: { TOOL_VER: "2.0.0" } } },
        },
        {
          label: "conflicting devcontainer containerEnv",
          metaA: { devcontainer: { containerEnv: { RUST_BACKTRACE: "1" } } },
          metaB: { devcontainer: { containerEnv: { RUST_BACKTRACE: "0" } } },
        },
        {
          label: "conflicting devcontainer mount target",
          metaA: {
            devcontainer: {
              mounts: [{ type: "volume", source: "cache-a", target: "/cache" }],
            },
          },
          metaB: {
            devcontainer: {
              mounts: [{ type: "volume", source: "cache-b", target: "/cache" }],
            },
          },
        },
        {
          label: "conflicting vscode non-array setting",
          metaA: { vscode: { settings: { "editor.formatOnSave": true } } },
          metaB: { vscode: { settings: { "editor.formatOnSave": false } } },
        },
        {
          label: "conflicting dependabot npm group",
          metaA: {
            dependabot: { npmGroups: { orm: { patterns: ["drizzle-*"] } } },
          },
          metaB: {
            dependabot: { npmGroups: { orm: { patterns: ["prisma-*"] } } },
          },
        },
        {
          label: "conflicting dependabot update interval",
          metaA: {
            dependabot: {
              updates: [
                {
                  packageEcosystem: "docker",
                  directory: "/packages/app",
                  interval: "weekly",
                },
              ],
            },
          },
          metaB: {
            dependabot: {
              updates: [
                {
                  packageEcosystem: "docker",
                  directory: "/packages/app",
                  interval: "daily",
                },
              ],
            },
          },
        },
      ];

      for (const [index, testCase] of conflictCases.entries()) {
        const targetDir = path.join(workspaceDir, `meta-conflict-${index}`);
        const run = testOverrideRuntime(
          ["init", targetDir, "--preset", "a", "--preset", "b"],
          {
            presets: [
              makeMetaPreset("a", "pkg-a", testCase.metaA),
              makeMetaPreset("b", "pkg-b", testCase.metaB),
            ],
          },
        );
        assert.equal(await executeCliRuntime(run.runtime), 2, testCase.label);
        assert.equal(run.stdout(), "", testCase.label);
        const failure = JSON.parse(run.stderr()) as {
          readonly data: {
            readonly issues: readonly { readonly code: string }[];
          };
        };
        assert.ok(
          failure.data.issues.some(
            (issue) => issue.code === "CONFLICTING_ENVIRONMENT_METADATA",
          ),
          testCase.label,
        );
        assert.equal(existsSync(targetDir), false, testCase.label);
      }

      // Directory ownership violations (resource escape, transformFiles escape, duplicate path)
      const escapeResourcePreset: PresetDefinition = {
        ...basePreset,
        alias: "escape-resource",
        nodes: [
          {
            ...baseNode,
            referencePackage: {
              ...baseNode.referencePackage,
              resources: [
                {
                  sourcePath: "resources/gitignore",
                  targetPath: "../../hijack.txt",
                },
              ],
            },
          },
        ],
      };

      const escapeHookPreset: PresetDefinition = {
        ...basePreset,
        alias: "escape-hook",
        nodes: [
          {
            ...baseNode,
            referencePackage: {
              ...baseNode.referencePackage,
              transformFiles: (files) => {
                const next = new Map(files);
                next.set("../../escape.txt", {
                  targetPath: "../../escape.txt",
                  content: new TextEncoder().encode("escaped\n"),
                  executable: false,
                });
                return next;
              },
            },
          },
        ],
      };

      const injectHookPreset: PresetDefinition = {
        ...basePreset,
        alias: "inject-hook",
        nodes: [
          {
            ...baseNode,
            referencePackage: {
              ...baseNode.referencePackage,
              transformFiles: (files) => {
                const next = new Map(files);
                next.set("src/injected.ts", {
                  targetPath: "src/injected.ts",
                  content: new TextEncoder().encode(
                    "export const injected = 1;\n",
                  ),
                  executable: false,
                });
                return next;
              },
            },
          },
        ],
      };

      const duplicateResourcePreset: PresetDefinition = {
        ...basePreset,
        alias: "duplicate-resource",
        nodes: [
          {
            ...baseNode,
            referencePackage: {
              ...baseNode.referencePackage,
              resources: [
                {
                  sourcePath: "resources/gitignore",
                  targetPath: "package.json",
                },
              ],
            },
          },
        ],
      };

      for (const [label, preset] of [
        ["resource boundary escape", escapeResourcePreset],
        ["transformFiles boundary escape", escapeHookPreset],
        ["transformFiles unbacked file injection", injectHookPreset],
        ["duplicate target path", duplicateResourcePreset],
      ] as const) {
        const targetDir = path.join(workspaceDir, `ownership-${preset.alias}`);
        const run = testOverrideRuntime(
          ["init", targetDir, "--preset", preset.alias],
          { presets: [preset] },
        );
        assert.equal(await executeCliRuntime(run.runtime), 2, label);
        assert.equal(run.stdout(), "", label);
        const failure = JSON.parse(run.stderr()) as {
          readonly data: {
            readonly issues: readonly { readonly code: string }[];
          };
        };
        assert.ok(
          failure.data.issues.some(
            (issue) => issue.code === "DIRECTORY_OWNERSHIP_VIOLATION",
          ),
          label,
        );
        assert.equal(existsSync(targetDir), false, label);
      }

      // WorkspaceRoot attempting to emit a resource into a subpackage directory is also rejected.
      const defaultRoots = resolveTemplateWorkspaceRoots();
      const intrusiveRoots: WorkspaceTemplateRoots = {
        ...defaultRoots,
        workspaceRoot: {
          ...defaultRoots.workspaceRoot,
          resources: [
            ...(defaultRoots.workspaceRoot.resources ?? []),
            {
              sourcePath: "resources/gitignore",
              targetPath: "packages/lib/hijack.txt",
            },
          ],
        },
      };
      const rootIntrusionDir = path.join(workspaceDir, "root-intrusion");
      const rootIntrusionRun = testOverrideRuntime(
        ["init", rootIntrusionDir, "--preset", "ts-lib"],
        { workspaceRoots: intrusiveRoots },
      );
      assert.equal(await executeCliRuntime(rootIntrusionRun.runtime), 2);
      assert.equal(rootIntrusionRun.stdout(), "");
      assert.ok(
        (
          JSON.parse(rootIntrusionRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some(
          (issue) => issue.code === "DIRECTORY_OWNERSHIP_VIOLATION",
        ),
      );
      assert.equal(existsSync(rootIntrusionDir), false);

      // Singleton instances enforce identical transformFiles ownership checks without exemptions.
      const singletonInjectRoots: WorkspaceTemplateRoots = {
        ...defaultRoots,
        singletonPackages: defaultRoots.singletonPackages.map((singleton) => ({
          ...singleton,
          referencePackage: {
            ...singleton.referencePackage,
            transformFiles: (files) => {
              const next = new Map(files);
              next.set("injected.ts", {
                targetPath: "injected.ts",
                content: new TextEncoder().encode("export const x = 1;\n"),
                executable: false,
              });
              return next;
            },
          },
        })),
      };
      const singletonInjectDir = path.join(workspaceDir, "singleton-inject");
      const singletonInjectRun = testOverrideRuntime(
        ["init", singletonInjectDir, "--preset", "ts-lib"],
        { workspaceRoots: singletonInjectRoots },
      );
      assert.equal(await executeCliRuntime(singletonInjectRun.runtime), 2);
      assert.ok(
        (
          JSON.parse(singletonInjectRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some(
          (issue) => issue.code === "DIRECTORY_OWNERSHIP_VIOLATION",
        ),
      );
      assert.equal(existsSync(singletonInjectDir), false);

      // Singleton packages declared with custom names/paths participate in homogeneous conflict & link checks,
      // and dependencyBindings only apply when declared in the target package manifest.
      const customSingletonRoots: WorkspaceTemplateRoots = {
        ...defaultRoots,
        singletonPackages: defaultRoots.singletonPackages.map((singleton) => ({
          ...singleton,
          defaultName: "shared-base",
          defaultPath: "packages/shared-base",
        })),
      };
      const customSingletonConflictDir = path.join(
        workspaceDir,
        "custom-singleton-conflict",
      );
      const customSingletonConflictRun = testOverrideRuntime(
        ["init", customSingletonConflictDir, "--preset", "ts-lib:shared-base"],
        { workspaceRoots: customSingletonRoots },
      );
      assert.equal(
        await executeCliRuntime(customSingletonConflictRun.runtime),
        2,
      );
      assert.ok(
        (
          JSON.parse(customSingletonConflictRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some(
          (issue) => issue.code === "CONFLICTING_PACKAGE_IDENTITY",
        ),
      );

      const customSingletonLinkDir = path.join(
        workspaceDir,
        "custom-singleton-link",
      );
      const customSingletonLinkRun = testOverrideRuntime(
        [
          "init",
          customSingletonLinkDir,
          "--preset",
          "ts-lib",
          "--link",
          "packages/lib:packages/shared-base",
        ],
        { workspaceRoots: customSingletonRoots },
      );
      assert.equal(await executeCliRuntime(customSingletonLinkRun.runtime), 2);
      assert.ok(
        (
          JSON.parse(customSingletonLinkRun.stderr()) as {
            readonly data: {
              readonly issues: readonly { readonly code: string }[];
            };
          }
        ).data.issues.some((issue) => issue.code === "UNSUPPORTED_LINK"),
      );

      const rustPreset = loadBuiltInPresets().find(
        (preset) => preset.alias === "rust-bin",
      )!;
      const rustNode = rustPreset.nodes[0]!;
      const rustProbeDir = path.join(workspaceDir, "rust-probe-ref");
      cpSync(rustNode.referencePackage.packageDir, rustProbeDir, {
        recursive: true,
        filter: (src) => path.basename(src) !== "target",
      });
      writeFileSync(
        path.join(rustProbeDir, "README.md"),
        "Unrelated reference: @boringparts/reference-tooling-config\n",
      );
      const rustProbePreset: PresetDefinition = {
        ...rustPreset,
        nodes: [
          {
            ...rustNode,
            referencePackage: {
              ...rustNode.referencePackage,
              packageDir: rustProbeDir,
            },
          },
        ],
      };
      const rustNoBindDir = path.join(workspaceDir, "rust-no-unrelated-bind");
      const rustNoBindRun = testOverrideRuntime(
        ["init", rustNoBindDir, "--preset", "rust-bin"],
        { presets: [rustProbePreset] },
      );
      assert.equal(await executeCliRuntime(rustNoBindRun.runtime), 0);
      assert.equal(
        readFileSync(path.join(rustNoBindDir, "crates/app/README.md"), "utf8"),
        "Unrelated reference: @boringparts/reference-tooling-config\n",
      );
    });
  });
});
