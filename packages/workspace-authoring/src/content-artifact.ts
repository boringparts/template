import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PreparedReference,
  ResourceFileSnapshot,
} from "@boringparts/template-core/reference-package";
import {
  resolveTemplateSource,
  type TemplateSourceHandle,
} from "@boringparts/template-core/template-source";

export type NativeContentManifest = Readonly<Record<string, unknown>> & {
  readonly name: string;
  readonly version?: string;
  readonly exports?: Readonly<Record<string, unknown>>;
};

export type NativeContentArtifactFile = {
  /** Public relative path within the owning native package. */
  readonly path: string;
  /** File bytes read within the owning package boundary so collections do not need author filesystem access. */
  readonly data: Uint8Array;
  readonly mode: number;
};

export type NativeContentArtifactResource = {
  /** Resource path within the owning native package, distributed with the complete artifact. */
  readonly path: string;
  /** Target path within the generated template package, used to exclude nested owner package scopes. */
  readonly targetPath?: string;
  readonly source: TemplateSourceHandle;
  readonly mode: number;
};

export type NativeContentArtifactDependency = {
  readonly name: string;
  readonly specifier: string;
  readonly purposes: readonly ("target" | "template-execution")[];
};

export type NativeContentArtifactExport = {
  readonly path: string;
  readonly default: string;
  readonly types?: string;
};

export type PreparedNativeContentArtifact = {
  readonly coordinate: { readonly name: string; readonly version: string };
  readonly exportPath: string;
  readonly manifest: NativeContentManifest;
  readonly entry: {
    readonly default: string;
    readonly types?: string;
  };
  readonly templateExports: readonly NativeContentArtifactExport[];
  readonly compiled: readonly NativeContentArtifactFile[];
  readonly resources: readonly NativeContentArtifactFile[];
  readonly dependencies: readonly NativeContentArtifactDependency[];
};

export type PrepareNativeContentArtifactOptions = {
  readonly manifest: NativeContentManifest;
  readonly resourceRoot: URL;
  readonly exportPath: string;
  /** Explicit public export subpaths used by the reference package template definition when executing inside the author package. */
  readonly templateExports?: readonly string[];
  /** Explicit artifact version used only when the native package manifest has no version field. */
  readonly artifactVersion?: string;
  readonly resources?: readonly NativeContentArtifactResource[];
  readonly dependencyPurposes?: ReadonlyMap<
    string,
    readonly ("target" | "template-execution")[]
  >;
};

export type DefineNativeContentArtifactOptions =
  PrepareNativeContentArtifactOptions & {
    /** Package names from `package.json` `devDependencies` that are actually executed by the template entry point. */
    readonly executionDependencies?: readonly string[];
  };

export type NativeReferenceContentDefinition = Readonly<{
  readonly alias: string;
  readonly instance: "shared" | "independent";
}>;

export type DefineNativeReferenceContentArtifactOptions<Facts> = Omit<
  DefineNativeContentArtifactOptions,
  "resources"
> &
  Readonly<{
    readonly resources?: readonly NativeContentArtifactResource[];
    readonly prepareFacts?: (
      resources: readonly ResourceFileSnapshot[],
      options: Readonly<{ readonly excludedPackagePaths: readonly string[] }>,
    ) => Facts;
  }>;

type NativeReferenceContentArtifact<Definition extends object, Facts> = Omit<
  Definition,
  "prepare"
> &
  Readonly<{
    readonly prepare: (options?: {
      readonly excludedPackagePaths: readonly string[];
    }) => PreparedReference<Facts>;
    readonly prepareArtifact: () => PreparedNativeContentArtifact;
  }>;

function exportEntry(
  manifest: NativeContentManifest,
  exportPath: string,
): { readonly default: string; readonly types?: string } {
  const value = manifest.exports?.[exportPath];
  if (typeof value === "string") return { default: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `Owning package ${manifest.name} does not export content entry ${exportPath}`,
    );
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.default !== "string") {
    throw new Error(
      `Content entry ${exportPath} in owning package ${manifest.name} is missing the default condition`,
    );
  }
  if (entry.types !== undefined && typeof entry.types !== "string") {
    throw new Error(
      `Content entry ${exportPath} in owning package ${manifest.name} has an invalid types condition`,
    );
  }
  return {
    default: entry.default,
    ...(typeof entry.types === "string" ? { types: entry.types } : {}),
  };
}

function packagePath(value: string, label: string): string {
  if (
    !value.startsWith("./") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === "..")
  ) {
    throw new Error(
      `Owned content ${label} must be a package-relative path: ${value}`,
    );
  }
  return path.posix.normalize(value.slice(2));
}

