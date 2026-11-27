import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

import referenceManifest from "../package.json" with { type: "json" };

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  resourceRoot: new URL("../", import.meta.url),
  alias: "node-library",
  instance: "independent",
  defaultLeafName: "node-lib",
  role: "node-library",
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
  rootAttachmentDependencies: [
    {
      key: "npm-publication",
      ownerLocal: {
        specifier: "@boringparts/reference-npm-publication/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "resources/gitignore", targetPath: ".gitignore" },
    { path: "resources/npmignore", targetPath: ".npmignore" },
    { path: "src/artifact-schema.ts" },
    { path: "src/index.ts" },
    { path: "test/artifact-key.test.ts" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "tsconfig.build.json" },
    { path: "turbo.json" },
  ],
  templateDependencies: [
    { name: "@boringparts/tooling-config", purpose: "template-build" },
    {
      name: "@boringparts/reference-tooling-config",
      purpose: "target",
    },
    {
      name: "@boringparts/reference-tooling-config",
      purpose: "template-execution",
    },
    { name: "@boringparts/template-core", purpose: "template-build" },
    {
      name: "@boringparts/default-content-authoring",
      purpose: "template-execution",
    },
    {
      name: "@boringparts/reference-workspace-root",
      purpose: "template-execution",
    },
    {
      name: "@boringparts/reference-npm-publication",
      purpose: "template-execution",
    },
  ],
  executionDependencies: [
    "@boringparts/default-content-authoring",
    "@boringparts/reference-workspace-root",
    "@boringparts/reference-tooling-config",
    "@boringparts/reference-npm-publication",
  ],
  templateScripts: ["build:template", "check:author-planning-roles"],
  templateExports: ["./reference", "./template"],
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
