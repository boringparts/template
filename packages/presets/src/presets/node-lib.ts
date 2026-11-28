import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the `node-lib` preset backed by `@boringparts/reference-node-lib`. */
export function createNodeLibPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-node-lib",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "node-lib",
    title: "Node.js TypeScript Library",
    description:
      "Node.js library package targeting >=24.0.0 with Node 24 devEngines and dist verification.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "library",
        defaultName: "node-lib",
        defaultCollection: "packages",
        defaultPath: "packages/node-lib",
        reference: {
          packageName: "@boringparts/reference-node-lib",
          packageDir,
          role: "node-library",
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
            {
              sourcePath: "src/artifact-schema.ts",
              targetPath: "src/artifact-schema.ts",
            },
            { sourcePath: "src/index.ts", targetPath: "src/index.ts" },
            {
              sourcePath: "test/artifact-key.test.ts",
              targetPath: "test/artifact-key.test.ts",
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
