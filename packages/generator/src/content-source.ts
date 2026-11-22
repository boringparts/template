import { isDeepStrictEqual } from "node:util";

import {
  createContentIndex,
  type ContentIdentity,
  type ContentKind,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { ReferencePackageDefinition } from "@ykdz/template-core/reference-package";

export type ContentSourceOptions = Readonly<{
  readonly namespace: string;
  /** Module resolver provided by the module owning this content collection. */
  readonly resolve: (specifier: string) => string;
  /** Public code entry specifiers; register only one entry per member. */
  readonly members: readonly string[];
}>;

/** Selects a content module using both its public package specifier and a literal dynamic import for type inference. */
export type ContentSourceEntry<Module = unknown> = Readonly<{
  readonly specifier: string;
  readonly load: () => Promise<Module>;
}>;

type DefinitionFromModule<Module> = Module extends {
  readonly referencePackage: infer Definition;
}
  ? Module extends { readonly preset: unknown }
    ? never
    : LoadedContentMember<Definition, "reference">
  : Module extends { readonly preset: infer Definition }
    ? LoadedContentMember<Definition, "preset">
    : never;

/** Infers a loaded content member's definition type and kind from a public native module namespace. */
export type LoadedContentSourceMember<Module = unknown> =
  DefinitionFromModule<Module>;

/** Preserves the concrete definition type and kind of each entry's loader callback. */
export type LoadedContentSourceMembers<
  Entries extends readonly ContentSourceEntry[],
> = {
  readonly [Index in keyof Entries]: LoadedContentSourceMember<
    Awaited<ReturnType<Entries[Index]["load"]>>
  >;
};

export type DynamicLoadedSourceMember =
  | LoadedContentMember<unknown, "reference">
  | LoadedContentMember<unknown, "preset">;

type ContentSourceBaseOptions = Omit<ContentSourceOptions, "members">;
type RuntimeContentSourceEntry = ContentSourceEntry<unknown>;
type RuntimeContentSourceOptions = ContentSourceBaseOptions &
  Readonly<{
    readonly members: readonly (string | RuntimeContentSourceEntry)[];
  }>;

type NativeManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly exports: Readonly<Record<string, unknown>>;
};

type PresetDefinition = Readonly<{
  readonly kind: "preset";
  readonly metadata: Readonly<{ readonly alias: string }>;
  readonly owner?: Readonly<{
    readonly packageName: string;
    readonly exportPath: string;
  }>;
}>;

export type LoadedSourceMember = DynamicLoadedSourceMember;

/** Loads a content collection from public package code and manifest entries using the collection's own Node module resolver. Throws if any specifier is invalid, fails to resolve to a local `file:` URL, mismatches its manifest, or lacks a single primary preset or reference package export. */
export function loadContentSource<
  const Entries extends readonly ContentSourceEntry[],
>(
  options: ContentSourceBaseOptions & Readonly<{ readonly members: Entries }>,
): Promise<LoadedContentSourceMembers<Entries>>;
export function loadContentSource(
  options: ContentSourceOptions,
): Promise<readonly LoadedSourceMember[]>;
export async function loadContentSource(
  options: RuntimeContentSourceOptions,
): Promise<readonly LoadedSourceMember[]> {
  if (options.namespace.trim().length === 0) {
    throw new Error("Content source namespace cannot be empty");
  }
  const members = await Promise.all(
    options.members.map(async (entry) =>
      typeof entry === "string"
        ? await loadMember(options, entry)
        : await loadMember(options, entry.specifier, entry.load),
    ),
  );
  createContentIndex(members);
  return Object.freeze(members);
}

async function loadMember(
  options: RuntimeContentSourceOptions,
  specifier: string,
  typeLoader?: () => Promise<unknown>,
): Promise<LoadedSourceMember> {
  const address = publicSpecifierAddress(specifier);
  const resolvedModuleURL = resolveLocalURL(
    options.resolve,
    specifier,
    "code entry",
  );
  const resolvedManifestURL = resolveLocalURL(
    options.resolve,
    `${address.packageName}/reference`,
    "native manifest entry",
  );
  const [moduleNamespace, manifestNamespace] = await Promise.all([
    import(resolvedModuleURL),
    import(resolvedManifestURL, { with: { type: "json" } }),
  ]);
  if (typeLoader !== undefined) {
    const typedNamespace = await typeLoader();
    if (typedNamespace !== moduleNamespace) {
      throw new Error(
        `Type loader callback for content ${specifier} did not return the same module as the resolved public code entry`,
      );
    }
  }
  const manifestValue = isRecord(manifestNamespace)
    ? manifestNamespace.default
    : undefined;
  const manifest = assertNativeManifest(manifestValue, specifier);
  if (manifest.name !== address.packageName) {
    throw new Error(
      `Native manifest package name mismatch for content ${specifier}: expected ${address.packageName}, got ${manifest.name}`,
    );
  }
  if (!Object.hasOwn(manifest.exports, address.exportPath)) {
    throw new Error(
      `Content ${specifier} is not publicly exported at ${address.exportPath} in the native manifest`,
    );
  }

  const loaded = primaryDefinition(moduleNamespace, specifier);
  if (loaded.kind === "reference") {
    if (
      "manifest" in loaded.definition &&
      !isDeepStrictEqual(loaded.definition.manifest, manifest)
    ) {
      throw new Error(
        `Reference package definition manifest does not match native manifest for content ${specifier}`,
      );
    }
  } else if (
    loaded.definition.owner !== undefined &&
    (loaded.definition.owner.packageName !== manifest.name ||
      loaded.definition.owner.exportPath !== address.exportPath)
  ) {
    throw new Error(
      `Preset ${specifier} owner entry does not match its resolved public content entry`,
    );
  }

  const identity: ContentIdentity = Object.freeze({
    namespace: options.namespace,
    packageName: manifest.name,
    exportPath: address.exportPath,
  });
  return Object.freeze({
    identity,
    kind: loaded.kind,
    alias: loaded.alias,
    definition: loaded.definition,
    source: Object.freeze({
      specifier,
      moduleURL: resolvedModuleURL,
      manifestURL: resolvedManifestURL,
    }),
  });
}

