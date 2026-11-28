import { parse as parseToml } from "smol-toml";

import type { WorkspaceTemplateRoots } from "../core/index.ts";
import {
  loadWorkspacePolicy,
  readPackageSourceFile,
  resolveReferencePackageDir,
  type RegisteredReferencePackage,
} from "../sources/index.ts";
import {
  createSingletonPackages,
  createWorkspaceRoot,
} from "./base-packages.ts";
import { loadBuiltInPresets } from "./built-in.ts";

const decoder = new TextDecoder();
const referencePackagePrefix = "@boringparts/reference-";

/**
 * Collects all declared `@boringparts/reference-*` packages from the workspace root,
 * singleton packages, and built-in presets, deduplicated and sorted by slug.
 */
export function collectRegisteredReferencePackages(
  templatesRoot?: string,
): readonly RegisteredReferencePackage[] {
  const workspaceRoot = createWorkspaceRoot(templatesRoot);
  const candidates: readonly {
    readonly packageName: string;
    readonly packageDir: string;
  }[] = [
    {
      packageName: workspaceRoot.packageName,
      packageDir: workspaceRoot.packageDir,
    },
    ...createSingletonPackages(templatesRoot).map(
      (singleton) => singleton.referencePackage,
    ),
    ...loadBuiltInPresets(templatesRoot).flatMap((preset) =>
      preset.nodes.map((node) => node.referencePackage),
    ),
  ];

  const bySlug = new Map<string, RegisteredReferencePackage>();
  for (const candidate of candidates) {
    if (!candidate.packageName.startsWith(referencePackagePrefix)) {
      continue;
    }
    const slug = candidate.packageName.slice(referencePackagePrefix.length);
    const existing = bySlug.get(slug);
    if (existing !== undefined) {
      if (existing.packageDir !== candidate.packageDir) {
        throw new Error(
          `Conflicting packageDir for reference package "${candidate.packageName}": "${existing.packageDir}" vs "${candidate.packageDir}".`,
        );
      }
      continue;
    }
    bySlug.set(slug, {
      slug,
      packageName: candidate.packageName,
      packageDir: candidate.packageDir,
    });
  }

  return [...bySlug.values()].toSorted((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
  );
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
  const rustBinRefDir = resolveReferencePackageDir(
    "@boringparts/reference-rust-bin",
    import.meta.url,
    templatesRoot,
  );
  const toolchainFile = readPackageSourceFile(
    rustBinRefDir,
    "rust-toolchain.toml",
  );
  const parsed = parseToml(decoder.decode(toolchainFile.content)) as {
    readonly toolchain?: Readonly<Record<string, unknown>>;
  };
  const channel = parsed.toolchain?.channel;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error(
      "rust-bin rust-toolchain.toml must declare toolchain.channel",
    );
  }
  return channel;
}

/** Resolves the workspace root, singleton subpackages, and workspace policy for synthesis. */
export function resolveTemplateWorkspaceRoots(
  templatesRoot?: string,
): WorkspaceTemplateRoots {
  return {
    workspaceRoot: createWorkspaceRoot(templatesRoot),
    singletonPackages: createSingletonPackages(templatesRoot),
    workspacePolicy: loadWorkspacePolicy(templatesRoot),
    ...(templatesRoot === undefined ? {} : { templatesRoot }),
  };
}
