import { isBuiltin } from "node:module";
import path from "node:path";

import {
  normalizeRelativePackagePath,
  type SourceContext,
} from "../sources/index.ts";
import { mergeWorkspaceEnvironment } from "./environment.ts";
import {
  collectManifestDependencyNames,
  isRecord,
  readManifestJson,
} from "./transform.ts";
import type {
  InvalidRequestIssue,
  PackageInstance,
  PackageRole,
  PlanProjectRequest,
  PlanProjectResult,
  ProjectLink,
  ReferencePackage,
  ResourceFileMapping,
  WorkspaceRoot,
} from "./types.ts";

const maxNpmPackageNameLength = 214;
const safeSegmentPattern = /^[a-z0-9][a-z0-9-]*$/u;
const dotSegmentPattern = /^\.[a-z0-9][a-z0-9._-]*$/u;
const restrictedPackageIdentifierPattern = /^[a-z0-9][a-z0-9._-]*$/u;
const reservedPackageNames = new Set(["node_modules", "favicon.ico"]);

function readManifestBinKeys(
  source: SourceContext,
  sourceDir: string,
): readonly string[] {
  const manifest = readManifestJson(source, sourceDir);
  if (manifest === undefined || !isRecord(manifest.bin)) {
    return [];
  }
  return Object.keys(manifest.bin);
}

function readManifestDependencyNames(
  source: SourceContext,
  sourceDir: string,
): ReadonlySet<string> {
  const manifest = readManifestJson(source, sourceDir);
  return manifest === undefined
    ? new Set<string>()
    : collectManifestDependencyNames(manifest);
}

/**
 * Resolves and validates a source package's manifest `"name"` against an optional
 * declared `packageName`. Records structured issues when `sourceDir` escapes bounds,
 * `package.json` lacks a valid `"name"`, or the declared name disagrees with the manifest.
 */
function resolveAndValidateSourcePackageName(options: {
  readonly source: SourceContext;
  readonly sourceDir: string;
  readonly declaredPackageName: string | undefined;
  readonly ownerLabel: string;
  readonly issues: InvalidRequestIssue[];
}): string {
  const normalizedDir = normalizeRelativePackagePath(options.sourceDir);
  if (normalizedDir === undefined) {
    options.issues.push({
      code: "DIRECTORY_OWNERSHIP_VIOLATION",
      message: `${options.ownerLabel} source directory "${options.sourceDir}" escapes source context.`,
    });
    return options.declaredPackageName ?? options.sourceDir;
  }

  const manifest = readManifestJson(options.source, normalizedDir);
  const manifestName =
    manifest !== undefined &&
    typeof manifest.name === "string" &&
    manifest.name.trim().length > 0
      ? manifest.name
      : undefined;

  if (manifestName === undefined) {
    options.issues.push({
      code: "CONFLICTING_PACKAGE_IDENTITY",
      message: `${options.ownerLabel} at "${normalizedDir}" is missing a valid "name" in package.json.`,
    });
    return options.declaredPackageName ?? normalizedDir;
  }

  if (
    options.declaredPackageName !== undefined &&
    options.declaredPackageName !== manifestName
  ) {
    options.issues.push({
      code: "CONFLICTING_PACKAGE_IDENTITY",
      message: `${options.ownerLabel} at "${normalizedDir}" declares packageName "${options.declaredPackageName}", which disagrees with manifest name "${manifestName}".`,
    });
  }

  return manifestName;
}

/**
 * Parses top-level ignored directory names from a gitignore document
 * so workspace root ignores remain the single authority for reserved top-level collections.
 */
function parseGitignoreTopLevelDirs(content: string): ReadonlySet<string> {
  const dirs = new Set<string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (
      trimmed.length === 0 ||
      trimmed.startsWith("#") ||
      trimmed.startsWith("!")
    ) {
      continue;
    }
    const withoutLeadingSlash = trimmed.startsWith("/")
      ? trimmed.slice(1)
      : trimmed;
    const withoutTrailingSlash = withoutLeadingSlash.endsWith("/")
      ? withoutLeadingSlash.slice(0, -1)
      : withoutLeadingSlash;
    if (
      withoutTrailingSlash.length === 0 ||
      withoutTrailingSlash.includes("/") ||
      withoutTrailingSlash.includes("*") ||
      withoutTrailingSlash.includes("?") ||
      withoutTrailingSlash.includes("[") ||
      withoutTrailingSlash.includes("]")
    ) {
      continue;
    }
    dirs.add(withoutTrailingSlash);
  }
  return dirs;
}

