import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
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

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "template-vike-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

void describe("vike-app preset", () => {
  void it("registers vike-app with fixed topology and four package roles", async () => {
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
    const vike = payload.data.presets.find((p) => p.name === "vike-app");
    assert.ok(
      vike !== undefined,
      "vike-app must be listed by template presets",
    );
    assert.equal(vike.topology, "fixed");
    assert.deepStrictEqual(vike.roles, [
      "runtime-service",
      "node-library",
      "node-library",
      "native-package",
    ]);
  });

  void it("initializes a fullstack vike-app monorepo with root deployment assets and rewritten references", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-vike");
      const run = testRuntime(["init", targetDir, "--preset", "vike-app"]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const doc = JSON.parse(run.stdout()) as {
        readonly kind: string;
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
      assert.equal(doc.kind, "data");
      assert.equal(doc.variant, "initialized");
      assert.equal(doc.data.scope, "acme-vike");
      assert.deepStrictEqual(doc.data.packages, [
        {
          name: "@acme-vike/web",
          path: "apps/web",
          role: "runtime-service",
          preset: "vike-app",
        },
        {
          name: "@acme-vike/db",
          path: "packages/db",
          role: "node-library",
          preset: "vike-app",
        },
        {
          name: "@acme-vike/migrations",
          path: "packages/migrations",
          role: "node-library",
          preset: "vike-app",
        },
        {
          name: "@acme-vike/deployment",
          path: "packages/deployment",
          role: "native-package",
          preset: "vike-app",
        },
      ]);

      // Private-only app omits npm-publication and generator residue
      assert.equal(existsSync(path.join(targetDir, ".template")), false);
      assert.equal(existsSync(path.join(targetDir, "TODO.md")), false);
      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        false,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        false,
      );

      // Root projected static deployment assets
      for (const expected of [
        "Dockerfile",
        ".dockerignore",
        "scripts/container-entrypoint.sh",
        "apps/web/package.json",
        "packages/db/package.json",
        "packages/migrations/package.json",
        "packages/deployment/package.json",
        "packages/deployment/scripts/check-standalone-deployment.ts",
      ]) {
        assert.equal(
          existsSync(path.join(targetDir, expected)),
          true,
          `Missing expected file: ${expected}`,
        );
      }

      const entrypointStats = statSync(
        path.join(targetDir, "scripts/container-entrypoint.sh"),
      );
      assert.notEqual(
        entrypointStats.mode & 0o111,
        0,
        "scripts/container-entrypoint.sh must be executable",
      );

      const dockerfile = readFileSync(
        path.join(targetDir, "Dockerfile"),
        "utf8",
      );
      assert.ok(dockerfile.includes("FROM node:26.13.1-bookworm-slim AS base"));
      assert.ok(
        dockerfile.includes(
          "COPY --from=ghcr.io/pnpm/pnpm:12.21.0 /opt/pnpm /opt/pnpm",
        ),
      );
      assert.equal(dockerfile.includes("ARG NODE_VERSION"), false);
      assert.equal(dockerfile.includes("__PNPM_VERSION__"), false);
      assert.equal(dockerfile.includes("@template-mirror"), false);
      assert.ok(
        dockerfile.includes(
          'pnpm exec turbo run build --filter="$APPLICATION_PACKAGE_NAME" --filter="$MIGRATION_PACKAGE_NAME"',
        ),
      );
      assert.equal(
        dockerfile.includes('pnpm --filter "$DATABASE_PACKAGE_NAME" run build'),
        false,
      );

      // Root package.json delegates dev to @acme-vike/web without injected db:prepare scripts or publication scripts
      const rootPkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      ) as {
        readonly scripts: Record<string, string>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(
        rootPkg.scripts.dev,
        "turbo run dev --filter=@acme-vike/web",
      );
      assert.equal("publication:pack" in rootPkg.scripts, false);
      assert.equal("database:prepare:dev" in rootPkg.scripts, false);
      assert.equal("@changesets/cli" in rootPkg.devDependencies, false);

      // Rewritten package.json & turbo.json across all four subpackages
      const webPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly dependencies: Record<string, string>;
        readonly exports?: Record<string, unknown>;
      };
      assert.equal(webPkg.name, "@acme-vike/web");
      assert.equal(webPkg.dependencies["@acme-vike/db"], "workspace:*");
      assert.equal(webPkg.exports, undefined);

      const dbPkg = JSON.parse(
        readFileSync(path.join(targetDir, "packages/db/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly exports: Record<string, unknown>;
      };
      assert.equal(dbPkg.name, "@acme-vike/db");
      assert.equal(
        Object.hasOwn(dbPkg.exports, "./package.json"),
        true,
        "db package must keep ./package.json export for drizzle/vite config imports",
      );

      const migrationsPkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/migrations/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly dependencies: Record<string, string>;
      };
      assert.equal(migrationsPkg.name, "@acme-vike/migrations");
      assert.equal(migrationsPkg.dependencies["@acme-vike/db"], "workspace:*");

      const deploymentPkg = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/deployment/package.json"),
          "utf8",
        ),
      ) as {
        readonly name: string;
        readonly dependencies: Record<string, string>;
        readonly scripts: Record<string, string>;
      };
      assert.equal(deploymentPkg.name, "@acme-vike/deployment");
      assert.equal(deploymentPkg.dependencies["@acme-vike/db"], "workspace:*");
      assert.equal(
        deploymentPkg.dependencies["@acme-vike/migrations"],
        "workspace:*",
      );
      assert.equal(deploymentPkg.dependencies["@acme-vike/web"], "workspace:*");
      assert.ok(
        deploymentPkg.scripts["database:prepare:test"]?.includes(
          "@acme-vike/db",
        ),
      );
      assert.ok(
        deploymentPkg.scripts["database:prepare:test"]?.includes(
          "@acme-vike/migrations",
        ),
      );
      assert.ok(
        deploymentPkg.scripts.lint?.includes(
          "shellcheck ../../scripts/container-entrypoint.sh",
        ),
      );

      const webTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<string, { readonly dependsOn?: string[] }>;
      };
      assert.ok(webTurbo.tasks.dev?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks.build?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks.test?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks["test:browser"]?.dependsOn?.includes("^build"));
      assert.ok(
        webTurbo.tasks["test:e2e"]?.dependsOn?.includes(
          "@acme-vike/deployment#database:prepare:e2e",
        ),
      );

      const webViteConfig = readFileSync(
        path.join(targetDir, "apps/web/vite.config.ts"),
        "utf8",
      );
      assert.equal(webViteConfig.includes("conditions"), false);

      const dbTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "packages/db/turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<string, { readonly dependsOn?: string[] }>;
      };
      assert.ok(dbTurbo.tasks.build?.dependsOn?.includes("^build"));
      assert.ok(
        dbTurbo.tasks.test?.dependsOn?.includes(
          "@acme-vike/deployment#database:prepare:test",
        ),
      );

      const deploymentTurbo = JSON.parse(
        readFileSync(
          path.join(targetDir, "packages/deployment/turbo.json"),
          "utf8",
        ),
      ) as {
        readonly tasks: Record<
          string,
          { readonly dependsOn?: string[]; readonly tags?: string[] }
        >;
      };
      assert.deepStrictEqual(deploymentTurbo.tasks["check:deployment"]?.tags, [
        "quality:heavy",
      ]);
      assert.ok(
        deploymentTurbo.tasks["check:deployment"]?.dependsOn?.includes(
          "@acme-vike/web#build",
        ),
      );

      // Source imports and deployment script paths rewritten cleanly
      for (const relPath of [
        "packages/db/src/readiness.ts",
        "packages/migrations/drizzle.config.ts",
        "apps/web/vite.config.ts",
        "apps/web/server/database.ts",
        "apps/web/pages/index/+Page.telefunc.ts",
        "apps/web/types/global.d.ts",
        "packages/deployment/scripts/check-standalone-deployment.ts",
      ]) {
        const text = readFileSync(path.join(targetDir, relPath), "utf8");
        assert.equal(
          text.includes("@boringparts/reference-vike-"),
          false,
          `${relPath} still contains @boringparts/reference-vike-*`,
        );
      }

      const checkerSource = readFileSync(
        path.join(
          targetDir,
          "packages/deployment/scripts/check-standalone-deployment.ts",
        ),
        "utf8",
      );
      assert.ok(checkerSource.includes('"@acme-vike/web"'));
      assert.ok(checkerSource.includes('"@acme-vike/db"'));
      assert.ok(checkerSource.includes('"@acme-vike/migrations"'));
      assert.ok(checkerSource.includes('"apps/web"'));
      assert.ok(checkerSource.includes('"Dockerfile"'));
      assert.ok(checkerSource.includes('"scripts/container-entrypoint.sh"'));
      assert.ok(checkerSource.includes('"/migration"'));
      assert.equal(checkerSource.includes("references/vike-"), false);

      // Devcontainer appends browser-test & shellcheck layers
      const devcontainerDockerfile = readFileSync(
        path.join(targetDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.ok(devcontainerDockerfile.includes("PLAYWRIGHT_CLI_PACKAGE"));
      assert.ok(devcontainerDockerfile.includes("shellcheck"));
      const devcontainerJson = JSON.parse(
        readFileSync(
          path.join(targetDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { readonly build: { readonly args?: Record<string, string> } };
      assert.ok(
        devcontainerJson.build.args?.PLAYWRIGHT_CLI_PACKAGE?.startsWith(
          "@playwright/test@",
        ),
      );

      // Dependabot includes root docker ecosystem and npm drizzle group
      const dependabot = parseYaml(
        readFileSync(path.join(targetDir, ".github/dependabot.yml"), "utf8"),
      ) as {
        readonly updates: readonly {
          readonly "package-ecosystem": string;
          readonly directory: string;
          readonly groups?: {
            readonly drizzle?: { readonly patterns: readonly string[] };
          };
        }[];
      };
      assert.ok(
        dependabot.updates.some(
          (u) => u["package-ecosystem"] === "docker" && u.directory === "/",
        ),
      );
      const npmUpdate = dependabot.updates.find(
        (u) => u["package-ecosystem"] === "npm",
      );
      assert.deepStrictEqual(npmUpdate?.groups?.drizzle, {
        patterns: ["drizzle-*", "drizzle-orm"],
      });

      // pnpm-workspace.yaml includes apps/*, packages/*, allowBuilds, overrides, and pruned catalog
      const workspaceYaml = parseYaml(
        readFileSync(path.join(targetDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly packages: string[];
        readonly allowBuilds?: Record<string, boolean>;
        readonly overrides?: Record<string, string>;
        readonly catalog: Record<string, string>;
      };
      assert.deepStrictEqual(workspaceYaml.packages, ["apps/*", "packages/*"]);
      assert.deepStrictEqual(workspaceYaml.allowBuilds, { esbuild: true });
      assert.deepStrictEqual(workspaceYaml.overrides, {
        "pinia>typescript": "-",
        "vue>typescript": "-",
      });
      assert.ok("vike" in workspaceYaml.catalog);
      assert.ok("drizzle-orm" in workspaceYaml.catalog);
      assert.ok("drizzle-kit" in workspaceYaml.catalog);
      assert.ok("typescript" in workspaceYaml.catalog);
    });
  });

  void it("combines vike-app with ts-lib and links apps/web and packages/db to packages/lib", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "combo-vike");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "vike-app",
        "--preset",
        "ts-lib",
        "--link",
        "apps/web:packages/lib",
        "--link",
        "packages/db:packages/lib",
      ]);
      assert.equal(await runCli(run.runtime), 0);
      assert.equal(run.stderr(), "");

      const webPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      const dbPkg = JSON.parse(
        readFileSync(path.join(targetDir, "packages/db/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(webPkg.dependencies["@combo-vike/lib"], "workspace:*");
      assert.equal(dbPkg.dependencies["@combo-vike/lib"], "workspace:*");
      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        true,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        true,
      );
    });
  });

  void it("fails fast with exit code 2 and zero disk writes on fixed topology override or conflict", async () => {
    await withTempDir(async (workspaceDir) => {
      const overrideDir = path.join(workspaceDir, "override-repo");
      const overrideRun = testRuntime([
        "init",
        overrideDir,
        "--preset",
        "vike-app:custom",
      ]);
      assert.equal(await runCli(overrideRun.runtime), 2);
      assert.equal(overrideRun.stdout(), "");
      const overrideFailure = JSON.parse(overrideRun.stderr()) as {
        readonly data: {
          readonly issues: readonly { readonly code: string }[];
        };
      };
      assert.ok(
        overrideFailure.data.issues.some(
          (i) => i.code === "FIXED_TOPOLOGY_OVERRIDE",
        ),
      );
      assert.equal(existsSync(overrideDir), false);

      for (const conflictArgs of [
        ["--preset", "vike-app", "--preset", "vike-app"],
        ["--preset", "vike-app", "--preset", "vue-hono-app"],
      ]) {
        const conflictDir = path.join(workspaceDir, "conflict-repo");
        const conflictRun = testRuntime(["init", conflictDir, ...conflictArgs]);
        assert.equal(await runCli(conflictRun.runtime), 2);
        assert.equal(conflictRun.stdout(), "");
        const conflictFailure = JSON.parse(conflictRun.stderr()) as {
          readonly data: {
            readonly issues: readonly {
              readonly code: string;
              readonly message: string;
            }[];
          };
        };
        assert.ok(
          conflictFailure.data.issues.some(
            (i) =>
              i.code === "CONFLICTING_PACKAGE_IDENTITY" &&
              i.message.includes("apps/web"),
          ),
        );
        assert.equal(existsSync(conflictDir), false);
      }
    });
  });
});
