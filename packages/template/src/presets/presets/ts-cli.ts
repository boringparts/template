import type { PresetDefinition } from "../../core/index.ts";
import type { WorkspaceEnvironmentMeta } from "../environment-meta.ts";
import { resolvePackageDir } from "../roots.ts";

/** Builds the `ts-cli` preset backed by `@boringparts/reference-ts-cli`. */
export function createTsCliPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
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
        definition: {
          packageName: "@boringparts/reference-ts-cli",
          packageDir,
          role: "cli-tool",
          publishable: true,
          resources: [
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
          ],
        },
      },
    ],
  };
}