function resolveReservedTopLevelDirs(
  source: SourceContext,
  workspaceRoot: WorkspaceRoot,
): ReadonlySet<string> {
  const normalizedRootDir = normalizeRelativePackagePath(
    workspaceRoot.sourceDir,
  );
  if (normalizedRootDir === undefined) {
    return new Set();
  }
  const gitignoreMapping = workspaceRoot.resources?.find(
    (resource) =>
      normalizeRelativePackagePath(resource.targetPath) === ".gitignore",
  );
  if (gitignoreMapping === undefined) {
    return new Set();
  }
  const normalizedSource = normalizeRelativePackagePath(
    gitignoreMapping.sourcePath,
  );
  if (normalizedSource === undefined) {
    return new Set();
  }
  const rawGitignore = source.tryReadPackageText(
    normalizedRootDir,
    normalizedSource,
  );
  if (rawGitignore === undefined) {
    return new Set();
  }
  return parseGitignoreTopLevelDirs(rawGitignore);
}

function isValidRestrictedIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= maxNpmPackageNameLength &&
    value === value.trim() &&
    value === value.toLowerCase() &&
    restrictedPackageIdentifierPattern.test(value) &&
    encodeURIComponent(value) === value
  );
}

/** Validates an unscoped npm package leaf name under the default workspace policy. */
export function isValidPackageLeafName(value: string): boolean {
  return (
    isValidRestrictedIdentifier(value) &&
    !isBuiltin(value) &&
    !reservedPackageNames.has(value)
  );
}

/** Validates a normalized npm package scope (without leading `@`). */
export function isValidPackageScope(value: string): boolean {
  return isValidRestrictedIdentifier(value);
}

/**
 * Validates a two-segment relative package path and rejects dot-prefixed hidden directories
 * or top-level directories ignored by the workspace root gitignore as `RESERVED_PACKAGE_PATH`.
 */
export function validatePackagePath(
  value: string,
  reservedTopLevelDirs: ReadonlySet<string> = new Set(),
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: "INVALID_PACKAGE_PATH" | "RESERVED_PACKAGE_PATH";
      readonly message: string;
    } {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/")
  ) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe path segments.`,
    };
  }
  const segments = value.split("/");
  if (segments.length !== 2) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe path segments.`,
    };
  }
  const [firstSegment, secondSegment] = segments as [string, string];
  if (
    firstSegment.length === 0 ||
    secondSegment.length === 0 ||
    firstSegment === "." ||
    firstSegment === ".." ||
    !safeSegmentPattern.test(secondSegment)
  ) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe lowercase segments.`,
    };
  }
  if (
    (firstSegment.startsWith(".") && dotSegmentPattern.test(firstSegment)) ||
    reservedTopLevelDirs.has(firstSegment)
  ) {
    return {
      ok: false,
      code: "RESERVED_PACKAGE_PATH",
      message: `Package path "${value}" uses reserved workspace directory "${firstSegment}".`,
    };
  }
  if (!safeSegmentPattern.test(firstSegment)) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe lowercase segments.`,
    };
  }
  return { ok: true };
}

/**
 * Enforces the 6-role explicit link compatibility matrix:
 * - `native-package` cannot consume or provide links
 * - `shared-library` may be linked by any JS/TS package except `native-package`
 * - `node-library` may only be linked by `cli-tool`, `runtime-service`, or `node-library`
 */
export function canLinkRoles(
  consumerRole: PackageRole,
  providerRole: PackageRole,
): boolean {
  if (consumerRole === "native-package") {
    return false;
  }
  if (providerRole === "shared-library") {
    return true;
  }
  if (providerRole === "node-library") {
    return (
      consumerRole === "cli-tool" ||
      consumerRole === "runtime-service" ||
      consumerRole === "node-library"
    );
  }
  return false;
}

function deduplicateIssues(
  issues: readonly InvalidRequestIssue[],
): readonly InvalidRequestIssue[] {
  const seen = new Set<string>();
  const unique: InvalidRequestIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique;
}

