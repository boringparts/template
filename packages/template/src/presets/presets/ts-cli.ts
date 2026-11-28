import type { PresetDefinition } from "../../core/index.ts";
import { resolveReferencePackageDir } from "../../sources/index.ts";

/** Builds the `ts-cli` preset backed by `@boringparts/reference-ts-cli`. */
export function createTsCliPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolveReferencePackageDir(
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
        defaultPath: "packages/cli",
        referencePackage: {
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
