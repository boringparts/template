import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the `vue-app` preset backed by `@boringparts/reference-vue-app`. */
export function createVueAppPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-vue-app",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "vue-app",
    title: "Vue App",
    description:
      "Vue application workspace with Vite, Tailwind CSS, Pinia, and testing tools.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        reference: {
          packageName: "@boringparts/reference-vue-app",
          packageDir,
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
            {
              sourcePath: "playwright.config.ts",
              targetPath: "playwright.config.ts",
            },
            { sourcePath: "env.d.ts", targetPath: "env.d.ts" },
            { sourcePath: "index.html", targetPath: "index.html" },
            { sourcePath: "TESTING.md", targetPath: "TESTING.md" },
            { sourcePath: "src/App.vue", targetPath: "src/App.vue" },
            {
              sourcePath: "src/components/CounterButton.vue",
              targetPath: "src/components/CounterButton.vue",
            },
            { sourcePath: "src/main.ts", targetPath: "src/main.ts" },
            {
              sourcePath: "src/stores/counter.ts",
              targetPath: "src/stores/counter.ts",
            },
            { sourcePath: "src/style.css", targetPath: "src/style.css" },
            {
              sourcePath: "test/app.browser.test.ts",
              targetPath: "test/app.browser.test.ts",
            },
            {
              sourcePath: "test/counter.node.test.ts",
              targetPath: "test/counter.node.test.ts",
            },
            {
              sourcePath: "test/e2e/app.spec.ts",
              targetPath: "test/e2e/app.spec.ts",
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
