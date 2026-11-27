import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "hono-api",
  instance: "independent",
  defaultLeafName: "api",
  defaultPath: "apps/api",
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
    { path: "src/index.ts" },
    { path: "src/runtime.ts" },
    { path: "src/server.ts" },
    { path: "test/app.test.ts" },
    { path: "tsconfig.build.json" },
    { path: "tsconfig.json" },
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
    { name: "@boringparts/template-core", purpose: "template-build" },
    {
      name: "@boringparts/default-content-authoring",
      purpose: "template-execution",
    },
    { name: "typescript-7", purpose: "target" },
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
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
});