function dependencyFacts(
  manifest: NativeContentManifest,
  dependencyPurposes: PrepareNativeContentArtifactOptions["dependencyPurposes"],
): readonly NativeContentArtifactDependency[] {
  const purposesByName = dependencyPurposes ?? new Map();
  const dependencies = new Map<string, string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = manifest[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    for (const [name, specifier] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof specifier !== "string") continue;
      dependencies.set(name, specifier);
    }
  }
  return Object.freeze(
    [...dependencies].map(([name, specifier]) =>
      Object.freeze({
        name,
        specifier,
        purposes: Object.freeze([
          ...(purposesByName.get(name) ?? ["template-execution"]),
        ]),
      }),
    ),
  );
}

/** Packages an owning package's compiled outputs, declared resources, and manifest dependencies into a snapshot artifact consumable by content collections. Throws if the version is missing, declared exports are absent or uncompiled, or compiled outputs contain symbolic links. */
export function prepareNativeContentArtifact(
  options: PrepareNativeContentArtifactOptions,
): PreparedNativeContentArtifact {
  const coordinateVersion =
    typeof options.manifest.version === "string" &&
    options.manifest.version.trim().length > 0
      ? options.manifest.version
      : options.artifactVersion;
  if (
    coordinateVersion === undefined ||
    coordinateVersion.trim().length === 0
  ) {
    throw new Error(
      `Owning package ${options.manifest.name} is missing an artifact version; declare artifactVersion explicitly when the manifest has no version`,
    );
  }
  const resourceRoot = path.resolve(fileURLToPath(options.resourceRoot));
  const compiledFiles = new Map<string, NativeContentArtifactFile>();
  const collectExport = (
    exportPath: string,
    entry: ReturnType<typeof exportEntry>,
  ): void => {
    const entryPath = packagePath(entry.default, "default entry");
    const compiledRoot = path.resolve(
      resourceRoot,
      path.posix.dirname(entryPath),
    );
    const rootRelative = path.relative(resourceRoot, compiledRoot);
    if (
      rootRelative === ".." ||
      rootRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rootRelative)
    ) {
      throw new Error(
        `Compiled content entry in owning package ${options.manifest.name} escapes the package root`,
      );
    }

    const visit = (directory: string): void => {
      for (const child of readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name),
      )) {
        const absolutePath = path.join(directory, child.name);
        if (child.isSymbolicLink()) {
          throw new Error(
            `Compiled output in owning package ${options.manifest.name} contains a symbolic link: ${path.relative(resourceRoot, absolutePath)}`,
          );
        }
        if (child.isDirectory()) {
          visit(absolutePath);
          continue;
        }
        const relativePath = path
          .relative(resourceRoot, absolutePath)
          .split(path.sep)
          .join("/");
        compiledFiles.set(relativePath, {
          path: relativePath,
          data: readFileSync(absolutePath),
          mode: statSync(absolutePath).mode & 0o777,
        });
      }
    };
    try {
      visit(compiledRoot);
    } catch (error) {
      throw new Error(
        `Compiled entry in owning package ${options.manifest.name} is not built yet: ${entry.default}`,
        { cause: error },
      );
    }
    const typesPath =
      entry.types === undefined
        ? undefined
        : packagePath(entry.types, "types entry");
    if (
      !compiledFiles.has(entryPath) ||
      (typesPath !== undefined && !compiledFiles.has(typesPath))
    ) {
      throw new Error(
        `Compiled artifact in owning package ${options.manifest.name} does not contain public entry ${exportPath}`,
      );
    }
  };
  const entry = exportEntry(options.manifest, options.exportPath);
  collectExport(options.exportPath, entry);
  const templateExports = (options.templateExports ?? [])
    .filter(
      (exportPath) =>
        exportPath !== options.exportPath &&
        exportPath !== "./reference" &&
        exportPath !== "./template",
    )
    .map((exportPath) => {
      const exportEntryValue = exportEntry(options.manifest, exportPath);
      collectExport(exportPath, exportEntryValue);
      return Object.freeze({ path: exportPath, ...exportEntryValue });
    });
  const compiled = [...compiledFiles.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  const resources = new Map<string, NativeContentArtifactFile>();
  for (const resource of options.resources ?? []) {
    resources.set(resource.path, {
      path: resource.path,
      data: readFileSync(resolveTemplateSource(resource.source, ".")),
      mode: resource.mode,
    });
  }
  return Object.freeze({
    coordinate: Object.freeze({
      name: options.manifest.name,
      version: coordinateVersion,
    }),
    exportPath: options.exportPath,
    manifest: options.manifest,
    entry: Object.freeze(entry),
    templateExports: Object.freeze(templateExports),
    compiled: Object.freeze(compiled),
    resources: Object.freeze([...resources.values()]),
    dependencies: dependencyFacts(options.manifest, options.dependencyPurposes),
  });
}

