import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { WorkspaceTemplateRoots } from "@boringparts/template-engine";

export type RegisteredReferencePackage = {
  readonly slug: string;
  readonly packageName: string;
  readonly packageDir: string;
};

export type TemplateDistributionSources = {
  readonly toolingConfigDir: string;
  readonly rootBaseDir: string;
  readonly referencePackages: readonly RegisteredReferencePackage[];
};

const registeredReferenceSpecs = [
  { slug: "hono-api", packageName: "@boringparts/reference-hono-api" },
  { slug: "node-lib", packageName: "@boringparts/reference-node-lib" },
  {
    slug: "npm-publication",
    packageName: "@boringparts/reference-npm-publication",
  },
  { slug: "rust-bin", packageName: "@boringparts/reference-rust-bin" },
  { slug: "ts-cli", packageName: "@boringparts/reference-ts-cli" },
  { slug: "ts-lib", packageName: "@boringparts/reference-ts-lib" },
  { slug: "vike-db", packageName: "@boringparts/reference-vike-db" },
  {
    slug: "vike-deployment",
    packageName: "@boringparts/reference-vike-deployment",
  },
  {
    slug: "vike-migrations",
    packageName: "@boringparts/reference-vike-migrations",
  },
  { slug: "vike-web", packageName: "@boringparts/reference-vike-web" },
  { slug: "vue-app", packageName: "@boringparts/reference-vue-app" },
  { slug: "vue-hono-e2e", packageName: "@boringparts/reference-vue-hono-e2e" },
  { slug: "vue-hono-web", packageName: "@boringparts/reference-vue-hono-web" },
  {
    slug: "workspace-root",
    packageName: "@boringparts/reference-workspace-root",
  },
] as const;

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
    rustLockfilePath: path.join(rustBinRefDir, "Cargo.lock"),
  };
}

/**
 * Resolves the exact declared workspace package directories needed when assembling
 * the `@boringparts/template` distribution `templates/` tree.
 */
export function resolveTemplateDistributionSources(): TemplateDistributionSources {
  const toolingConfigDir = resolvePackageDir(
    "@boringparts/tooling-config",
    import.meta.url,
  );
  const referencePackages = registeredReferenceSpecs.map((spec) => ({
    slug: spec.slug,
    packageName: spec.packageName,
    packageDir: resolvePackageDir(spec.packageName, import.meta.url),
  }));
  const workspaceRootRefDir = referencePackages.find(
    (entry) => entry.slug === "workspace-root",
  )!.packageDir;

  return {
    toolingConfigDir,
    rootBaseDir: path.resolve(workspaceRootRefDir, "..", ".."),
    referencePackages,
  };
}
