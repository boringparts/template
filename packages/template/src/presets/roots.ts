import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

import type { WorkspaceTemplateRoots } from "../core/index.ts";
import { createBasePackages } from "./base-packages.ts";
import type { WorkspaceEnvironmentMeta } from "./environment-meta.ts";

export type RegisteredReferencePackage = {
  readonly slug: string;
  readonly packageName: string;
  readonly packageDir: string;
};

export type TemplateDistributionSources = {
  readonly rootBaseDir: string;
  readonly referencePackages: readonly RegisteredReferencePackage[];
};

const registeredReferenceSpecs = [
  { slug: "hono-api", packageName: "@boringparts/reference-hono-api" },
  { slug: "node-lib", packageName: "@boringparts/reference-node-lib" },
  { slug: "rust-bin", packageName: "@boringparts/reference-rust-bin" },
  {
    slug: "tooling-config",
    packageName: "@boringparts/reference-tooling-config",
  },
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
  if (
    templatesRoot !== undefined &&
    packageName.startsWith("@boringparts/reference-")
  ) {
    const slug = packageName.slice("@boringparts/reference-".length);
    const candidate = path.join(templatesRoot, "references", slug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const require = createRequire(callerMetaUrl);
  return path.dirname(require.resolve(`${packageName}/reference`));
}

/** Resolves the author repository root (or bundled `templates/root`) directory. */
export function resolveRootBaseDir(templatesRoot?: string): string {
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  return templatesRoot !== undefined &&
    existsSync(path.join(templatesRoot, "root", "package.json"))
    ? path.join(templatesRoot, "root")
    : path.resolve(workspaceRootRefDir, "..", "..");
}

/** Reads `@playwright/test` version from the author `pnpm-workspace.yaml` catalog. */
export function resolvePlaywrightVersion(templatesRoot?: string): string {
  const rootBaseDir = resolveRootBaseDir(templatesRoot);
  const parsed = parseYaml(
    readFileSync(path.join(rootBaseDir, "pnpm-workspace.yaml"), "utf8"),
  ) as { readonly catalog?: Readonly<Record<string, unknown>> };
  const version = parsed.catalog?.["@playwright/test"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      "Author pnpm-workspace.yaml catalog must define @playwright/test",
    );
  }
  return version;
}

/** Reads `toolchain.channel` from `@boringparts/reference-rust-bin`'s `rust-toolchain.toml`. */
export function resolveRustToolchainChannel(templatesRoot?: string): string {
  const rustBinRefDir = resolvePackageDir(
    "@boringparts/reference-rust-bin",
    import.meta.url,
    templatesRoot,
  );
  const parsed = parseToml(
    readFileSync(path.join(rustBinRefDir, "rust-toolchain.toml"), "utf8"),
  ) as { readonly toolchain?: Readonly<Record<string, unknown>> };
  const channel = parsed.toolchain?.channel;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error(
      "rust-bin rust-toolchain.toml must declare toolchain.channel",
    );
  }
  return channel;
}

/** Resolves the shared monorepo base packages and root policy files for engine synthesis. */
export function resolveTemplateWorkspaceRoots(
  templatesRoot?: string,
): WorkspaceTemplateRoots<WorkspaceEnvironmentMeta> {
  const rootBaseDir = resolveRootBaseDir(templatesRoot);

  return {
    rootBaseDir,
    basePackages: createBasePackages(templatesRoot),
    rootPackageJsonPath: path.join(rootBaseDir, "package.json"),
    rootPnpmWorkspaceYamlPath: path.join(rootBaseDir, "pnpm-workspace.yaml"),
  };
}

/**
 * Resolves the exact declared workspace package directories needed when assembling
 * the `@boringparts/template` distribution `templates/` tree.
 */
export function resolveTemplateDistributionSources(): TemplateDistributionSources {
  const referencePackages = registeredReferenceSpecs.map((spec) => ({
    slug: spec.slug,
    packageName: spec.packageName,
    packageDir: resolvePackageDir(spec.packageName, import.meta.url),
  }));
  const workspaceRootRefDir = referencePackages.find(
    (entry) => entry.slug === "workspace-root",
  )!.packageDir;

  return {
    rootBaseDir: path.resolve(workspaceRootRefDir, "..", ".."),
    referencePackages,
  };
}
