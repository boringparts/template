import type { PresetDefinition } from "../../core/index.ts";
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
        defaultPath: "packages/node-lib",
        referencePackage: {
          packageName: "@boringparts/reference-node-lib",
          packageDir,
          role: "node-library",
          publishable: true,
          resources: [
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
          ],
        },
      },
    ],
  };
}
