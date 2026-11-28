import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml } from "yaml";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(args: readonly string[], cwd?: string) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    cwd: cwd ?? process.cwd(),
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "template-node-lib-ts-cli-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

void describe("node-lib and ts-cli presets", () => {
  void it("registers node-lib and ts-cli in built-in presets", async () => {
    const run = testRuntime(["presets"]);
    assert.equal(await runCli(run.runtime), 0);
    assert.equal(run.stderr(), "");

    const payload = JSON.parse(run.stdout()) as {
      readonly data: {
        readonly presets: readonly {
          readonly name: string;
          readonly topology: string;
          readonly roles: readonly string[];
        }[];
      };
    };

    const nodeLib = payload.data.presets.find((p) => p.name === "node-lib");
    assert.ok(nodeLib !== undefined);
    assert.equal(nodeLib.topology, "configurable-primary-package");
    assert.deepStrictEqual(nodeLib.roles, ["node-library"]);

    const tsCli = payload.data.presets.find((p) => p.name === "ts-cli");
    assert.ok(tsCli !== undefined);
    assert.equal(tsCli.topology, "configurable-primary-package");
    assert.deepStrictEqual(tsCli.roles, ["cli-tool"]);
  });

  void it("initializes node-lib with Node >=24 contract, devEngines, on-demand catalogs.node-24, and no minimumReleaseAgeExclude", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-node-sdk");
      const run = testRuntime(["init", targetDir, "--preset", "node-lib"]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const doc = JSON.parse(run.stdout()) as {
        readonly variant: string;
        readonly data: {
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
            readonly role: string;
            readonly preset: string;
          }[];
        };
      };
      assert.equal(doc.variant, "initialized");
      assert.deepStrictEqual(doc.data.packages, [
        {
          name: "@acme-node-sdk/node-lib",
          path: "packages/node-lib",
          role: "node-library",
          preset: "node-lib",
        },
      ]);

      const pkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/node-lib/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly exports: Record<string, unknown>;
        readonly engines: { readonly node: string };
        readonly devEngines: {
          readonly runtime: { readonly name: string; readonly version: string };
        };
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(pkg.name, "@acme-node-sdk/node-lib");
      assert.equal(Object.hasOwn(pkg.exports, "./package.json"), false);
      assert.equal(Object.hasOwn(pkg.exports, "./reference"), false);
      assert.deepStrictEqual(pkg.engines, { node: ">=24.0.0" });
      assert.equal(pkg.devEngines.runtime.name, "node");
      assert.equal(pkg.devEngines.runtime.version, "24.0.0");
      assert.equal(pkg.devDependencies["@types/node"], "catalog:node-24");

      const testFile = readFileSync(
        path.join(targetDir, "packages/node-lib/test/artifact-key.test.ts"),
        "utf8",
      );
      assert.ok(testFile.includes('from "@acme-node-sdk/node-lib"'));
      assert.equal(testFile.includes("@boringparts/reference-node-lib"), false);

      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        true,
      );

      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly catalogs?: Readonly<Record<string, Record<string, string>>>;
        readonly minimumReleaseAgeExclude?: unknown;
      };
      assert.deepStrictEqual(workspaceYaml.catalogs, {
        "node-24": { "@types/node": "~24.0.0" },
      });
      assert.equal(workspaceYaml.minimumReleaseAgeExclude, undefined);
    });
  });

  void it("initializes ts-cli with custom bin name, >=24.0.0 engines, devEngines, test:dist, catalog:node-24, minimumReleaseAgeExclude, and npm-publication", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-cli-repo");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "ts-cli:my-tool",
      ]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const doc = JSON.parse(run.stdout()) as {
        readonly data: {
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
            readonly role: string;
            readonly preset: string;
          }[];
        };
      };
      assert.deepStrictEqual(doc.data.packages, [
        {
          name: "@acme-cli-repo/my-tool",
          path: "packages/my-tool",
          role: "cli-tool",
          preset: "ts-cli",
        },
      ]);

      const pkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/my-tool/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly version?: string;
        readonly bin: Record<string, string>;
        readonly exports?: unknown;
        readonly scripts: Record<string, string>;
        readonly engines: { readonly node: string };
        readonly devEngines: {
          readonly runtime: { readonly name: string; readonly version: string };
        };
        readonly dependencies: Record<string, string>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(pkg.name, "@acme-cli-repo/my-tool");
      assert.equal(pkg.version, "0.0.0");
      assert.deepStrictEqual(pkg.bin, { "my-tool": "./dist/cli.js" });
      assert.equal(pkg.exports, undefined);
      assert.deepStrictEqual(pkg.engines, { node: ">=24.0.0" });
      assert.equal(pkg.devEngines.runtime.name, "node");
      assert.equal(pkg.devEngines.runtime.version, "24.0.0");
      assert.equal(pkg.devDependencies["@types/node"], "catalog:node-24");
      assert.equal(pkg.dependencies["@boringparts/cli-contract"], "catalog:");
      assert.equal("test:dist" in pkg.scripts, true);
      assert.equal("test:e2e" in pkg.scripts, false);

      const cliTurbo = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/my-tool/turbo.json"),
          "utf8",
        ),
      ) as { readonly tasks: Record<string, unknown> };
      assert.equal("test:dist" in cliTurbo.tasks, true);
      assert.equal("test:e2e" in cliTurbo.tasks, false);

      for (const relPath of [
        "packages/my-tool/src/cli.ts",
        "packages/my-tool/src/main.ts",
        "packages/my-tool/test/integration/command.test.ts",
        "packages/my-tool/test/e2e/journeys/lookup.journey.ts",
      ]) {
        const content = readFileSync(path.join(targetDir, relPath), "utf8");
        assert.equal(
          content.includes("reference-cli"),
          false,
          `${relPath} must not hardcode reference-cli`,
        );
        assert.equal(
          content.includes("reference-ts-cli"),
          false,
          `${relPath} must not hardcode reference-ts-cli`,
        );
      }

      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        true,
      );

      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly catalog: Record<string, string>;
        readonly catalogs?: unknown;
        readonly minimumReleaseAgeExclude?: readonly string[];
      };
      assert.ok("@boringparts/cli-contract" in workspaceYaml.catalog);
      assert.deepStrictEqual(workspaceYaml.catalogs, {
        "node-24": { "@types/node": "~24.0.0" },
      });
      assert.deepStrictEqual(workspaceYaml.minimumReleaseAgeExclude, [
        "@boringparts/cli-contract",
      ]);
    });
  });

  void it("supports ts-cli + node-lib + ts-lib multi-package composition and all valid role links", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-suite");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "ts-cli",
        "--preset",
        "node-lib",
        "--preset",
        "node-lib:node-worker",
        "--preset",
        "ts-lib",
        "--link",
        "packages/cli:packages/node-lib",
        "--link",
        "packages/cli:packages/lib",
        "--link",
        "packages/node-lib:packages/lib",
        "--link",
        "packages/node-worker:packages/node-lib",
      ]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const cliPkg = JSON.parse(
        readFileSync(path.join(targetDir, "packages/cli/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(cliPkg.dependencies["@acme-suite/node-lib"], "workspace:*");
      assert.equal(cliPkg.dependencies["@acme-suite/lib"], "workspace:*");

      const nodeLibPkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/node-lib/package.json"),
          "utf8",
        ),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(nodeLibPkg.dependencies["@acme-suite/lib"], "workspace:*");

      const nodeWorkerPkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/node-worker/package.json"),
          "utf8",
        ),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(
        nodeWorkerPkg.dependencies["@acme-suite/node-lib"],
        "workspace:*",
      );

      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly catalogs?: Readonly<Record<string, Record<string, string>>>;
        readonly minimumReleaseAgeExclude?: readonly string[];
      };
      assert.deepStrictEqual(workspaceYaml.catalogs, {
        "node-24": { "@types/node": "~24.0.0" },
      });
      assert.deepStrictEqual(workspaceYaml.minimumReleaseAgeExclude, [
        "@boringparts/cli-contract",
      ]);
    });
  });

  void it("rejects illegal cross-role links in memory with exit code 2 and zero disk writes", async () => {
    const invalidCases = [
      {
        label: "shared-library cannot link node-library",
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
        label: "shared-library cannot link cli-tool",
        args: [
          "--preset",
          "ts-lib",
          "--preset",
          "ts-cli",
          "--link",
          "packages/lib:packages/cli",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "node-library cannot link cli-tool",
        args: [
          "--preset",
          "node-lib",
          "--preset",
          "ts-cli",
          "--link",
          "packages/node-lib:packages/cli",
        ],
        expectedCode: "UNSUPPORTED_LINK",
      },
      {
        label: "cli-tool cannot link cli-tool",
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
    ] as const;

    await withTempDir(async (workspaceDir) => {
      for (const [index, testCase] of invalidCases.entries()) {
        const targetDir = path.join(workspaceDir, `rejected-${index}`);
        const run = testRuntime(["init", targetDir, ...testCase.args]);
        assert.equal(await runCli(run.runtime), 2, testCase.label);
        assert.equal(run.stdout(), "", testCase.label);
        const failure = JSON.parse(run.stderr()) as {
          readonly kind: string;
          readonly variant: string;
          readonly data: {
            readonly issues: readonly {
              readonly code: string;
              readonly message: string;
            }[];
          };
        };
        assert.equal(failure.kind, "failure", testCase.label);
        assert.equal(failure.variant, "invalidRequest", testCase.label);
        assert.equal(
          failure.data.issues.some((issue) => issue.code === "PRESET_UNKNOWN"),
          false,
          testCase.label,
        );
        assert.ok(
          failure.data.issues.some(
            (issue) =>
              issue.code === testCase.expectedCode &&
              issue.message.includes("cannot link to"),
          ),
          testCase.label,
        );
        assert.equal(existsSync(targetDir), false, testCase.label);
      }
    });
  });
});
