import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveTemplateWorkspaceRoots } from "@boringparts/template-presets";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);
const templateRoots = resolveTemplateWorkspaceRoots();

function testRuntime(args: readonly string[], cwd = process.cwd()) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    cwd,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "template-rust-bin-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

void describe("rust-bin preset and polyglot workspace", () => {
  void it("registers rust-bin in presets output", async () => {
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
    const rustBin = payload.data.presets.find((p) => p.name === "rust-bin");
    assert.ok(rustBin !== undefined);
    assert.equal(rustBin.topology, "configurable-primary-package");
    assert.deepStrictEqual(rustBin.roles, ["native-package"]);
  });

  void it("initializes default and named rust-bin repositories without npm-publication assets", async () => {
    await withTempDir(async (workspaceDir) => {
      for (const spec of [
        {
          dirName: "acme-rust",
          presetArg: "rust-bin",
          crateName: "app",
          cratePath: "crates/app",
        },
        {
          dirName: "acme-worker",
          presetArg: "rust-bin:worker",
          crateName: "worker",
          cratePath: "crates/worker",
        },
      ]) {
        const targetDir = path.join(workspaceDir, spec.dirName);
        const run = testRuntime([
          "init",
          targetDir,
          "--preset",
          spec.presetArg,
        ]);
        assert.equal(await runCli(run.runtime), 0, run.stderr());
        assert.equal(run.stderr(), "");

        const doc = JSON.parse(run.stdout()) as {
          readonly variant: string;
          readonly data: {
            readonly scope: string;
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
            name: `@${spec.dirName}/${spec.crateName}`,
            path: spec.cratePath,
            role: "native-package",
            preset: "rust-bin",
          },
        ]);

        // Subpackage Cargo.toml without subpackage Cargo.lock, and wrapper package.json
        const crateManifest = parseToml(
          readFileSync(
            path.join(targetDir, spec.cratePath, "Cargo.toml"),
            "utf8",
          ),
        ) as unknown as { readonly package: { readonly name: string } };
        assert.equal(crateManifest.package.name, spec.crateName);
        assert.equal(
          existsSync(path.join(targetDir, spec.cratePath, "Cargo.lock")),
          false,
        );

        const rootLockPath = path.join(targetDir, "Cargo.lock");
        assert.equal(existsSync(rootLockPath), true);
        const rootLockRaw = readFileSync(rootLockPath, "utf8");
        const rootLock = parseToml(rootLockRaw) as unknown as {
          readonly package: readonly {
            readonly name: string;
            readonly source?: string;
          }[];
        };
        assert.ok(
          rootLock.package.some(
            (pkg) => pkg.name === spec.crateName && pkg.source === undefined,
          ),
        );
        assert.ok(
          rootLock.package.some(
            (pkg) => pkg.name === "anyhow" && pkg.source !== undefined,
          ),
        );
        assert.equal(
          rootLock.package.some(
            (pkg) => pkg.name === "app" && spec.crateName !== "app",
          ),
          false,
        );

        execFileSync(
          "cargo",
          ["check", "--workspace", "--locked", "--offline"],
          {
            cwd: targetDir,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        execFileSync(
          "cargo",
          ["test", "--workspace", "--locked", "--offline"],
          {
            cwd: targetDir,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        assert.equal(readFileSync(rootLockPath, "utf8"), rootLockRaw);
        assert.equal(
          existsSync(path.join(targetDir, spec.cratePath, "Cargo.lock")),
          false,
        );

        const wrapperPkg = JSON.parse(
          readFileSync(
            path.join(targetDir, spec.cratePath, "package.json"),
            "utf8",
          ),
        ) as {
          readonly name: string;
          readonly exports?: Record<string, unknown>;
        };
        assert.equal(wrapperPkg.name, `@${spec.dirName}/${spec.crateName}`);
        assert.equal(wrapperPkg.exports, undefined);

        // Root Cargo workspace and verbatim rust-toolchain.toml
        const rootCargo = parseToml(
          readFileSync(path.join(targetDir, "Cargo.toml"), "utf8"),
        ) as unknown as {
          readonly workspace: {
            readonly resolver: string;
            readonly members: readonly string[];
          };
        };
        assert.equal(rootCargo.workspace.resolver, "3");
        assert.deepStrictEqual(rootCargo.workspace.members, [spec.cratePath]);

        assert.equal(
          readFileSync(path.join(targetDir, "rust-toolchain.toml"), "utf8"),
          readFileSync(templateRoots.rootRustToolchainPath, "utf8"),
        );

        // pnpm-workspace.yaml includes crates/*
        const workspaceYaml = parseYaml(
          readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
        ) as { readonly packages: readonly string[] };
        assert.ok(workspaceYaml.packages.includes("crates/*"));

        // Devcontainer Dockerfile appends rust.Dockerfile and devcontainer.json configures Rust
        const dockerfile = readFileSync(
          path.join(targetDir, ".devcontainer/Dockerfile"),
          "utf8",
        );
        assert.ok(templateRoots.rustLayerDockerfilePath !== undefined);
        const rustLayer = readFileSync(
          templateRoots.rustLayerDockerfilePath,
          "utf8",
        ).trimEnd();
        assert.ok(dockerfile.includes(rustLayer));

        const devcontainerJson = JSON.parse(
          readFileSync(
            path.join(targetDir, ".devcontainer/devcontainer.json"),
            "utf8",
          ),
        ) as {
          readonly build: { readonly args: Record<string, string> };
          readonly containerEnv?: Record<string, string>;
          readonly mounts: readonly {
            readonly source: string;
            readonly target: string;
          }[];
        };
        assert.equal(devcontainerJson.build.args.RUST_TOOLCHAIN, "1.100.0");
        assert.equal(devcontainerJson.containerEnv?.RUST_BACKTRACE, "1");
        assert.ok(
          devcontainerJson.mounts.some(
            (m) =>
              m.source === "${devcontainerId}-cargo-registry" &&
              m.target === "/usr/local/cargo/registry",
          ),
        );
        assert.ok(
          devcontainerJson.mounts.some(
            (m) =>
              m.source === "${devcontainerId}-cargo-git" &&
              m.target === "/usr/local/cargo/git",
          ),
        );
        assert.ok(
          devcontainerJson.mounts.some(
            (m) =>
              m.source === "${devcontainerId}-target" &&
              m.target === "${containerWorkspaceFolder}/target",
          ),
        );

        // VS Code rust-tooling extensions and settings
        const extensions = JSON.parse(
          readFileSync(path.join(targetDir, ".vscode/extensions.json"), "utf8"),
        ) as { readonly recommendations: readonly string[] };
        assert.ok(
          extensions.recommendations.includes("rust-lang.rust-analyzer"),
        );
        assert.ok(
          extensions.recommendations.includes("tamasfe.even-better-toml"),
        );

        const settings = JSON.parse(
          readFileSync(path.join(targetDir, ".vscode/settings.json"), "utf8"),
        ) as Record<string, unknown>;
        assert.equal(settings["rust-analyzer.check.command"], "clippy");
        assert.equal(settings["rust-analyzer.cargo.features"], "all");
        assert.equal(settings["rust-analyzer.procMacro.enable"], true);

        // Dependabot includes cargo and rust-toolchain
        const dependabot = parseYaml(
          readFileSync(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
        ) as {
          readonly updates: readonly {
            readonly "package-ecosystem": string;
            readonly directory: string;
          }[];
        };
        assert.ok(
          dependabot.updates.some(
            (u) => u["package-ecosystem"] === "cargo" && u.directory === "/",
          ),
        );
        assert.ok(
          dependabot.updates.some(
            (u) =>
              u["package-ecosystem"] === "rust-toolchain" &&
              u.directory === "/",
          ),
        );

        // No npm-publication assets when no JS/TS package is publishable
        assert.equal(existsSync(path.join(targetDir, ".changeset")), false);
        assert.equal(
          existsSync(path.join(targetDir, ".github/workflows/release.yml")),
          false,
        );
        const rootPkg = JSON.parse(
          readFileSync(path.join(targetDir, "package.json"), "utf8"),
        ) as {
          readonly scripts: Record<string, string>;
          readonly devDependencies: Record<string, string>;
        };
        assert.equal("publication:pack" in rootPkg.scripts, false);
        assert.equal("publication:publish" in rootPkg.scripts, false);
        assert.equal("@changesets/cli" in rootPkg.devDependencies, false);

        const rootTurbo = JSON.parse(
          readFileSync(path.join(targetDir, "turbo.json"), "utf8"),
        ) as { readonly tasks: Record<string, unknown> };
        assert.equal("//#publication:pack" in rootTurbo.tasks, false);
        assert.equal("//#publication:publish" in rootTurbo.tasks, false);
      }
    });
  });

  void it("synthesizes a single deduplicated root Cargo.lock across multiple rust-bin instances", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "multi-rust");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "rust-bin:a",
        "--preset",
        "rust-bin:b",
      ]);
      assert.equal(await runCli(run.runtime), 0, run.stderr());
      assert.equal(run.stderr(), "");

      const rootCargo = parseToml(
        readFileSync(path.join(targetDir, "Cargo.toml"), "utf8"),
      ) as unknown as {
        readonly workspace: { readonly members: readonly string[] };
      };
      assert.deepStrictEqual(rootCargo.workspace.members, [
        "crates/a",
        "crates/b",
      ]);

      assert.equal(
        existsSync(path.join(targetDir, "crates/a/Cargo.lock")),
        false,
      );
      assert.equal(
        existsSync(path.join(targetDir, "crates/b/Cargo.lock")),
        false,
      );

      const rootLockPath = path.join(targetDir, "Cargo.lock");
      assert.equal(existsSync(rootLockPath), true);
      const rootLockRaw = readFileSync(rootLockPath, "utf8");
      const rootLock = parseToml(rootLockRaw) as unknown as {
        readonly package: readonly {
          readonly name: string;
          readonly source?: string;
        }[];
      };
      assert.ok(
        rootLock.package.some(
          (pkg) => pkg.name === "a" && pkg.source === undefined,
        ),
      );
      assert.ok(
        rootLock.package.some(
          (pkg) => pkg.name === "b" && pkg.source === undefined,
        ),
      );
      assert.equal(
        rootLock.package.filter((pkg) => pkg.name === "anyhow").length,
        1,
      );

      execFileSync("cargo", ["check", "--workspace", "--locked", "--offline"], {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      execFileSync("cargo", ["test", "--workspace", "--locked", "--offline"], {
        cwd: targetDir,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(readFileSync(rootLockPath, "utf8"), rootLockRaw);
      assert.equal(
        existsSync(path.join(targetDir, "crates/a/Cargo.lock")),
        false,
      );
      assert.equal(
        existsSync(path.join(targetDir, "crates/b/Cargo.lock")),
        false,
      );
    });
  });

  void it("merges polyglot rust-bin + ts-lib configuration and enables npm-publication", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "polyglot-repo");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "rust-bin:worker",
        "--preset",
        "ts-lib:shared",
      ]);
      assert.equal(await runCli(run.runtime), 0, run.stderr());
      assert.equal(run.stderr(), "");

      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly packages: readonly string[];
        readonly catalog: Record<string, string>;
      };
      assert.deepStrictEqual(workspaceYaml.packages, [
        "crates/*",
        "packages/*",
      ]);
      assert.ok("zod" in workspaceYaml.catalog);
      assert.ok("@changesets/cli" in workspaceYaml.catalog);

      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, "crates/worker/Cargo.toml")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, "packages/shared/package.json")),
        true,
      );

      const dependabot = parseYaml(
        readFileSync(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
      ) as {
        readonly updates: readonly {
          readonly "package-ecosystem": string;
          readonly directory: string;
        }[];
      };
      const ecosystems = dependabot.updates.map((u) => u["package-ecosystem"]);
      assert.ok(ecosystems.includes("npm"));
      assert.ok(ecosystems.includes("cargo"));
      assert.ok(ecosystems.includes("rust-toolchain"));
    });
  });

  void it("rejects native-package links as consumer or provider with UNSUPPORTED_LINK and zero disk writes", async () => {
    await withTempDir(async (workspaceDir) => {
      const cases = [
        {
          label: "native-package as consumer",
          targetDir: path.join(workspaceDir, "reject-consumer"),
          link: "crates/worker:packages/lib",
        },
        {
          label: "native-package as provider",
          targetDir: path.join(workspaceDir, "reject-provider"),
          link: "packages/lib:crates/worker",
        },
      ] as const;

      for (const testCase of cases) {
        const run = testRuntime([
          "init",
          testCase.targetDir,
          "--preset",
          "rust-bin:worker",
          "--preset",
          "ts-lib",
          "--link",
          testCase.link,
        ]);
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
        assert.equal(failure.data.issues.length, 1, testCase.label);
        assert.equal(
          failure.data.issues[0]?.code,
          "UNSUPPORTED_LINK",
          testCase.label,
        );
        assert.ok(
          failure.data.issues[0]?.message.includes("native-package"),
          testCase.label,
        );
        assert.equal(existsSync(testCase.targetDir), false, testCase.label);
      }
    });
  });
});
