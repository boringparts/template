import { readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { WorkspaceTemplateRoots } from "../core/index.ts";
import {
  loadWorkspacePolicy,
  resolveReferencePackageDir,
} from "../sources/index.ts";
import { createBasePackages } from "./base-packages.ts";
import type { WorkspaceEnvironmentMeta } from "./environment-meta.ts";

/**
 * Resolves a workspace package directory either from an explicit bundled `templatesRoot`
 * or via Node module resolution against the caller's `import.meta.url` in source mode.
 */
export function resolvePackageDir(
  packageName: string,
  callerMetaUrl: string,
  templatesRoot?: string,
): string {
  return resolveReferencePackageDir(packageName, callerMetaUrl, templatesRoot);
}

/** Reads `@playwright/test` version from the loaded `WorkspacePolicy` catalog. */
export function resolvePlaywrightVersion(templatesRoot?: string): string {
  const policy = loadWorkspacePolicy(templatesRoot);
  const version = policy.catalog["@playwright/test"];
  if (typeof version !== "string" || version.length === 0) {
    throw new Error('Workspace policy catalog must define "@playwright/test"');
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

/** Resolves the shared monorepo base packages and workspace policy for engine synthesis. */
export function resolveTemplateWorkspaceRoots(
  templatesRoot?: string,
): WorkspaceTemplateRoots<WorkspaceEnvironmentMeta> {
  return {
    basePackages: createBasePackages(templatesRoot),
    workspacePolicy: loadWorkspacePolicy(templatesRoot),
    ...(templatesRoot === undefined ? {} : { templatesRoot }),
  };
}
