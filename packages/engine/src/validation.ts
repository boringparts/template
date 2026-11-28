import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";

import { normalizeRelativePackagePath } from "./scan.ts";
import type {
  GeneratedInstance,
  InvalidRequestIssue,
  PackageDefinition,
  PackageRole,
  PlanProjectRequest,
  PlanProjectResult,
  PresetDefinition,
  ProjectLink,
} from "./types.ts";

const maxNpmPackageNameLength = 214;
const defaultPackagePathPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const restrictedPackageIdentifierPattern = /^[a-z0-9][a-z0-9._-]*$/u;
const reservedPackageNames = new Set([
  "node_modules",
  "favicon.ico",
  "tooling-config",
]);
const reservedWorkspaceCollections = new Set([
  ".git",
  ".github",
  ".devcontainer",
  ".template",
  "node_modules",
  "dist",
  "target",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readManifestBinKeys(packageDir: string): readonly string[] {
  const manifestPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.bin)) {
      return [];
    }
    return Object.keys(parsed.bin);
  } catch {
    return [];
  }
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
    value !== "node_modules" &&
    value !== "favicon.ico"
  );
}

/** Validates a normalized npm package scope (without leading `@`). */
export function isValidPackageScope(value: string): boolean {
  return isValidRestrictedIdentifier(value);
}

