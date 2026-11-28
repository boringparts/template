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
  const dir = mkdtempSync(path.join(tmpdir(), "template-vue-presets-test-"));
  return fn(dir).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

void describe("vue-app and vue-hono-app presets via runCli", () => {
  void it("initializes vue-app with default and custom name/path, browser-test devcontainer layer, editor capabilities, and no npm-publication", async () => {
    const presetsRun = testRuntime(["presets"]);
    assert.equal(await runCli(presetsRun.runtime), 0);
    const presetCatalog = JSON.parse(presetsRun.stdout()) as {
      readonly data: {
        readonly presets: readonly {
          readonly name: string;
          readonly topology: string;
          readonly roles: readonly string[];
        }[];
      };
    };
    const vueAppMeta = presetCatalog.data.presets.find(
      (preset) => preset.name === "vue-app",
    );
    assert.deepStrictEqual(
      vueAppMeta?.topology,
      "configurable-primary-package",
    );
    assert.deepStrictEqual(vueAppMeta?.roles, ["browser-app"]);

    await withTempDir(async (workspaceDir) => {
      // 1. Default initialization -> apps/web
      const defaultDir = path.join(workspaceDir, "acme-web");
      const defaultRun = testRuntime([
        "init",
        defaultDir,
        "--preset",
        "vue-app",
      ]);
      assert.equal(await runCli(defaultRun.runtime), 0);
      assert.equal(defaultRun.stderr(), "");

      const defaultDoc = JSON.parse(defaultRun.stdout()) as {
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
      assert.equal(defaultDoc.variant, "initialized");
      assert.equal(defaultDoc.data.scope, "acme-web");
      assert.deepStrictEqual(defaultDoc.data.packages, [
        {
          name: "@acme-web/web",
          path: "apps/web",
          role: "browser-app",
          preset: "vue-app",
        },
      ]);

      // Pure private app does not emit npm-publication assets
      assert.equal(
        existsSync(path.join(defaultDir, ".changeset/config.json")),
        false,
      );
      assert.equal(
        existsSync(path.join(defaultDir, ".github/workflows/release.yml")),
        false,
      );

      // Root dev delegation + no publication scripts
      const rootPkg = JSON.parse(
        readFileSync(path.join(defaultDir, "package.json"), "utf8"),
      ) as {
        readonly scripts: Record<string, string>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(rootPkg.scripts.dev, "turbo run dev");
      assert.equal("publication:pack" in rootPkg.scripts, false);
      assert.equal("publication:publish" in rootPkg.scripts, false);
      assert.equal("@changesets/cli" in rootPkg.devDependencies, false);

      const rootTurbo = JSON.parse(
        readFileSync(path.join(defaultDir, "turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<
          string,
          { readonly tags?: readonly string[]; readonly persistent?: boolean }
        >;
      };
      assert.deepStrictEqual(rootTurbo.tasks["//#dev"]?.tags, [
        "work:development",
      ]);
      assert.equal(rootTurbo.tasks["//#dev"]?.persistent, true);

      // Devcontainer browser-test layer + PLAYWRIGHT_CLI_PACKAGE build arg
      const dockerfile = readFileSync(
        path.join(defaultDir, ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.ok(dockerfile.includes("ARG PLAYWRIGHT_CLI_PACKAGE"));
      assert.ok(dockerfile.includes("playwright install --with-deps chromium"));

      const devcontainer = JSON.parse(
        readFileSync(
          path.join(defaultDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as {
        readonly build: { readonly args?: Record<string, string> };
        readonly customizations: {
          readonly vscode: { readonly extensions: readonly string[] };
        };
      };
      assert.match(
        devcontainer.build.args?.PLAYWRIGHT_CLI_PACKAGE ?? "",
        /^@playwright\/test@\d+\.\d+\.\d+$/u,
      );

      // Frontend editor extensions
      const vscodeExtensions = JSON.parse(
        readFileSync(path.join(defaultDir, ".vscode/extensions.json"), "utf8"),
      ) as { readonly recommendations: readonly string[] };
      for (const expectedExtension of [
        "oxc.oxc-vscode",
        "Vue.volar",
        "bradlc.vscode-tailwindcss",
        "vitest.explorer",
      ]) {
        assert.ok(
          vscodeExtensions.recommendations.includes(expectedExtension),
          `Missing VS Code extension ${expectedExtension}`,
        );
      }

      // pnpm-workspace.yaml allowBuilds, overrides, and pruned catalog
      const workspaceYaml = parseYaml(
        readFileSync(path.join(defaultDir, "pnpm-workspace.yaml"), "utf8"),
      ) as {
        readonly packages: readonly string[];
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
      assert.ok("vue" in workspaceYaml.catalog);
      assert.ok("pinia" in workspaceYaml.catalog);
      assert.ok("@playwright/test" in workspaceYaml.catalog);
      assert.equal("hono" in workspaceYaml.catalog, false);

      // 2. Custom leaf name -> apps/portal
      const customNameDir = path.join(workspaceDir, "portal-only");
      const customNameRun = testRuntime([
        "init",
        customNameDir,
        "--preset",
        "vue-app:portal",
      ]);
      assert.equal(await runCli(customNameRun.runtime), 0);
      const customNameDoc = JSON.parse(customNameRun.stdout()) as {
        readonly data: {
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
          }[];
        };
      };
      assert.deepStrictEqual(customNameDoc.data.packages, [
        {
          name: "@portal-only/portal",
          path: "apps/portal",
          role: "browser-app",
          preset: "vue-app",
        },
      ]);
      const customNameRootPkg = JSON.parse(
        readFileSync(path.join(customNameDir, "package.json"), "utf8"),
      ) as { readonly scripts: Record<string, string> };
      assert.equal(customNameRootPkg.scripts.dev, "turbo run dev");

      // 3. Custom name and path -> clients/portal
      const customPathDir = path.join(workspaceDir, "custom-clients");
      const customPathRun = testRuntime([
        "init",
        customPathDir,
        "--preset",
        "vue-app:portal:clients/portal",
      ]);
      assert.equal(await runCli(customPathRun.runtime), 0);
      const customPathDoc = JSON.parse(customPathRun.stdout()) as {
        readonly data: {
          readonly packages: readonly {
            readonly name: string;
            readonly path: string;
          }[];
        };
      };
      assert.deepStrictEqual(customPathDoc.data.packages, [
        {
          name: "@custom-clients/portal",
          path: "clients/portal",
          role: "browser-app",
          preset: "vue-app",
        },
      ]);
      assert.equal(
        existsSync(path.join(customPathDir, "clients/portal/package.json")),
        true,
      );
      const customPathWorkspaceYaml = parseYaml(
        readFileSync(path.join(customPathDir, "pnpm-workspace.yaml"), "utf8"),
      ) as { readonly packages: readonly string[] };
      assert.deepStrictEqual(customPathWorkspaceYaml.packages, [
        "clients/*",
        "packages/*",
      ]);
    });
  });

  void it("initializes fixed-topology vue-hono-app with rewritten cross-package deps, API import specifiers, and e2e package filters", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "acme-fullstack");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "vue-hono-app",
        "--scope",
        "acme-fs",
      ]);
      assert.equal(await runCli(run.runtime), 0);
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
      assert.equal(doc.data.scope, "acme-fs");
      assert.deepStrictEqual(doc.data.packages, [
        {
          name: "@acme-fs/api",
          path: "apps/api",
          role: "runtime-service",
          preset: "vue-hono-app",
        },
        {
          name: "@acme-fs/web",
          path: "apps/web",
          role: "browser-app",
          preset: "vue-hono-app",
        },
        {
          name: "@acme-fs/e2e",
          path: "packages/e2e",
          role: "native-package",
          preset: "vue-hono-app",
        },
      ]);

      // Pure private app: no npm-publication, no root test:e2e splicing
      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        false,
      );
      assert.equal(
        existsSync(path.join(targetDir, ".github/workflows/release.yml")),
        false,
      );
      assert.equal(
        existsSync(path.join(targetDir, "playwright.config.ts")),
        false,
      );

      const rootPkg = JSON.parse(
        readFileSync(path.join(targetDir, "package.json"), "utf8"),
      ) as { readonly scripts: Record<string, string> };
      assert.equal(rootPkg.scripts.dev, "turbo run dev");
      assert.equal("test:e2e" in rootPkg.scripts, false);

      // apps/web manifest, turbo.json, and source API import specifier rewritten
      const webPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly dependencies: Record<string, string>;
      };
      assert.equal(webPkg.name, "@acme-fs/web");
      assert.equal(webPkg.dependencies["@acme-fs/api"], "workspace:*");
      assert.equal(
        "@boringparts/reference-hono-api" in webPkg.dependencies,
        false,
      );

      const webApiTs = readFileSync(
        path.join(targetDir, "apps/web/src/api.ts"),
        "utf8",
      );
      assert.ok(webApiTs.includes('from "@acme-fs/api"'));
      assert.equal(webApiTs.includes("@boringparts/reference-hono-api"), false);

      const webTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<string, { readonly dependsOn?: string[] }>;
      };
      assert.deepStrictEqual(webTurbo.tasks.build?.dependsOn, [
        "@acme-fs/api#build",
        "^build",
      ]);
      assert.deepStrictEqual(webTurbo.tasks.typecheck?.dependsOn, [
        "@acme-fs/api#build",
        "^typecheck",
      ]);
      assert.ok(webTurbo.tasks.dev?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks["test:browser"]?.dependsOn?.includes("^build"));

      const webViteConfig = readFileSync(
        path.join(targetDir, "apps/web/vite.config.ts"),
        "utf8",
      );
      assert.equal(webViteConfig.includes("conditions"), false);

      // packages/e2e manifest, turbo.json, and playwright.config.ts rewritten
      const e2ePkg = JSON.parse(
        readFileSync(path.join(targetDir, "packages/e2e/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly exports?: Record<string, unknown>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(e2ePkg.name, "@acme-fs/e2e");
      assert.equal(e2ePkg.devDependencies["@acme-fs/api"], "workspace:*");
      assert.equal(e2ePkg.devDependencies["@acme-fs/web"], "workspace:*");
      assert.equal(
        Object.hasOwn(e2ePkg.exports ?? {}, "./package.json"),
        false,
      );
      assert.equal(Object.hasOwn(e2ePkg.exports ?? {}, "./reference"), false);
      assert.equal(
        existsSync(path.join(targetDir, "packages/e2e/.npmignore")),
        false,
      );

      const e2eTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "packages/e2e/turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<
          string,
          { readonly dependsOn?: string[]; readonly tags?: string[] }
        >;
      };
      assert.deepStrictEqual(e2eTurbo.tasks["test:e2e"]?.tags, [
        "quality:heavy",
      ]);
      assert.deepStrictEqual(e2eTurbo.tasks["test:e2e"]?.dependsOn, [
        "@acme-fs/api#build",
        "@acme-fs/web#build",
        "browser:prepare",
      ]);

      const playwrightConfig = readFileSync(
        path.join(targetDir, "packages/e2e/playwright.config.ts"),
        "utf8",
      );
      assert.ok(
        playwrightConfig.includes('const apiPackageName = "@acme-fs/api";'),
      );
      assert.ok(
        playwrightConfig.includes('const webPackageName = "@acme-fs/web";'),
      );
      assert.equal(playwrightConfig.includes("@boringparts/reference-"), false);
    });
  });

  void it("rejects fixed topology overrides on vue-hono-app with exit code 2 and zero disk writes", async () => {
    await withTempDir(async (workspaceDir) => {
      for (const spec of [
        "vue-hono-app:custom",
        "vue-hono-app:custom:apps/custom",
      ]) {
        const targetDir = path.join(workspaceDir, "rejected-repo");
        const run = testRuntime(["init", targetDir, "--preset", spec]);
        assert.equal(await runCli(run.runtime), 2, spec);
        assert.equal(run.stdout(), "", spec);
        const failure = JSON.parse(run.stderr()) as {
          readonly kind: string;
          readonly variant: string;
          readonly data: {
            readonly issues: readonly { readonly code: string }[];
          };
        };
        assert.equal(failure.kind, "failure", spec);
        assert.equal(failure.variant, "invalidRequest", spec);
        assert.ok(
          failure.data.issues.some(
            (issue) => issue.code === "FIXED_TOPOLOGY_OVERRIDE",
          ),
          spec,
        );
        assert.equal(existsSync(targetDir), false, spec);
      }
    });
  });

  void it("links ts-lib into vue-hono-app web and api packages and rejects browser-app linking to node-library", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "linked-fullstack");
      const linkedRun = testRuntime([
        "init",
        targetDir,
        "--preset",
        "vue-hono-app",
        "--preset",
        "ts-lib",
        "--link",
        "apps/web:packages/lib",
        "--link",
        "apps/api:packages/lib",
      ]);
      assert.equal(await runCli(linkedRun.runtime), 0);
      assert.equal(linkedRun.stderr(), "");

      // ts-lib is publishable -> npm-publication enabled
      assert.equal(
        existsSync(path.join(targetDir, ".changeset/config.json")),
        true,
      );

      const webPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(webPkg.dependencies["@linked-fullstack/api"], "workspace:*");
      assert.equal(webPkg.dependencies["@linked-fullstack/lib"], "workspace:*");

      const apiPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/api/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(apiPkg.dependencies["@linked-fullstack/lib"], "workspace:*");

      // browser-app (apps/web) cannot link to node-library
      const rejectedDir = path.join(workspaceDir, "bad-link-repo");
      const rejectedRun = testRuntime([
        "init",
        rejectedDir,
        "--preset",
        "vue-hono-app",
        "--preset",
        "node-lib",
        "--link",
        "apps/web:packages/node-lib",
      ]);
      assert.equal(await runCli(rejectedRun.runtime), 2);
      assert.equal(rejectedRun.stdout(), "");
      const failure = JSON.parse(rejectedRun.stderr()) as {
        readonly variant: string;
        readonly data: {
          readonly issues: readonly { readonly code: string }[];
        };
      };
      assert.equal(failure.variant, "invalidRequest");
      assert.ok(
        failure.data.issues.some((issue) => issue.code === "UNSUPPORTED_LINK"),
      );
      assert.equal(existsSync(rejectedDir), false);
    });
  });

  void it("configures vue-app + ts-lib --link with ^build test dependencies and serve-only source resolution", async () => {
    await withTempDir(async (workspaceDir) => {
      const targetDir = path.join(workspaceDir, "linked-vue-app");
      const run = testRuntime([
        "init",
        targetDir,
        "--preset",
        "vue-app",
        "--preset",
        "ts-lib",
        "--link",
        "apps/web:packages/lib",
      ]);
      assert.equal(await runCli(run.runtime), 0, run.stderr());
      assert.equal(run.stderr(), "");

      const webPkg = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/package.json"), "utf8"),
      ) as { readonly dependencies: Record<string, string> };
      assert.equal(webPkg.dependencies["@linked-vue-app/lib"], "workspace:*");

      const webTurbo = JSON.parse(
        readFileSync(path.join(targetDir, "apps/web/turbo.json"), "utf8"),
      ) as {
        readonly tasks: Record<string, { readonly dependsOn?: string[] }>;
      };
      assert.ok(webTurbo.tasks.dev?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks.build?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks.test?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks["test:browser"]?.dependsOn?.includes("^build"));
      assert.ok(webTurbo.tasks["test:e2e"]?.dependsOn?.includes("^build"));

      const viteConfig = readFileSync(
        path.join(targetDir, "apps/web/vite.config.ts"),
        "utf8",
      );
      assert.equal(viteConfig.includes("conditions"), false);
    });
  });
});