/** Attaches a `prepareArtifact` handle to a content definition (such as a preset) without changing its core definition contract, validating declared dependency purposes against the manifest. */
export function defineNativeContentArtifact<Definition extends object>(
  definition: Definition,
  options: DefineNativeContentArtifactOptions,
): Definition & {
  readonly prepareArtifact: () => PreparedNativeContentArtifact;
} {
  const dependencyPurposes = new Map<
    string,
    readonly ("target" | "template-execution")[]
  >();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const value = options.manifest[field];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    for (const name of Object.keys(value)) {
      dependencyPurposes.set(
        name,
        field === "dependencies" ? ["template-execution"] : [],
      );
    }
  }
  for (const [name, purposes] of options.dependencyPurposes ?? []) {
    if (!dependencyPurposes.has(name)) {
      throw new Error(
        `Declared dependency purpose is not listed in the package manifest: ${options.manifest.name}/${name}`,
      );
    }
    dependencyPurposes.set(name, purposes);
  }
  for (const name of options.executionDependencies ?? []) {
    const declared = dependencyPurposes.get(name);
    if (declared === undefined) {
      throw new Error(
        `Template execution dependency is not declared in the owning manifest: ${options.manifest.name}/${name}`,
      );
    }
    if (
      options.dependencyPurposes?.has(name) &&
      !declared.includes("template-execution")
    ) {
      throw new Error(
        `Template execution dependency conflicts with explicit dependency purposes: ${options.manifest.name}/${name}`,
      );
    }
    if (!options.dependencyPurposes?.has(name)) {
      dependencyPurposes.set(name, ["template-execution"]);
    }
  }
  const { executionDependencies: _executionDependencies, ...artifactOptions } =
    options;
  return Object.freeze({
    ...definition,
    prepareArtifact: () =>
      prepareNativeContentArtifact({
        ...artifactOptions,
        dependencyPurposes,
      }),
  });
}

/** Wraps a reference package definition so a single resource declaration drives both runtime `prepare()` snapshots (excluding nested package paths) and `prepareArtifact()` packaging. */
export function defineNativeReferenceContentArtifact<
  Definition extends NativeReferenceContentDefinition,
  Facts,
>(
  definition: Definition,
  options: DefineNativeReferenceContentArtifactOptions<Facts> & {
    readonly prepareFacts: NonNullable<
      DefineNativeReferenceContentArtifactOptions<Facts>["prepareFacts"]
    >;
  },
): NativeReferenceContentArtifact<Definition, Facts>;
export function defineNativeReferenceContentArtifact<
  Definition extends NativeReferenceContentDefinition,
>(
  definition: Definition,
  options: DefineNativeReferenceContentArtifactOptions<undefined> & {
    readonly prepareFacts?: undefined;
  },
): NativeReferenceContentArtifact<Definition, undefined>;
export function defineNativeReferenceContentArtifact(
  definition: NativeReferenceContentDefinition,
  options: DefineNativeReferenceContentArtifactOptions<unknown>,
): object {
  const resourceSpecifications = options.resources ?? [];
  const nativeArtifact = defineNativeContentArtifact(definition, options);
  return Object.freeze({
    ...nativeArtifact,
    prepare(prepareOptions?: {
      readonly excludedPackagePaths: readonly string[];
    }) {
      const excludedPackagePaths = prepareOptions?.excludedPackagePaths ?? [];
      const resources = resourceSpecifications
        .filter(
          ({ targetPath }) =>
            targetPath === undefined ||
            !excludedPackagePaths.some(
              (packagePath) =>
                targetPath === packagePath ||
                targetPath.startsWith(`${packagePath}/`),
            ),
        )
        .map(({ path: resourcePath, source, mode }) => ({
          path: resourcePath,
          content: readFileSync(resolveTemplateSource(source, ".")),
          mode: mode & 0o111,
        }));
      const snapshot = Object.freeze(resources);
      return Object.freeze({
        resources: snapshot,
        facts: options.prepareFacts?.(snapshot, {
          excludedPackagePaths,
        }),
      });
    },
  });
}