function validateDeclaredResources(options: {
  readonly ownerLabel: string;
  readonly resources: readonly ResourceFileMapping[];
  readonly seenTargets: Set<string>;
  readonly forbiddenSubpackagePaths?: readonly string[];
  readonly issues: InvalidRequestIssue[];
}): void {
  for (const resource of options.resources) {
    const normalizedSource = normalizeRelativePackagePath(resource.sourcePath);
    if (normalizedSource === undefined) {
      options.issues.push({
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: `${options.ownerLabel} resource source path "${resource.sourcePath}" escapes package directory.`,
      });
    }
    const normalizedTarget = normalizeRelativePackagePath(resource.targetPath);
    if (normalizedTarget === undefined) {
      options.issues.push({
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: `${options.ownerLabel} resource target path "${resource.targetPath}" escapes package directory.`,
      });
      continue;
    }
    if (options.seenTargets.has(normalizedTarget)) {
      options.issues.push({
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: `${options.ownerLabel} declares duplicate resource target path "${normalizedTarget}".`,
      });
    } else {
      options.seenTargets.add(normalizedTarget);
    }
    for (const subPath of options.forbiddenSubpackagePaths ?? []) {
      if (
        normalizedTarget === subPath ||
        normalizedTarget.startsWith(`${subPath}/`)
      ) {
        options.issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Workspace root resource "${normalizedTarget}" intrudes into subpackage "${subPath}".`,
        });
      }
    }
  }
}

function bindDeclaredSingletons(
  source: SourceContext,
  sourceDir: string,
  singletonBindings: ReadonlyMap<string, string>,
  dependencyBindings: Map<string, string>,
): void {
  if (singletonBindings.size === 0) {
    return;
  }
  const declaredDeps = readManifestDependencyNames(source, sourceDir);
  for (const [refPkgName, targetPkgName] of singletonBindings) {
    if (declaredDeps.has(refPkgName)) {
      dependencyBindings.set(refPkgName, targetPkgName);
    }
  }
}

type MutablePlannedNode = {
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly singleton: boolean;
  readonly referencePackage: ReferencePackage;
  readonly dependencyBindings: Map<string, string>;
  readonly linkedProviders: string[];
};

/**
 * Validates initialization inputs without writing to disk and produces a deterministic `ProjectBlueprint`.
 */
export function planProject(request: PlanProjectRequest): PlanProjectResult {
  const issues: InvalidRequestIssue[] = [];
  const targetDir = path.resolve(request.cwd, request.dir);
  const repositoryName = path.basename(targetDir);
  const reservedTopLevelDirs = resolveReservedTopLevelDirs(
    request.source,
    request.workspaceRoot,
  );

  resolveAndValidateSourcePackageName({
    source: request.source,
    sourceDir: request.workspaceRoot.sourceDir,
    declaredPackageName: request.workspaceRoot.packageName,
    ownerLabel: "Workspace root",
    issues,
  });

  let resolvedScope = "repository";
  if (request.scope !== undefined) {
    const trimmed = request.scope.trim();
    const normalized = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
    if (trimmed !== request.scope || !isValidPackageScope(normalized)) {
      issues.push({
        code: "INVALID_PACKAGE_SCOPE",
        message: `Scope "${request.scope}" is not a valid npm package scope.`,
      });
    } else {
      resolvedScope = normalized;
    }
  } else if (!isValidPackageScope(repositoryName)) {
    issues.push({
      code: "INVALID_REPOSITORY_SCOPE",
      message: `Target directory name "${repositoryName}" cannot be used as a default npm scope; specify an explicit scope.`,
    });
  } else {
    resolvedScope = repositoryName;
  }

  const presetsByAlias = new Map(
    request.presets.map((preset) => [preset.alias, preset]),
  );

  if (request.presetSpecs.length === 0) {
    issues.push({
      code: "INVALID_PRESET_SPEC",
      message: "At least one preset specification is required.",
    });
  }

  // Instantiate singleton subpackages and requested preset subpackages into one homogeneous list.
  const plannedNodes: MutablePlannedNode[] = [];
  const singletonBindings = new Map<string, string>();

  for (const singleton of request.singletonPackages ?? []) {
    const refPackageName = resolveAndValidateSourcePackageName({
      source: request.source,
      sourceDir: singleton.referencePackage.sourceDir,
      declaredPackageName: singleton.referencePackage.packageName,
      ownerLabel: `Singleton "${singleton.nodeId}"`,
      issues,
    });
    const packageName = `@${resolvedScope}/${singleton.defaultName}`;
    if (packageName.length > maxNpmPackageNameLength) {
      issues.push({
        code:
          request.scope !== undefined
            ? "INVALID_PACKAGE_SCOPE"
            : "INVALID_REPOSITORY_SCOPE",
        message: `Scoped package name "${packageName}" exceeds ${String(maxNpmPackageNameLength)} characters.`,
      });
    }
    singletonBindings.set(refPackageName, packageName);
    const dependencyBindings = new Map<string, string>();
    bindDeclaredSingletons(
      request.source,
      singleton.referencePackage.sourceDir,
      singletonBindings,
      dependencyBindings,
    );
    dependencyBindings.set(refPackageName, packageName);

    plannedNodes.push({
      presetAlias: "workspace-singleton",
      nodeId: singleton.nodeId,
      leafName: singleton.defaultName,
      packageName,
      path: singleton.defaultPath,
      singleton: true,
      referencePackage: singleton.referencePackage,
      dependencyBindings,
      linkedProviders: [],
    });
  }

  for (const rawSpec of request.presetSpecs) {
    const parts = rawSpec.split(":");
    if (
      rawSpec.length === 0 ||
      parts.length > 3 ||
      parts.some((part) => part.length === 0)
    ) {
      issues.push({
        code: "INVALID_PRESET_SPEC",
        message: `Invalid preset specification "${rawSpec}"; expected <preset>[:<name>[:<path>]].`,
      });
      continue;
    }

    const alias = parts[0]!;
    const preset = presetsByAlias.get(alias);
    if (preset === undefined) {
      issues.push({
        code: "PRESET_UNKNOWN",
        message: `Unknown preset "${alias}".`,
      });
      continue;
    }

    if (preset.topology === "fixed") {
      if (parts.length > 1) {
        issues.push({
          code: "FIXED_TOPOLOGY_OVERRIDE",
          message: `Preset "${alias}" uses a fixed topology and does not accept custom package names or paths.`,
        });
        continue;
      }

      const nodePackageById = new Map<string, string>();
      for (const node of preset.nodes) {
        const nodePackageName = `@${resolvedScope}/${node.defaultName}`;
        if (nodePackageName.length > maxNpmPackageNameLength) {
          issues.push({
            code:
              request.scope !== undefined
                ? "INVALID_PACKAGE_SCOPE"
                : "INVALID_REPOSITORY_SCOPE",
            message: `Scoped package name "${nodePackageName}" exceeds ${String(maxNpmPackageNameLength)} characters.`,
          });
        }
        nodePackageById.set(node.nodeId, nodePackageName);
      }

      for (const node of preset.nodes) {
        const refPackageName = resolveAndValidateSourcePackageName({
          source: request.source,
          sourceDir: node.referencePackage.sourceDir,
          declaredPackageName: node.referencePackage.packageName,
          ownerLabel: `Preset "${preset.alias}" node "${node.nodeId}"`,
          issues,
        });
        const dependencyBindings = new Map<string, string>();
        bindDeclaredSingletons(
          request.source,
          node.referencePackage.sourceDir,
          singletonBindings,
          dependencyBindings,
        );
        dependencyBindings.set(
          refPackageName,
          nodePackageById.get(node.nodeId)!,
        );
        for (const [refPkgName, targetNodeId] of Object.entries(
          node.dependencyBindings ?? {},
        )) {
          const targetPkgName = nodePackageById.get(targetNodeId);
          if (targetPkgName !== undefined) {
            dependencyBindings.set(refPkgName, targetPkgName);
          }
        }

        plannedNodes.push({
          presetAlias: preset.alias,
          nodeId: node.nodeId,
          leafName: node.defaultName,
          packageName: nodePackageById.get(node.nodeId)!,
          path: node.defaultPath,
          singleton: false,
          referencePackage: node.referencePackage,
          dependencyBindings,
          linkedProviders: [],
        });
      }
      continue;
    }

    // configurable-primary-package
    const primary = preset.nodes[0];
    if (primary === undefined) {
      continue;
    }

    const customName = parts[1];
    const customPath = parts[2];
    const leafName = customName ?? primary.defaultName;
    if (customName !== undefined && !isValidPackageLeafName(customName)) {
      issues.push({
        code: "INVALID_PACKAGE_NAME",
        message: `Package leaf name "${customName}" is not a valid unscoped npm package name.`,
      });
    }

    const slashIndex = primary.defaultPath.indexOf("/");
    const defaultParentDir =
      slashIndex === -1 ? "" : primary.defaultPath.slice(0, slashIndex);
    const packagePath =
      customPath ??
      (defaultParentDir.length > 0
        ? `${defaultParentDir}/${leafName}`
        : leafName);

    const packageName = `@${resolvedScope}/${leafName}`;
    if (packageName.length > maxNpmPackageNameLength) {
      issues.push({
        code:
          customName !== undefined
            ? "INVALID_PACKAGE_NAME"
            : request.scope !== undefined
              ? "INVALID_PACKAGE_SCOPE"
              : "INVALID_REPOSITORY_SCOPE",
        message: `Scoped package name "${packageName}" exceeds ${String(maxNpmPackageNameLength)} characters.`,
      });
    }

    const refPackageName = resolveAndValidateSourcePackageName({
      source: request.source,
      sourceDir: primary.referencePackage.sourceDir,
      declaredPackageName: primary.referencePackage.packageName,
      ownerLabel: `Preset "${preset.alias}" node "${primary.nodeId}"`,
      issues,
    });

    const dependencyBindings = new Map<string, string>();
    bindDeclaredSingletons(
      request.source,
      primary.referencePackage.sourceDir,
      singletonBindings,
      dependencyBindings,
    );
    dependencyBindings.set(refPackageName, packageName);

    plannedNodes.push({
      presetAlias: preset.alias,
      nodeId: primary.nodeId,
      leafName,
      packageName,
      path: packagePath,
      singleton: false,
      referencePackage: primary.referencePackage,
      dependencyBindings,
      linkedProviders: [],
    });
  }

  // Uniformly detect name, path, and CLI bin collisions across all PackageInstances (singletons + business instances).
  const seenNames = new Map<string, MutablePlannedNode>();
  const seenPaths = new Map<string, MutablePlannedNode>();
  const seenBins = new Map<string, MutablePlannedNode>();

  for (const node of plannedNodes) {
    const pathCheck = validatePackagePath(node.path, reservedTopLevelDirs);
    if (!pathCheck.ok) {
      issues.push({ code: pathCheck.code, message: pathCheck.message });
    }

    if (reservedPackageNames.has(node.leafName)) {
      issues.push({
        code: "CONFLICTING_PACKAGE_IDENTITY",
        message: `Package "${node.packageName}" (${node.path}) uses a reserved package name.`,
      });
    }

    const existingByName = seenNames.get(node.packageName);
    if (existingByName !== undefined) {
      issues.push({
        code: "CONFLICTING_PACKAGE_IDENTITY",
        message: `Duplicate package name "${node.packageName}" at "${existingByName.path}" and "${node.path}".`,
      });
    } else {
      seenNames.set(node.packageName, node);
    }

    const existingByPath = seenPaths.get(node.path);
    if (existingByPath !== undefined) {
      issues.push({
        code: "CONFLICTING_PACKAGE_IDENTITY",
        message: `Duplicate package path "${node.path}" for "${existingByPath.packageName}" and "${node.packageName}".`,
      });
    } else {
      seenPaths.set(node.path, node);
    }

    // Introspect manifest `bin` entries: single-entry `bin` maps to `node.leafName`.
    const binKeys = readManifestBinKeys(
      request.source,
      node.referencePackage.sourceDir,
    );
    const instantiatedBins = binKeys.length === 1 ? [node.leafName] : binKeys;
    for (const binName of instantiatedBins) {
      const existingByBin = seenBins.get(binName);
      if (existingByBin !== undefined) {
        issues.push({
          code: "CONFLICTING_PACKAGE_IDENTITY",
          message: `Duplicate CLI command name "${binName}" across "${existingByBin.path}" and "${node.path}".`,
        });
      } else {
        seenBins.set(binName, node);
      }
    }
  }

  // Validate explicit `<consumer-path>:<provider-path>` link requests.
  const links: ProjectLink[] = [];
  const seenLinkKeys = new Set<string>();
  for (const rawLink of request.linkSpecs ?? []) {
    const parts = rawLink.split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      issues.push({
        code: "INVALID_LINK_SPEC",
        message: `Invalid link specification "${rawLink}"; expected <consumer-path>:<provider-path>.`,
      });
      continue;
    }

    const consumerPath = parts[0]!;
    const providerPath = parts[1]!;

    let linkPathsValid = true;
    for (const candidate of [consumerPath, providerPath]) {
      const pathCheck = validatePackagePath(candidate, reservedTopLevelDirs);
      if (!pathCheck.ok) {
        issues.push({ code: pathCheck.code, message: pathCheck.message });
        linkPathsValid = false;
      }
    }
    if (!linkPathsValid) {
      continue;
    }

    const consumer = seenPaths.get(consumerPath);
    const provider = seenPaths.get(providerPath);
    if (consumer === undefined || provider === undefined) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Cannot link "${consumerPath}" -> "${providerPath}": unknown package path.`,
      });
      continue;
    }

    if (consumer.singleton || provider.singleton) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Cannot link "${consumerPath}" -> "${providerPath}": singleton workspace packages cannot participate in explicit links.`,
      });
      continue;
    }

    if (consumer.path === provider.path) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Package "${consumerPath}" cannot link to itself.`,
      });
      continue;
    }

    if (
      !canLinkRoles(
        consumer.referencePackage.role,
        provider.referencePackage.role,
      )
    ) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Package "${consumer.path}" (${consumer.referencePackage.role}) cannot link to "${provider.path}" (${provider.referencePackage.role}).`,
      });
      continue;
    }

    const linkKey = `${consumer.path}\u0000${provider.path}`;
    if (!seenLinkKeys.has(linkKey)) {
      seenLinkKeys.add(linkKey);
      consumer.linkedProviders.push(provider.packageName);
      links.push({
        consumerPath: consumer.path,
        providerPath: provider.path,
        consumerPackageName: consumer.packageName,
        providerPackageName: provider.packageName,
      });
    }
  }

  // Validate directory ownership invariants on WorkspaceRoot and all PackageInstances.
  const subpackagePaths = plannedNodes.map((node) => node.path);
  const rootResourceTargets = new Set<string>();
  validateDeclaredResources({
    ownerLabel: "Workspace root",
    resources: [
      ...(request.workspaceRoot.resources ?? []),
      ...(request.workspaceRoot.publicationResources ?? []),
    ],
    seenTargets: rootResourceTargets,
    forbiddenSubpackagePaths: subpackagePaths,
    issues,
  });

  if (request.workspaceRoot.devcontainerBase !== undefined) {
    for (const sourcePath of [
      request.workspaceRoot.devcontainerBase.dockerfileSourcePath,
      request.workspaceRoot.devcontainerBase.templateSourcePath,
    ]) {
      if (normalizeRelativePackagePath(sourcePath) === undefined) {
        issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Workspace root devcontainer source path "${sourcePath}" escapes package directory.`,
        });
      }
    }
  }

  for (const node of plannedNodes) {
    validateDeclaredResources({
      ownerLabel: `Package "${node.path}"`,
      resources: node.referencePackage.resources ?? [],
      seenTargets: new Set<string>(),
      issues,
    });
  }

  const instances: PackageInstance[] = plannedNodes.map((node) => ({
    presetAlias: node.presetAlias,
    nodeId: node.nodeId,
    leafName: node.leafName,
    packageName: node.packageName,
    path: node.path,
    singleton: node.singleton,
    referencePackage: node.referencePackage,
    dependencyBindings: node.dependencyBindings,
    linkedProviders: node.linkedProviders,
  }));

  const envMerge = mergeWorkspaceEnvironment(request.workspaceRoot, instances, {
    source: request.source,
    ...(request.workspacePolicy === undefined
      ? {}
      : { workspacePolicy: request.workspacePolicy }),
  });
  if (!envMerge.ok) {
    issues.push(...envMerge.issues);
  }

  if (issues.length > 0) {
    return { ok: false, issues: deduplicateIssues(issues) };
  }

  return {
    ok: true,
    blueprint: {
      targetDir,
      repositoryName,
      scope: resolvedScope,
      workspaceRoot: request.workspaceRoot,
      instances,
      links,
    },
  };
}
