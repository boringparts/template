import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { WorkspaceTemplateRoots } from "@boringparts/template-engine";

/**
 * Resolves a workspace package directory either from an explicit bundled `templatesRoot`
 * or via Node module resolution against the caller's `import.meta.url` in source mode.
 */
export function resolvePackageDir(
  packageName: string,
  callerMetaUrl: string,
  templatesRoot?: string,
): string {
  if (templatesRoot !== undefined) {
    if (packageName === "@boringparts/tooling-config") {
      const candidate = path.join(templatesRoot, "packages", "tooling-config");
      if (existsSync(candidate)) {
        return candidate;
      }
    } else if (packageName.startsWith("@boringparts/reference-")) {
      const slug = packageName.slice("@boringparts/reference-".length);
      const candidate = path.join(templatesRoot, "references", slug);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  const require = createRequire(callerMetaUrl);
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

/** Resolves the shared monorepo base assets and root policy files for engine synthesis. */
export function resolveTemplateWorkspaceRoots(
  templatesRoot?: string,
): WorkspaceTemplateRoots {
  const toolingConfigDir = resolvePackageDir(
    "@boringparts/tooling-config",
    import.meta.url,
    templatesRoot,
  );
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  const npmPublicationRefDir = resolvePackageDir(
    "@boringparts/reference-npm-publication",
    import.meta.url,
    templatesRoot,
  );
  const rustBinRefDir = resolvePackageDir(
    "@boringparts/reference-rust-bin",
    import.meta.url,
    templatesRoot,
  );

  const rootBaseDir =
    templatesRoot !== undefined &&
    existsSync(path.join(templatesRoot, "root", "package.json"))
      ? path.join(templatesRoot, "root")
      : path.resolve(workspaceRootRefDir, "..", "..");

  return {
    toolingConfigDir,
    workspaceRootRefDir,
    npmPublicationRefDir,
    rootPackageJsonPath: path.join(rootBaseDir, "package.json"),
    rootPnpmWorkspaceYamlPath: path.join(rootBaseDir, "pnpm-workspace.yaml"),
    rootRustToolchainPath: path.join(rootBaseDir, "rust-toolchain.toml"),
    rootOxfmtConfigPath: path.join(rootBaseDir, "oxfmt.config.ts"),
    rootOxlintConfigPath: path.join(rootBaseDir, "oxlint.config.ts"),
    rustLayerDockerfilePath: path.join(
      rustBinRefDir,
      "resources",
      "devcontainer",
      "rust.Dockerfile",
    ),
  };
}
