import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";
import { loadBuiltInPresets } from "../../src/presets/index.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);
const rustBinRefDir = loadBuiltInPresets().find(
  (preset) => preset.alias === "rust-bin",
)!.nodes[0]!.definition.packageDir;

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

        // Subpackage Cargo.toml, Cargo.lock, rust-toolchain.toml, turbo.json, and wrapper package.json
        assert.equal(existsSync(path.join(targetDir, "Cargo.toml")), false);
        assert.equal(existsSync(path.join(targetDir, "Cargo.lock")), false);
        assert.equal(
          existsSync(path.join(targetDir, "rust-toolchain.toml")),
          false,
        );

        const crateDir = path.join(targetDir, spec.cratePath);
        const crateManifest = parseToml(
          readFileSync(path.join(crateDir, "Cargo.toml"), "utf8"),
        ) as unknown as { readonly package: { readonly name: string } };
        assert.equal(crateManifest.package.name, spec.crateName);

        const crateLockPath = path.join(crateDir, "Cargo.lock");
        assert.equal(existsSync(crateLockPath), true);
        const crateLockRaw = readFileSync(crateLockPath, "utf8");
        const crateLock = parseToml(crateLockRaw) as unknown as {
          readonly package: readonly {
            readonly name: string;
            readonly source?: string;
          }[];
        };
        assert.ok(
          crateLock.package.some(
            (pkg) => pkg.name === spec.crateName && pkg.source === undefined,
          ),
        );
        assert.ok(
          crateLock.package.some(
            (pkg) => pkg.name === "anyhow" && pkg.source !== undefined,
          ),
        );
        assert.equal(
          crateLock.package.some(
            (pkg) => pkg.name === "app" && spec.crateName !== "app",
          ),
          false,
        );

        assert.equal(
          readFileSync(path.join(crateDir, "rust-toolchain.toml"), "utf8"),
          readFileSync(path.join(rustBinRefDir, "rust-toolchain.toml"), "utf8"),
        );

        execFileSync("cargo", ["check", "--locked", "--offline"], {
          cwd: crateDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("cargo", ["test", "--locked", "--offline"], {
          cwd: crateDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        assert.equal(readFileSync(crateLockPath, "utf8"), crateLockRaw);

        const crateTurbo = JSON.parse(
          readFileSync(path.join(crateDir, "turbo.json"), "utf8"),
        ) as {
          readonly tasks: Record<
            string,
            {
              readonly outputs?: readonly string[];
              readonly passThroughEnv?: readonly string[];
            }
          >;
        };
        for (const taskName of [
          "build",
          "format:check",
          "format:write",
          "lint",
          "test",
        ]) {
          assert.deepStrictEqual(crateTurbo.tasks[taskName]?.passThroughEnv, [
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
          ]);
        }
        assert.deepStrictEqual(crateTurbo.tasks.build?.outputs, [
          "target/debug/**",
        ]);

        const wrapperPkg = JSON.parse(
          readFileSync(path.join(crateDir, "package.json"), "utf8"),
        ) as {
          readonly name: string;
          readonly exports?: Record<string, unknown>;
          readonly scripts: Record<string, string>;
        };
        assert.equal(wrapperPkg.name, `@${spec.dirName}/${spec.crateName}`);
        assert.equal(wrapperPkg.exports, undefined);
        assert.equal(wrapperPkg.scripts.build, "cargo build");
        assert.equal(wrapperPkg.scripts.test, "cargo test");

        // pnpm-workspace.yaml includes crates/*
        const workspaceYaml = parseYaml(
          readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
        ) as { readonly packages: readonly string[] };
        assert.ok(workspaceYaml.packages.includes("crates/*"));

        // Devcontainer Dockerfile appends rust.Dockerfile and devcontainer.json configures shared Cargo caches
        const dockerfile = readFileSync(
          path.join(targetDir, ".devcontainer/Dockerfile"),
          "utf8",
        );
        const rustLayer = readFileSync(
          path.join(rustBinRefDir, "resources/devcontainer/rust.Dockerfile"),
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
        assert.equal(
          devcontainerJson.mounts.some(
            (m) => m.target === "${containerWorkspaceFolder}/target",
          ),
          false,
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
        assert.deepStrictEqual(settings["rust-analyzer.linkedProjects"], [
          `${spec.cratePath}/Cargo.toml`,
        ]);
        assert.equal(settings["rust-analyzer.procMacro.enable"], true);

        // Dependabot monitors cargo and rust-toolchain under the crate directory, not at root
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
            (u) =>
              u["package-ecosystem"] === "cargo" &&
              u.directory === `/${spec.cratePath}`,
          ),
        );
        assert.ok(
          dependabot.updates.some(
            (u) =>
              u["package-ecosystem"] === "rust-toolchain" &&
              u.directory === `/${spec.cratePath}`,
          ),
        );
        assert.equal(
          dependabot.updates.some(
            (u) =>
              (u["package-ecosystem"] === "cargo" ||
                u["package-ecosystem"] === "rust-toolchain") &&
              u.directory === "/",
          ),
          false,
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
        ) as {
          readonly globalPassThroughEnv?: unknown;
          readonly tasks: Record<string, unknown>;
          readonly boundaries?: {
            readonly tags?: Record<string, unknown>;
          };
        };
        assert.equal(rootTurbo.globalPassThroughEnv, undefined);
        assert.deepStrictEqual(rootTurbo.boundaries?.tags, {
          app: { dependencies: { allow: ["app", "library"] } },
          library: { dependencies: { allow: ["library"] } },
          native: { dependencies: { allow: ["library"] } },
        });
        assert.equal("//#publication:pack" in rootTurbo.tasks, false);
        assert.equal("//#publication:publish" in rootTurbo.tasks, false);
      }
    });
  });

  void it("initializes standalone Cargo crates with merged linkedProjects and per-crate Dependabot across multiple rust-bin instances", async () => {
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

      assert.equal(existsSync(path.join(targetDir, "Cargo.toml")), false);
      assert.equal(existsSync(path.join(targetDir, "Cargo.lock")), false);
      assert.equal(
        existsSync(path.join(targetDir, "rust-toolchain.toml")),
        false,
      );

      for (const crate of [
        { name: "a", path: "crates/a" },
        { name: "b", path: "crates/b" },
      ]) {
        const crateDir = path.join(targetDir, crate.path);
        const crateCargo = parseToml(
          readFileSync(path.join(crateDir, "Cargo.toml"), "utf8"),
        ) as unknown as {
          readonly package: { readonly name: string };
        };
        assert.equal(crateCargo.package.name, crate.name);
        assert.equal(
          existsSync(path.join(crateDir, "rust-toolchain.toml")),
          true,
        );

        const crateLockPath = path.join(crateDir, "Cargo.lock");
        assert.equal(existsSync(crateLockPath), true);
        const crateLockRaw = readFileSync(crateLockPath, "utf8");
        const crateLock = parseToml(crateLockRaw) as unknown as {
          readonly package: readonly {
            readonly name: string;
            readonly source?: string;
          }[];
        };
        assert.ok(
          crateLock.package.some(
            (pkg) => pkg.name === crate.name && pkg.source === undefined,
          ),
        );
        assert.equal(
          crateLock.package.some((pkg) => pkg.name === "app"),
          false,
        );
        assert.equal(
          crateLock.package.filter((pkg) => pkg.name === "anyhow").length,
          1,
        );

        execFileSync("cargo", ["check", "--locked", "--offline"], {
          cwd: crateDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("cargo", ["test", "--locked", "--offline"], {
          cwd: crateDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        assert.equal(readFileSync(crateLockPath, "utf8"), crateLockRaw);
      }

      const settings = JSON.parse(
        readFileSync(path.join(targetDir, ".vscode/settings.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.deepStrictEqual(settings["rust-analyzer.linkedProjects"], [
        "crates/a/Cargo.toml",
        "crates/b/Cargo.toml",
      ]);

      const dependabot = parseYaml(
        readFileSync(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
      ) as {
        readonly updates: readonly {
          readonly "package-ecosystem": string;
          readonly directory: string;
        }[];
      };
      for (const dir of ["/crates/a", "/crates/b"]) {
        assert.ok(
          dependabot.updates.some(
            (u) => u["package-ecosystem"] === "cargo" && u.directory === dir,
          ),
        );
        assert.ok(
          dependabot.updates.some(
            (u) =>
              u["package-ecosystem"] === "rust-toolchain" &&
              u.directory === dir,
          ),
        );
      }
      assert.equal(
        dependabot.updates.some(
          (u) =>
            (u["package-ecosystem"] === "cargo" ||
              u["package-ecosystem"] === "rust-toolchain") &&
            u.directory === "/",
        ),
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
      assert.equal(existsSync(path.join(targetDir, "Cargo.toml")), false);
      assert.equal(existsSync(path.join(targetDir, "Cargo.lock")), false);
      assert.equal(
        existsSync(path.join(targetDir, "crates/worker/Cargo.toml")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, "crates/worker/Cargo.lock")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, "crates/worker/rust-toolchain.toml")),
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
      assert.ok(
        dependabot.updates.some(
          (u) => u["package-ecosystem"] === "npm" && u.directory === "/",
        ),
      );
      assert.ok(
        dependabot.updates.some(
          (u) =>
            u["package-ecosystem"] === "cargo" &&
            u.directory === "/crates/worker",
        ),
      );
      assert.ok(
        dependabot.updates.some(
          (u) =>
            u["package-ecosystem"] === "rust-toolchain" &&
            u.directory === "/crates/worker",
        ),
      );
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
