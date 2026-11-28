import type { PresetDefinition } from "../../core/index.ts";
import type { WorkspaceEnvironmentMeta } from "../environment-meta.ts";
import { resolvePackageDir } from "../roots.ts";

/** Builds the `ts-lib` preset backed by `@boringparts/reference-ts-lib`. */
export function createTsLibPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
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
        definition: {
          packageName: "@boringparts/reference-ts-lib",
          packageDir,
          role: "shared-library",
          publishable: true,
          resources: [
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
          ],
        },
      },
    ],
  };
}
