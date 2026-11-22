import type {
  PackageDefinitionId,
  PersistedPackageDefinition,
  ProjectBlueprint,
} from "./project-blueprint.ts";
import type {
  ProjectProjection,
  ProjectProjectionEntry,
  ProjectProjectionReconciliation,
} from "./project-projection.ts";

export type PackageContributionFile = Omit<
  ProjectProjectionEntry,
  "path" | "kind"
> & {
  /** Canonical path relative to the owning package directory. */
  readonly path: string;
};

/** Complete files, reconciliation policies, and domain facts produced for one generated package instance. */
export type PackageContribution<Facts = unknown> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly files: readonly PackageContributionFile[];
  /** Reconciliation entries with paths relative to the owning package directory. */
  readonly reconciliation?: readonly ProjectProjectionReconciliation[];
  readonly facts: Facts;
};

export type CompositionFile = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly file: PackageContributionFile;
};

export type CompositionReconciliation = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly reconciliation: ProjectProjectionReconciliation;
};

function canonicalRelativeFilePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    value !== "." &&
    value !== ".." &&
    !value.startsWith("../") &&
    value.split("/").every((part) => part.length > 0) &&
    value.split("/").every((part) => part !== "." && part !== "..")
  );
}

function packageDirectoryContains(
  directory: string,
  filePath: string,
): boolean {
  return directory === "." || filePath.startsWith(`${directory}/`);
}

