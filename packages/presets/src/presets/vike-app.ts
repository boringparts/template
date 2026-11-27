import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the fixed-topology `vike-app` preset backed by the four Vike reference packages. */
export function createVikeAppPreset(templatesRoot?: string): PresetDefinition {
  const webDir = resolvePackageDir(
    "@boringparts/reference-vike-web",
    import.meta.url,
    templatesRoot,
  );
  const dbDir = resolvePackageDir(
    "@boringparts/reference-vike-db",
    import.meta.url,
    templatesRoot,
  );
  const migrationsDir = resolvePackageDir(
    "@boringparts/reference-vike-migrations",
    import.meta.url,
    templatesRoot,
  );
  const deploymentDir = resolvePackageDir(
    "@boringparts/reference-vike-deployment",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "vike-app",
    title: "Vike App",
    description:
      "Full-stack Vike, Hono, Telefunc, Drizzle SQLite, and dual-target Docker deployment monorepo.",
    topology: "fixed",
    nodes: [
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-deployment": "deployment",
        },
        reference: {
          packageName: "@boringparts/reference-vike-web",
          packageDir: webDir,
          role: "runtime-service",
          publishable: false,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "tsconfig.app.json",
              targetPath: "tsconfig.app.json",
            },
            {
              sourcePath: "tsconfig.node.json",
              targetPath: "tsconfig.node.json",
            },
            { sourcePath: "+server.ts", targetPath: "+server.ts" },
            { sourcePath: ".env.example", targetPath: ".env.example" },
            { sourcePath: "TESTING.md", targetPath: "TESTING.md" },
            { sourcePath: "assets/logo.svg", targetPath: "assets/logo.svg" },
            {
              sourcePath: "components/PageShell.vue",
              targetPath: "components/PageShell.vue",
            },
            { sourcePath: "pages/+Head.vue", targetPath: "pages/+Head.vue" },
            {
              sourcePath: "pages/+Layout.vue",
              targetPath: "pages/+Layout.vue",
            },
            { sourcePath: "pages/+config.ts", targetPath: "pages/+config.ts" },
            {
              sourcePath: "pages/index/+Page.telefunc.ts",
              targetPath: "pages/index/+Page.telefunc.ts",
            },
            {
              sourcePath: "pages/index/+Page.vue",
              targetPath: "pages/index/+Page.vue",
            },
            {
              sourcePath: "pages/tailwind.css",
              targetPath: "pages/tailwind.css",
            },
            {
              sourcePath: "playwright.config.ts",
              targetPath: "playwright.config.ts",
            },
            { sourcePath: "server/api.ts", targetPath: "server/api.ts" },
            { sourcePath: "server/app.ts", targetPath: "server/app.ts" },
            {
              sourcePath: "server/database.ts",
              targetPath: "server/database.ts",
            },
            {
              sourcePath: "test/e2e/app.spec.ts",
              targetPath: "test/e2e/app.spec.ts",
            },
            {
              sourcePath: "test/playwright-teardown.ts",
              targetPath: "test/playwright-teardown.ts",
            },
            {
              sourcePath: "test/todos.browser.test.ts",
              targetPath: "test/todos.browser.test.ts",
            },
            { sourcePath: "tooling/vite.ts", targetPath: "tooling/vite.ts" },
            { sourcePath: "types/env.d.ts", targetPath: "types/env.d.ts" },
            {
              sourcePath: "types/global.d.ts",
              targetPath: "types/global.d.ts",
            },
            { sourcePath: "vite.config.ts", targetPath: "vite.config.ts" },
            { sourcePath: "vitest.config.ts", targetPath: "vitest.config.ts" },
          ],
        },
      },
      {
        nodeId: "db",
        defaultName: "db",
        defaultCollection: "packages",
        defaultPath: "packages/db",
        dependencyBindings: {
          "@boringparts/reference-vike-deployment": "deployment",
        },
        reference: {
          packageName: "@boringparts/reference-vike-db",
          packageDir: dbDir,
          role: "node-library",
          publishable: false,
          preservePackageJsonExport: true,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "tsconfig.node.json",
              targetPath: "tsconfig.node.json",
            },
            {
              sourcePath: "tsconfig.build.json",
              targetPath: "tsconfig.build.json",
            },
            {
              sourcePath: "tsconfig.scripts.json",
              targetPath: "tsconfig.scripts.json",
            },
            {
              sourcePath: "scripts/seed-example.ts",
              targetPath: "scripts/seed-example.ts",
            },
            { sourcePath: "src/db.ts", targetPath: "src/db.ts" },
            { sourcePath: "src/index.ts", targetPath: "src/index.ts" },
            {
              sourcePath: "src/queries/todos.ts",
              targetPath: "src/queries/todos.ts",
            },
            { sourcePath: "src/readiness.ts", targetPath: "src/readiness.ts" },
            { sourcePath: "src/schema.ts", targetPath: "src/schema.ts" },
            {
              sourcePath: "src/seed/example.ts",
              targetPath: "src/seed/example.ts",
            },
            { sourcePath: "src/storage.ts", targetPath: "src/storage.ts" },
            { sourcePath: "src/types.ts", targetPath: "src/types.ts" },
            {
              sourcePath: "test/todos.test.ts",
              targetPath: "test/todos.test.ts",
            },
          ],
        },
      },
      {
        nodeId: "migrations",
        defaultName: "migrations",
        defaultCollection: "packages",
        defaultPath: "packages/migrations",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
        },
        reference: {
          packageName: "@boringparts/reference-vike-migrations",
          packageDir: migrationsDir,
          role: "node-library",
          publishable: false,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "tsconfig.build.json",
              targetPath: "tsconfig.build.json",
            },
            {
              sourcePath: "drizzle.config.ts",
              targetPath: "drizzle.config.ts",
            },
            {
              sourcePath:
                "drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
              targetPath:
                "drizzle/migrations/20260709120325_old_captain_flint/migration.sql",
            },
            {
              sourcePath:
                "drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
              targetPath:
                "drizzle/migrations/20260709120325_old_captain_flint/snapshot.json",
            },
          ],
        },
      },
      {
        nodeId: "deployment",
        defaultName: "deployment",
        defaultCollection: "packages",
        defaultPath: "packages/deployment",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-migrations": "migrations",
          "@boringparts/reference-vike-web": "web",
        },
        pathReplacements: {
          "references/vike-deployment/resources/deployment/Dockerfile":
            "Dockerfile",
          "references/vike-deployment/resources/deployment/scripts/container-entrypoint.sh":
            "scripts/container-entrypoint.sh",
          "resources/deployment/scripts/container-entrypoint.sh":
            "../../scripts/container-entrypoint.sh",
          "references/vike-web": "apps/web",
        },
        reference: {
          packageName: "@boringparts/reference-vike-deployment",
          packageDir: deploymentDir,
          role: "native-package",
          publishable: false,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "tsconfig.scripts.json",
              targetPath: "tsconfig.scripts.json",
            },
            {
              sourcePath: "scripts/check-standalone-deployment.ts",
              targetPath: "scripts/check-standalone-deployment.ts",
            },
          ],
          rootFiles: [
            {
              sourcePath: "resources/deployment/Dockerfile",
              targetPath: "Dockerfile",
            },
            {
              sourcePath: "resources/deployment/container.dockerignore",
              targetPath: ".dockerignore",
            },
            {
              sourcePath:
                "resources/deployment/scripts/container-entrypoint.sh",
              targetPath: "scripts/container-entrypoint.sh",
              executable: true,
            },
          ],
        },
      },
    ],
    capabilities: {
      devcontainerLayers: ["github-cli", "browser-test", "shellcheck"],
      editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
      rootDockerDependabot: true,
      allowBuilds: ["esbuild"],
      pnpmOverrides: ["pinia>typescript", "vue>typescript"],
      rootDevDelegateNodeId: "web",
    },
  };
}
