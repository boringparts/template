import { playwrightBrowserAssetsEnvironmentNeed } from "@boringparts/default-content-authoring/environment-needs";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "vue-app",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  dependencies: [
    {
      key: "base-workspace",
      ownerLocal: {
        specifier: "@boringparts/reference-workspace-root/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
    {
      key: "tooling-config",
      ownerLocal: {
        specifier: "@boringparts/reference-tooling-config/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "TESTING.md" },
    { path: "env.d.ts" },
    { path: "index.html" },
    { path: "playwright.config.ts" },
    { path: "src/App.vue" },
    { path: "src/components/CounterButton.vue" },
    { path: "src/main.ts" },
    { path: "src/stores/counter.ts" },
    { path: "src/style.css" },
    { path: "test/app.browser.test.ts" },
    { path: "test/counter.node.test.ts" },
    { path: "test/e2e/app.spec.ts" },
    { path: "tsconfig.app.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
    { path: "vite.config.ts" },
    { path: "vitest.config.ts" },
  ],
  templateDependencies: [
    { name: "@boringparts/tooling-config", purpose: "template-build" },
    { name: "@boringparts/reference-tooling-config", purpose: "target" },
    {
      name: "@boringparts/reference-tooling-config",
      purpose: "template-execution",
    },
    {
      name: "@boringparts/reference-workspace-root",
      purpose: "template-execution",
    },
    { name: "@boringparts/template-core", purpose: "template-build" },
    {
      name: "@boringparts/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "typescript-7", purpose: "template-build" },
  ],
  executionDependencies: [
    "@boringparts/reference-tooling-config",
    "@boringparts/reference-workspace-root",
    "@boringparts/default-content-authoring",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  ciDiagnosticArtifacts: ({ definition }) => [
    {
      kind: "vitest-browser",
      owner: { kind: "package-boundary", path: definition.path },
    },
    {
      kind: "playwright",
      owner: { kind: "package-boundary", path: definition.path },
    },
  ],
});
