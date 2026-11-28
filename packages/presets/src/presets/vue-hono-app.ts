import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/**
 * Builds the fixed-topology `vue-hono-app` preset combining `apps/api`, `apps/web`,
 * and the private joint Playwright verification subpackage `packages/e2e`.
 */
export function createVueHonoAppPreset(
  templatesRoot?: string,
): PresetDefinition {
  const apiDir = resolvePackageDir(
    "@boringparts/reference-hono-api",
    import.meta.url,
    templatesRoot,
  );
  const webDir = resolvePackageDir(
    "@boringparts/reference-vue-hono-web",
    import.meta.url,
    templatesRoot,
  );
  const e2eDir = resolvePackageDir(
    "@boringparts/reference-vue-hono-e2e",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "vue-hono-app",
    title: "Vue-Hono Full-Stack App",
    description:
      "Combines a Vue web app, a Hono API, and a joint Playwright verification package.",
    topology: "fixed",
    nodes: [
      {
        nodeId: "api",
        defaultName: "api",
        defaultCollection: "apps",
        defaultPath: "apps/api",
        reference: {
          packageName: "@boringparts/reference-hono-api",
          packageDir: apiDir,
          role: "runtime-service",
          publishable: false,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "tsconfig.build.json",
              targetPath: "tsconfig.build.json",
            },
            { sourcePath: "src/index.ts", targetPath: "src/index.ts" },
            { sourcePath: "src/runtime.ts", targetPath: "src/runtime.ts" },
            { sourcePath: "src/server.ts", targetPath: "src/server.ts" },
            { sourcePath: "test/app.test.ts", targetPath: "test/app.test.ts" },
          ],
        },
      },
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        dependencyBindings: {
          "@boringparts/reference-hono-api": "api",
        },
        reference: {
          packageName: "@boringparts/reference-vue-hono-web",
          packageDir: webDir,
          role: "browser-app",
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
            { sourcePath: "vite.config.ts", targetPath: "vite.config.ts" },
            { sourcePath: "vitest.config.ts", targetPath: "vitest.config.ts" },
            { sourcePath: "env.d.ts", targetPath: "env.d.ts" },
            { sourcePath: "index.html", targetPath: "index.html" },
            { sourcePath: "TESTING.md", targetPath: "TESTING.md" },
            { sourcePath: "src/App.vue", targetPath: "src/App.vue" },
            { sourcePath: "src/api.ts", targetPath: "src/api.ts" },
            { sourcePath: "src/main.ts", targetPath: "src/main.ts" },
            { sourcePath: "src/style.css", targetPath: "src/style.css" },
            {
              sourcePath: "test/app.browser.test.ts",
              targetPath: "test/app.browser.test.ts",
            },
          ],
        },
      },
      {
        nodeId: "e2e",
        defaultName: "e2e",
        defaultCollection: "packages",
        defaultPath: "packages/e2e",
        dependencyBindings: {
          "@boringparts/reference-hono-api": "api",
          "@boringparts/reference-vue-hono-web": "web",
        },
        reference: {
          packageName: "@boringparts/reference-vue-hono-e2e",
          packageDir: e2eDir,
          role: "native-package",
          publishable: false,
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "tsconfig.json", targetPath: "tsconfig.json" },
            {
              sourcePath: "playwright.config.ts",
              targetPath: "playwright.config.ts",
            },
            {
              sourcePath: "test/e2e/app.spec.ts",
              targetPath: "test/e2e/app.spec.ts",
            },
            {
              sourcePath: "test/e2e/fixtures.ts",
              targetPath: "test/e2e/fixtures.ts",
            },
          ],
        },
      },
    ],
    capabilities: {
      devcontainerLayers: ["github-cli", "browser-test"],
      editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
      rootDevDelegateNodeId: "web",
      allowBuilds: ["esbuild"],
      pnpmOverrides: ["pinia>typescript", "vue>typescript"],
    },
  };
}
