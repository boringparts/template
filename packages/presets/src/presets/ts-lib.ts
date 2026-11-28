import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the `ts-lib` preset backed by `@boringparts/reference-ts-lib`. */
export function createTsLibPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-ts-lib",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "ts-lib",
    title: "TypeScript Library",
    description:
      "Platform-agnostic TypeScript library package with strict es2024 type boundaries.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "library",
        defaultName: "lib",
        defaultCollection: "packages",
        defaultPath: "packages/lib",
        reference: {
          packageName: "@boringparts/reference-ts-lib",
          packageDir,
          role: "shared-library",
          publishable: true,
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
            { sourcePath: "src/index.ts", targetPath: "src/index.ts" },
            {
              sourcePath: "src/name-schema.ts",
              targetPath: "src/name-schema.ts",
            },
            {
              sourcePath: "test/greet.test.ts",
              targetPath: "test/greet.test.ts",
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
