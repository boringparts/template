import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";
import type { ReferenceDependency } from "@boringparts/template-core/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

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

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "vike-database",
  instance: "independent",
  defaultLeafName: "db",
  defaultPath: "packages/db",
  role: "shared-library",
  dependencies: [baseWorkspaceDependency, toolingConfigDependency],
  resources: [
    { path: "scripts/seed-example.ts" },
    { path: "src/db.ts" },
    { path: "src/index.ts" },
    { path: "src/queries/todos.ts" },
    { path: "src/readiness.ts" },
    { path: "src/schema.ts" },
    { path: "src/seed/example.ts" },
    { path: "src/storage.ts" },
    { path: "src/types.ts" },
    { path: "test/todos.test.ts" },
    { path: "tsconfig.build.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "tsconfig.scripts.json" },
    { path: "turbo.json" },
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
    {
      name: "@boringparts/template-core",
      purpose: "template-execution",
    },
    {
      name: "@boringparts/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "typescript-7", purpose: "target" },
    { name: "typescript-7", purpose: "template-build" },
  ],
  executionDependencies: [
    "@boringparts/template-core",
    "@boringparts/default-content-authoring",
    "@boringparts/reference-workspace-root",
    "@boringparts/reference-tooling-config",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: [],
});