function directoryDepth(directory: string): number {
  return directory === "." ? 0 : directory.split("/").length;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fileOwner(
  packages: readonly PersistedPackageDefinition[],
  targetPath: string,
): PersistedPackageDefinition | undefined {
  return packages
    .filter((definition) =>
      packageDirectoryContains(definition.path, targetPath),
    )
    .toSorted(
      (left, right) => directoryDepth(right.path) - directoryDepth(left.path),
    )[0];
}

function targetPathFor(
  definition: PersistedPackageDefinition,
  relativePath: string,
): string {
  return definition.path === "."
    ? relativePath
    : `${definition.path}/${relativePath}`;
}

function requirePackage(
  packages: ReadonlyMap<PackageDefinitionId, PersistedPackageDefinition>,
  id: PackageDefinitionId,
): PersistedPackageDefinition {
  const definition = packages.get(id);
  if (definition === undefined) {
    throw new Error(
      `Package contribution references unknown package instance: ${id}`,
    );
  }
  return definition;
}

function assertOwnedPath(options: {
  readonly blueprint: ProjectBlueprint;
  readonly definition: PersistedPackageDefinition;
  readonly relativePath: string;
  readonly reservedPaths: ReadonlySet<string>;
}): string {
  const targetPath = targetPathFor(options.definition, options.relativePath);
  if (!canonicalRelativeFilePath(options.relativePath)) {
    throw new Error(
      `Package contribution path must be a canonical relative path; ${options.definition.name} attempted to write ${options.relativePath}`,
    );
  }
  const conflictsWithReservedPath = [...options.reservedPaths].some(
    (reservedPath) =>
      targetPath === reservedPath ||
      targetPath.startsWith(`${reservedPath}/`) ||
      reservedPath.startsWith(`${targetPath}/`),
  );
  if (conflictsWithReservedPath) {
    throw new Error(
      `Package contribution path conflicts with generator metadata path; ${options.definition.name} attempted to write ${targetPath}`,
    );
  }
  const occupiedPackageScope = options.blueprint.packages.find(
    (packageDefinition) =>
      packageDefinition.path !== "." &&
      (packageDefinition.path === targetPath ||
        packageDefinition.path.startsWith(`${targetPath}/`)),
  );
  if (occupiedPackageScope !== undefined) {
    throw new Error(
      `Project file conflicts with registered package directory: ${targetPath} would overlap ${occupiedPackageScope.path}`,
    );
  }
  const owner = fileOwner(options.blueprint.packages, targetPath);
  if (owner === undefined) {
    throw new Error(`Project output path has no owning package: ${targetPath}`);
  }
  if (owner.packageDefinitionId !== options.definition.packageDefinitionId) {
    throw new Error(
      `Package contribution escapes its owning directory boundary: ${options.definition.path} attempted to write ${targetPath}, which belongs to ${owner.path}`,
    );
  }
  return targetPath;
}

/** Aggregates package-relative contributions into a ProjectProjection after verifying path ownership across the blueprint topology. */
export function projectPackageContributions(options: {
  readonly blueprint: ProjectBlueprint;
  readonly contributions: readonly PackageContribution[];
  readonly compositionFiles?: readonly CompositionFile[];
  readonly compositionReconciliation?: readonly CompositionReconciliation[];
}): ProjectProjection {
  const definitions = new Map(
    options.blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition,
    ]),
  );
  const entries: ProjectProjectionEntry[] = [];
  const reconciliation: ProjectProjectionReconciliation[] = [];
  const outputPaths = new Set<string>();
  const policyPaths = new Set<string>();
  const reservedPaths = new Set([
    ".template/blueprint.json",
    ".template/generation.json",
  ]);

  const addFile = (
    packageDefinitionId: PackageDefinitionId,
    file: PackageContributionFile,
  ): void => {
    const definition = requirePackage(definitions, packageDefinitionId);
    const path = assertOwnedPath({
      blueprint: options.blueprint,
      definition,
      relativePath: file.path,
      reservedPaths,
    });
    if (outputPaths.has(path)) {
      throw new Error(
        `Project projection contains duplicate output path: ${path}`,
      );
    }
    if (!(file.content instanceof Uint8Array)) {
      throw new Error(
        `Project projection file content must be a Uint8Array: ${path}`,
      );
    }
    if (
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      (file.mode & ~0o111) !== 0
    ) {
      throw new Error(`Project projection file mode is invalid: ${path}`);
    }
    outputPaths.add(path);
    entries.push({
      ...file,
      path,
      kind: "file",
      content: file.content.slice(),
      mode: file.mode,
    });
  };

  for (const contribution of options.contributions) {
    for (const file of contribution.files) {
      addFile(contribution.packageDefinitionId, file);
    }
    const definition = requirePackage(
      definitions,
      contribution.packageDefinitionId,
    );
    for (const policy of contribution.reconciliation ?? []) {
      const path = assertOwnedPath({
        blueprint: options.blueprint,
        definition,
        relativePath: policy.path,
        reservedPaths,
      });
      if (policyPaths.has(path)) {
        throw new Error(
          `Project projection contains duplicate reconciliation path: ${path}`,
        );
      }
      policyPaths.add(path);
      reconciliation.push({ ...policy, path });
    }
  }

  for (const item of options.compositionFiles ?? []) {
    addFile(item.packageDefinitionId, item.file);
  }
  for (const item of options.compositionReconciliation ?? []) {
    const definition = requirePackage(definitions, item.packageDefinitionId);
    const path = assertOwnedPath({
      blueprint: options.blueprint,
      definition,
      relativePath: item.reconciliation.path,
      reservedPaths,
    });
    if (policyPaths.has(path)) {
      throw new Error(
        `Project projection contains duplicate reconciliation path: ${path}`,
      );
    }
    policyPaths.add(path);
    reconciliation.push({ ...item.reconciliation, path });
  }

  for (const entry of entries) {
    if (!policyPaths.has(entry.path)) {
      throw new Error(
        `Project projection file is missing a reconciliation policy: ${entry.path}`,
      );
    }
  }
  for (const policyPath of policyPaths) {
    if (!outputPaths.has(policyPath)) {
      throw new Error(
        `Project projection reconciliation policy references unknown path: ${policyPath}`,
      );
    }
  }
  const sortedPaths = entries.map((entry) => entry.path).toSorted(comparePaths);
  for (const current of sortedPaths) {
    const segments = current.split("/");
    let parent = "";
    for (const segment of segments.slice(0, -1)) {
      parent = parent.length === 0 ? segment : `${parent}/${segment}`;
      if (outputPaths.has(parent)) {
        throw new Error(
          `Project projection file and directory path conflict: ${parent} and ${current}`,
        );
      }
    }
  }

  return {
    entries: entries.toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
    reconciliation: reconciliation.toSorted((left, right) =>
      comparePaths(left.path, right.path),
    ),
  };
}