function primaryDefinition(
  moduleNamespace: unknown,
  specifier: string,
):
  | {
      readonly kind: "reference";
      readonly alias: string;
      readonly definition: ReferencePackageDefinition;
    }
  | {
      readonly kind: "preset";
      readonly alias: string;
      readonly definition: PresetDefinition;
    } {
  if (!isRecord(moduleNamespace)) {
    throw new Error(
      `Public code entry for content ${specifier} did not export an object`,
    );
  }
  const candidates: { readonly kind: ContentKind; readonly value: unknown }[] =
    [];
  if (Object.hasOwn(moduleNamespace, "preset")) {
    candidates.push({ kind: "preset", value: moduleNamespace.preset });
  }
  if (Object.hasOwn(moduleNamespace, "referencePackage")) {
    candidates.push({
      kind: "reference",
      value: moduleNamespace.referencePackage,
    });
  }
  if (candidates.length !== 1) {
    throw new Error(
      `Content ${specifier} must export exactly one primary preset or reference package definition`,
    );
  }
  const candidate = candidates[0]!;
  if (candidate.kind === "preset") {
    if (
      !isRecord(candidate.value) ||
      candidate.value.kind !== "preset" ||
      !isRecord(candidate.value.metadata)
    ) {
      throw new Error(
        `Exported definition for content ${specifier} is not a valid preset`,
      );
    }
    const definition = candidate.value as unknown as PresetDefinition;
    return {
      kind: "preset",
      alias: requireAlias(definition.metadata.alias, specifier),
      definition,
    };
  }

  const definition = candidate.value;
  if (!isReferencePackageDefinition(definition)) {
    throw new Error(
      `Exported definition for content ${specifier} is not a valid reference package definition`,
    );
  }
  return {
    kind: "reference",
    alias: requireAlias(definition.alias, specifier),
    definition,
  };
}

function publicSpecifierAddress(specifier: string): {
  readonly packageName: string;
  readonly exportPath: string;
} {
  if (
    specifier.trim() !== specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  ) {
    throw new Error(
      `Content member must use a public package specifier: ${specifier}`,
    );
  }
  const parts = specifier.split("/");
  const packageLength = specifier.startsWith("@") ? 2 : 1;
  if (
    parts.length < packageLength ||
    parts.slice(0, packageLength).some((part) => part.length === 0)
  ) {
    throw new Error(
      `Invalid public package specifier for content member: ${specifier}`,
    );
  }
  const packageName = parts.slice(0, packageLength).join("/");
  const exportSegments = parts.slice(packageLength);
  return {
    packageName,
    exportPath:
      exportSegments.length === 0 ? "." : `./${exportSegments.join("/")}`,
  };
}

function resolveLocalURL(
  resolve: (specifier: string) => string,
  specifier: string,
  label: string,
): string {
  let resolved: string;
  try {
    resolved = resolve(specifier);
  } catch (error) {
    throw new Error(
      `Failed to resolve ${label} ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new Error(`Resolved ${label} is not an absolute URL: ${specifier}`);
  }
  if (url.protocol !== "file:") {
    throw new Error(`Resolved ${label} must be a local file URL: ${specifier}`);
  }
  return url.href;
}

function assertNativeManifest(
  value: unknown,
  specifier: string,
): NativeManifest {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    !isRecord(value.exports)
  ) {
    throw new Error(
      `Public native manifest for content ${specifier} is missing name or exports`,
    );
  }
  return value as NativeManifest;
}

function isReferencePackageDefinition(
  value: unknown,
): value is ReferencePackageDefinition {
  if (
    !isRecord(value) ||
    typeof value.alias !== "string" ||
    (value.instance !== "shared" && value.instance !== "independent")
  ) {
    return false;
  }
  return (
    typeof value.prepare === "function" &&
    typeof value.parseCreationInput === "function" &&
    typeof value.createDefinition === "function" &&
    typeof value.evaluate === "function"
  );
}

function requireAlias(value: unknown, specifier: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Public definition for content ${specifier} is missing a valid alias`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
