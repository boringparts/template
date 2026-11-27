import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the `ts-cli` preset backed by `@boringparts/reference-ts-cli`. */
export function createTsCliPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-ts-cli",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "ts-cli",
    title: "TypeScript CLI Application",
    description:
      "Node.js CLI package using @boringparts/cli-contract with unit, integration, and e2e journeys.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "cli",
        defaultName: "cli",
        defaultCollection: "packages",
        defaultPath: "packages/cli",
        reference: {
          packageName: "@boringparts/reference-ts-cli",
          packageDir,
          role: "cli-tool",
          publishable: true,
          rewriteBinName: true,
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
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
            { sourcePath: "resources/npmignore", targetPath: ".npmignore" },
            { sourcePath: "src/cli.ts", targetPath: "src/cli.ts" },
            { sourcePath: "src/main.ts", targetPath: "src/main.ts" },
            {
              sourcePath: "src/cli-command-identity.ts",
              targetPath: "src/cli-command-identity.ts",
            },
            {
              sourcePath: "test/unit/cli-command-identity.test.ts",
              targetPath: "test/unit/cli-command-identity.test.ts",
            },
            {
              sourcePath: "test/integration/command.test.ts",
              targetPath: "test/integration/command.test.ts",
            },
            {
              sourcePath: "test/e2e/journey.ts",
              targetPath: "test/e2e/journey.ts",
            },
            {
              sourcePath: "test/e2e/journeys/lookup.journey.ts",
              targetPath: "test/e2e/journeys/lookup.journey.ts",
            },
            {
              sourcePath: "test/e2e/run-journeys.ts",
              targetPath: "test/e2e/run-journeys.ts",
            },
            {
              sourcePath: "test/e2e/source-journeys.test.ts",
              targetPath: "test/e2e/source-journeys.test.ts",
            },
          ],
        },
      },
    ],
    capabilities: {
      devcontainerLayers: ["github-cli"],
      editorCapabilities: ["oxc-format-lint"],
    },
  };
}