/** Validates a two-segment relative package path and detects reserved workspace directories. */
export function validatePackagePath(value: string):
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
    value.startsWith("/") ||
    value.includes("..")
  ) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe path segments.`,
    };
  }
  const firstSegment = value.split("/", 1)[0] ?? "";
  if (reservedWorkspaceCollections.has(firstSegment)) {
    return {
      ok: false,
      code: "RESERVED_PACKAGE_PATH",
      message: `Package path "${value}" uses reserved workspace directory "${firstSegment}".`,
    };
  }
  if (!defaultPackagePathPattern.test(value)) {
    return {
      ok: false,
      code: "INVALID_PACKAGE_PATH",
      message: `Package path "${value}" must contain exactly two safe lowercase segments.`,
    };
  }
  return { ok: true };
}

/**
 * Enforces the 6-role explicit `--link` compatibility matrix:
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

type MutablePlannedNode<TMeta> = {
  readonly kind: "base" | "package";
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly definition: PackageDefinition<TMeta>;
  readonly dependencyBindings: Map<string, string>;
  readonly linkedProviders: string[];
};

/**
 * Validates CLI initialization inputs in memory without touching disk and produces a deterministic `ProjectBlueprint`.
 */
export function planProject<TMeta>(
  request: PlanProjectRequest<TMeta>,
): PlanProjectResult<TMeta> {
  const issues: InvalidRequestIssue[] = [];
  const targetDir = path.resolve(request.cwd, request.dir);
  const repositoryName = path.basename(targetDir);

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
      message: `Target directory name "${repositoryName}" cannot be used as a default npm scope; specify --scope.`,
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
      message: "At least one --preset specification is required.",
    });
  }

  // Plan base singleton nodes (root `.` and shared `packages/tooling-config`) through the same node model.
  const baseNodes: MutablePlannedNode<TMeta>[] = [];
  const sharedBaseBindings = new Map<string, string>();
  for (const base of request.basePackages ?? []) {
    const packageName =
      base.path === "." ? repositoryName : `@${resolvedScope}/${base.leafName}`;
    if (base.path !== ".") {
      if (packageName.length > maxNpmPackageNameLength) {
        issues.push({
          code:
            request.scope !== undefined
              ? "INVALID_PACKAGE_SCOPE"
              : "INVALID_REPOSITORY_SCOPE",
          message: `Scoped package name "${packageName}" exceeds ${String(maxNpmPackageNameLength)} characters.`,
        });
      }
      sharedBaseBindings.set(base.definition.packageName, packageName);
    }
    baseNodes.push({
      kind: "base",
      presetAlias: "workspace-base",
      nodeId: base.nodeId,
      leafName: base.leafName,
      packageName,
      path: base.path,
      definition: base.definition,
      dependencyBindings: new Map<string, string>([
        [base.definition.packageName, packageName],
      ]),
      linkedProviders: [],
    });
  }

  for (const baseNode of baseNodes) {
    for (const [refPkgName, targetPkgName] of sharedBaseBindings) {
      baseNode.dependencyBindings.set(refPkgName, targetPkgName);
    }
  }

  const plannedNodes: MutablePlannedNode<TMeta>[] = [];
  const selectedPresets: PresetDefinition<TMeta>[] = [];

  for (const rawSpec of request.presetSpecs) {
    const parts = rawSpec.split(":");
    if (
      rawSpec.length === 0 ||
      parts.length > 3 ||
      parts.some((part) => part.length === 0)
    ) {
      issues.push({
        code: "INVALID_PRESET_SPEC",
        message: `Invalid --preset syntax "${rawSpec}"; expected <preset>[:<name>[:<path>]].`,
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
    selectedPresets.push(preset);

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
        const dependencyBindings = new Map<string, string>(sharedBaseBindings);
        dependencyBindings.set(
          node.definition.packageName,
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
          kind: "package",
          presetAlias: preset.alias,
          nodeId: node.nodeId,
          leafName: node.defaultName,
          packageName: nodePackageById.get(node.nodeId)!,
          path: node.defaultPath,
          definition: node.definition,
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

    const packagePath =
      customPath ?? `${primary.defaultCollection}/${leafName}`;
    if (customPath !== undefined) {
      const pathCheck = validatePackagePath(customPath);
      if (!pathCheck.ok) {
        issues.push({ code: pathCheck.code, message: pathCheck.message });
      }
    }

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
    const dependencyBindings = new Map<string, string>(sharedBaseBindings);
    dependencyBindings.set(primary.definition.packageName, packageName);

    plannedNodes.push({
      kind: "package",
      presetAlias: preset.alias,
      nodeId: primary.nodeId,
      leafName,
      packageName,
      path: packagePath,
      definition: primary.definition,
      dependencyBindings,
      linkedProviders: [],
    });
  }

  // Check identity conflicts against base singletons and across planned business instances.
  const seenNames = new Map<string, MutablePlannedNode<TMeta>>();
  const seenPaths = new Map<string, MutablePlannedNode<TMeta>>();
  const seenBins = new Map<string, MutablePlannedNode<TMeta>>();

  const baseReservedPaths = new Set(baseNodes.map((node) => node.path));
  const baseReservedNames = new Set(baseNodes.map((node) => node.packageName));

  for (const node of plannedNodes) {
    if (
      reservedPackageNames.has(node.leafName) ||
      baseReservedPaths.has(node.path) ||
      baseReservedNames.has(node.packageName) ||
      node.path === "packages/tooling-config"
    ) {
      issues.push({
        code: "CONFLICTING_PACKAGE_IDENTITY",
        message: `Package "${node.packageName}" (${node.path}) conflicts with the base workspace package.`,
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
    const binKeys = readManifestBinKeys(node.definition.packageDir);
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

  // Validate explicit `--link <consumer-path>:<provider-path>` requests (rejecting base singletons).
  const basePathsByPath = new Map(baseNodes.map((node) => [node.path, node]));
  const links: ProjectLink[] = [];
  const seenLinkKeys = new Set<string>();
  for (const rawLink of request.linkSpecs) {
    const parts = rawLink.split(":");
    if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
      issues.push({
        code: "INVALID_LINK_SPEC",
        message: `Invalid --link syntax "${rawLink}"; expected <consumer-path>:<provider-path>.`,
      });
      continue;
    }

    const consumerPath = parts[0]!;
    const providerPath = parts[1]!;

    let linkPathsValid = true;
    for (const candidate of [consumerPath, providerPath]) {
      const pathCheck = validatePackagePath(candidate);
      if (!pathCheck.ok) {
        issues.push({ code: pathCheck.code, message: pathCheck.message });
        linkPathsValid = false;
      }
    }
    if (!linkPathsValid) {
      continue;
    }

    if (
      basePathsByPath.has(consumerPath) ||
      basePathsByPath.has(providerPath)
    ) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Cannot link "${consumerPath}" -> "${providerPath}": base workspace singletons cannot participate in --link.`,
      });
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

    if (consumer.path === provider.path) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Package "${consumerPath}" cannot link to itself.`,
      });
      continue;
    }

    if (!canLinkRoles(consumer.definition.role, provider.definition.role)) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Package "${consumer.path}" (${consumer.definition.role}) cannot link to "${provider.path}" (${provider.definition.role}).`,
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

  const allNodes = [...baseNodes, ...plannedNodes];
  const subpackagePaths = allNodes
    .filter((node) => node.path !== ".")
    .map((node) => node.path);

  // Validate declared resource mappings for directory ownership invariants during planning.
  for (const node of allNodes) {
    const seenResourceTargets = new Set<string>();
    for (const resource of node.definition.resources ?? []) {
      const normalizedSource = normalizeRelativePackagePath(
        resource.sourcePath,
      );
      if (normalizedSource === undefined) {
        issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${node.path}" resource source path "${resource.sourcePath}" escapes package directory.`,
        });
      }
      const normalizedTarget = normalizeRelativePackagePath(
        resource.targetPath,
      );
      if (normalizedTarget === undefined) {
        issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${node.path}" resource target path "${resource.targetPath}" escapes package directory.`,
        });
        continue;
      }
      if (seenResourceTargets.has(normalizedTarget)) {
        issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${node.path}" declares duplicate resource target path "${normalizedTarget}".`,
        });
      } else {
        seenResourceTargets.add(normalizedTarget);
      }
      if (node.path === ".") {
        for (const subPath of subpackagePaths) {
          if (
            normalizedTarget === subPath ||
            normalizedTarget.startsWith(`${subPath}/`)
          ) {
            issues.push({
              code: "DIRECTORY_OWNERSHIP_VIOLATION",
              message: `Root package resource "${normalizedTarget}" intrudes into subpackage "${subPath}".`,
            });
          }
        }
      }
    }
  }

  const instances: GeneratedInstance<TMeta>[] = allNodes.map((node) => ({
    kind: node.kind,
    presetAlias: node.presetAlias,
    nodeId: node.nodeId,
    leafName: node.leafName,
    packageName: node.packageName,
    path: node.path,
    definition: node.definition,
    dependencyBindings: node.dependencyBindings,
    linkedProviders: node.linkedProviders,
  }));

  for (const instance of instances) {
    if (instance.definition.validateWorkspace !== undefined) {
      issues.push(...instance.definition.validateWorkspace(instances));
    }
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
      instances,
      links,
    },
  };
}
