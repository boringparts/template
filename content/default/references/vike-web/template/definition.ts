import { playwrightBrowserAssetsEnvironmentNeed } from "@boringparts/default-content-authoring/environment-needs";
import {
  defineReferencePackage,
  type ReferenceTemplateDependency,
} from "@boringparts/default-content-authoring/reference-package";
import type { ReferenceDependency } from "@boringparts/template-core/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

const databaseDependency = {
  key: "database" as const,
  ownerLocal: {
    specifier: "@boringparts/reference-vike-db/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

const baseWorkspaceDependency = {
  key: "base-workspace" as const,
  ownerLocal: {
    specifier: "@boringparts/reference-workspace-root/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

const toolingConfigDependency = {
  key: "tooling-config" as const,
  ownerLocal: {
    specifier: "@boringparts/reference-tooling-config/template",
    resolve: (specifier: string) => import.meta.resolve(specifier),
  },
} as const satisfies ReferenceDependency;

const templateDependencies = [
  { name: "@boringparts/reference-tooling-config", purpose: "target" },
  {
    name: "@boringparts/reference-tooling-config",
    purpose: "template-execution",
  },
  { name: "@boringparts/tooling-config", purpose: "template-build" },
  {
    name: "@boringparts/reference-workspace-root",
    purpose: "template-execution",
  },
  { name: "@boringparts/template-core", purpose: "template-execution" },
  {
    name: "@boringparts/default-content-authoring",
    purpose: "template-execution",
  },
  { name: "typescript-7", purpose: "template-build" },
] as const satisfies readonly ReferenceTemplateDependency[];

export const databaseDependencyKey = databaseDependency.key;

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "vike-web",
  instance: "independent",
  defaultLeafName: "web",
  defaultPath: "apps/web",
  role: "runtime-service",
  dependencies: [
    baseWorkspaceDependency,
    toolingConfigDependency,
    databaseDependency,
  ],
  resources: [
    { path: "+server.ts" },
    { path: ".env.example" },
    { path: "TESTING.md" },
    { path: "assets/logo.svg" },
    { path: "components/PageShell.vue" },
    { path: "pages/+Head.vue" },
    { path: "pages/+Layout.vue" },
    { path: "pages/+config.ts" },
    { path: "pages/index/+Page.telefunc.ts" },
    { path: "pages/index/+Page.vue" },
    { path: "pages/tailwind.css" },
    { path: "playwright.config.ts" },
    { path: "server/api.ts" },
    { path: "server/app.ts" },
    { path: "server/database.ts" },
    { path: "test/e2e/app.spec.ts" },
    { path: "test/playwright-teardown.ts" },
    { path: "test/todos.browser.test.ts" },
    { path: "tooling/vite.ts" },
    { path: "tsconfig.app.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
    { path: "types/env.d.ts" },
    { path: "types/global.d.ts" },
    { path: "vite.config.ts" },
    { path: "vitest.config.ts" },
  ],
  templateDependencies,
  executionDependencies: [
    "@boringparts/template-core",
    "@boringparts/default-content-authoring",
    "@boringparts/reference-workspace-root",
    "@boringparts/reference-tooling-config",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint", "vue", "tailwind", "vitest"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
    workspacePackageGlobs: ["apps/*"],
  },
  environmentNeeds: ({ definition }) => [
    playwrightBrowserAssetsEnvironmentNeed({
      browser: "chromium",
      owner: { kind: "package-boundary", path: definition.path },
    }),
  ],
  ciDiagnosticArtifacts: ({ definition }) => [
    {
      kind: "playwright",
      owner: { kind: "package-boundary", path: definition.path },
    },
    {
      kind: "vitest-browser",
      owner: { kind: "package-boundary", path: definition.path },
    },
  ],
});
