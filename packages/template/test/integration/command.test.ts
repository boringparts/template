import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  type PackageRole,
  type PresetDefinition,
} from "@boringparts/template-engine";
import { loadBuiltInPresets } from "@boringparts/template-presets";
import { parse as parseYaml } from "yaml";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly presets?: readonly PresetDefinition[];
  } = {},
) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    cwd: options.cwd ?? process.cwd(),
    ...(options.presets === undefined ? {} : { presets: options.presets }),
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
  defaultCollection: "packages" | "apps" | "crates" = "packages",
): PresetDefinition {
  const tsLib = loadBuiltInPresets().find(
    (preset) => preset.alias === "ts-lib",
  )!;
  const baseRef = tsLib.nodes[0]!.reference;
  return {
    alias,
    title: `Role ${role}`,
    description: `Synthetic test preset for role ${role}`,
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "main",
        defaultName,
        defaultCollection,
        defaultPath: `${defaultCollection}/${defaultName}`,
        reference: {
          ...baseRef,
          role,
        },
      },
    ],
    capabilities: {
      devcontainerLayers: ["github-cli"],
      editorCapabilities: ["oxc-format-lint"],
    },
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

      // Shared tooling-config manifest rewritten without ./package.json leak
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
        label: "invalid package leaf name",
        dirName: "valid-repo",
        args: ["--preset", "ts-lib:BadName"],
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
          ".template",
          "node_modules",
          "dist",
          "target",
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
        const run = testRuntime(["init", targetDir, ...testCase.args], {
          presets: testPresets,
        });
        assert.equal(await runCli(run.runtime), 2, testCase.label);
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
      const allowedRun = testRuntime(
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
      assert.equal(await runCli(allowedRun.runtime), 0);
      assert.equal(allowedRun.stderr(), "");
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
});
