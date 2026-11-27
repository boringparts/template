import { createRequire, isBuiltin } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const rawValidateNpmPackageName: unknown = require("validate-npm-package-name");

function validateNpmPackageName(name: string): {
  readonly validForNewPackages: boolean;
} {
  if (typeof rawValidateNpmPackageName !== "function") {
    throw new Error("validate-npm-package-name did not export a function");
  }
  const result: unknown = (
    rawValidateNpmPackageName as (value: string) => unknown
  )(name);
  if (
    typeof result !== "object" ||
    result === null ||
    !("validForNewPackages" in result) ||
    typeof result.validForNewPackages !== "boolean"
  ) {
    throw new Error("validate-npm-package-name returned an unexpected result");
  }
  return { validForNewPackages: result.validForNewPackages };
}

import type {
  DevcontainerLayer,
  EditorCapability,
  GeneratedInstance,
  InvalidRequestIssue,
  PackageRole,
  PlanProjectRequest,
  PlanProjectResult,
  PresetDefinition,
  ProjectLink,
} from "./types.ts";

const defaultPackagePathPattern = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const defaultPackageScopePattern = /^[a-z0-9][a-z0-9._-]*$/u;
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

const devcontainerLayerOrder: readonly DevcontainerLayer[] = [
  "github-cli",
  "browser-test",
  "shellcheck",
  "rust-toolchain",
];

const editorCapabilityOrder: readonly EditorCapability[] = [
  "oxc-format-lint",
  "vue",
  "tailwind",
  "rust-tooling",
  "vitest",
];

/** Validates an unscoped npm package leaf name under the default workspace policy. */
export function isValidPackageLeafName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value.startsWith(".") ||
    isBuiltin(value) ||
    value === "node_modules" ||
    value === "favicon.ico" ||
    /[~'!()*]/u.test(value) ||
    encodeURIComponent(value) !== value
  ) {
    return false;
  }
  return validateNpmPackageName(`@x/${value}`).validForNewPackages;
}

/** Validates a normalized npm package scope (without leading `@`). */
export function isValidPackageScope(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 214 &&
    defaultPackageScopePattern.test(value) &&
    validateNpmPackageName(`@${value}/pkg`).validForNewPackages
  );
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

type MutablePlannedNode = {
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly reference: PresetDefinition["nodes"][number]["reference"];
  readonly packageBindings: ReadonlyMap<string, string>;
  readonly pathReplacements: ReadonlyMap<string, string>;
  readonly linkedProviders: string[];
};

/**
 * Validates CLI initialization inputs in memory without touching disk and produces a deterministic `ProjectBlueprint`.
 */
export function planProject(request: PlanProjectRequest): PlanProjectResult {
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

  const plannedNodes: MutablePlannedNode[] = [];
  const selectedPresets: PresetDefinition[] = [];
  const presetNodePackagesBySelection: Map<string, string>[] = [];

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
      const nodePathById = new Map<string, string>();
      for (const node of preset.nodes) {
        const packageName = `@${resolvedScope}/${node.defaultName}`;
        nodePackageById.set(node.nodeId, packageName);
        nodePathById.set(node.nodeId, node.defaultPath);
      }
      presetNodePackagesBySelection.push(nodePackageById);

      for (const node of preset.nodes) {
        const packageBindings = new Map<string, string>();
        packageBindings.set(
          node.reference.packageName,
          nodePackageById.get(node.nodeId)!,
        );
        for (const [refPkgName, targetNodeId] of Object.entries(
          node.internalBindings ?? {},
        )) {
          const targetPkgName = nodePackageById.get(targetNodeId);
          if (targetPkgName !== undefined) {
            packageBindings.set(refPkgName, targetPkgName);
          }
        }

        const pathReplacements = new Map<string, string>(
          Object.entries(node.pathReplacements ?? {}),
        );

        plannedNodes.push({
          presetAlias: preset.alias,
          nodeId: node.nodeId,
          leafName: node.defaultName,
          packageName: nodePackageById.get(node.nodeId)!,
          path: node.defaultPath,
          reference: node.reference,
          packageBindings,
          pathReplacements,
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
    const packageBindings = new Map<string, string>([
      [primary.reference.packageName, packageName],
    ]);
    const pathReplacements = new Map<string, string>(
      Object.entries(primary.pathReplacements ?? {}),
    );
    presetNodePackagesBySelection.push(
      new Map([[primary.nodeId, packageName]]),
    );

    plannedNodes.push({
      presetAlias: preset.alias,
      nodeId: primary.nodeId,
      leafName,
      packageName,
      path: packagePath,
      reference: primary.reference,
      packageBindings,
      pathReplacements,
      linkedProviders: [],
    });
  }

  // Check identity conflicts against reserved tooling-config and across planned instances
  const seenNames = new Map<string, MutablePlannedNode>();
  const seenPaths = new Map<string, MutablePlannedNode>();
  const seenBins = new Map<string, MutablePlannedNode>();

  for (const node of plannedNodes) {
    if (
      reservedPackageNames.has(node.leafName) ||
      node.path === "packages/tooling-config"
    ) {
      issues.push({
        code: "CONFLICTING_PACKAGE_IDENTITY",
        message: `Package "${node.packageName}" (${node.path}) conflicts with the base tooling-config package.`,
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

    if (node.reference.rewriteBinName) {
      const existingByBin = seenBins.get(node.leafName);
      if (existingByBin !== undefined) {
        issues.push({
          code: "CONFLICTING_PACKAGE_IDENTITY",
          message: `Duplicate CLI command name "${node.leafName}" across "${existingByBin.path}" and "${node.path}".`,
        });
      } else {
        seenBins.set(node.leafName, node);
      }
    }
  }

  // Validate explicit `--link <consumer-path>:<provider-path>` requests
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

    if (!canLinkRoles(consumer.reference.role, provider.reference.role)) {
      issues.push({
        code: "UNSUPPORTED_LINK",
        message: `Package "${consumer.path}" (${consumer.reference.role}) cannot link to "${provider.path}" (${provider.reference.role}).`,
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

  if (issues.length > 0) {
    return { ok: false, issues: deduplicateIssues(issues) };
  }

  const layerSet = new Set<DevcontainerLayer>(["github-cli"]);
  const editorSet = new Set<EditorCapability>(["oxc-format-lint"]);
  const allowBuildSet = new Set<string>();
  const overrideSet = new Set<string>();
  let rustWorkspace = false;
  let rootDockerDependabot = false;
  let cargoDependabot = false;
  let rootDevFilterPackage: string | undefined;

  for (const [index, preset] of selectedPresets.entries()) {
    for (const layer of preset.capabilities.devcontainerLayers ?? []) {
      layerSet.add(layer);
    }
    for (const capability of preset.capabilities.editorCapabilities ?? []) {
      editorSet.add(capability);
    }
    for (const pkg of preset.capabilities.allowBuilds ?? []) {
      allowBuildSet.add(pkg);
    }
    for (const overrideKey of preset.capabilities.pnpmOverrides ?? []) {
      overrideSet.add(overrideKey);
    }
    if (preset.capabilities.rustWorkspace) {
      rustWorkspace = true;
    }
    if (preset.capabilities.rootDockerDependabot) {
      rootDockerDependabot = true;
    }
    if (preset.capabilities.cargoDependabot) {
      cargoDependabot = true;
    }
    if (
      rootDevFilterPackage === undefined &&
      preset.capabilities.rootDevDelegateNodeId !== undefined
    ) {
      rootDevFilterPackage = presetNodePackagesBySelection[index]?.get(
        preset.capabilities.rootDevDelegateNodeId,
      );
    }
  }

  const instances: GeneratedInstance[] = plannedNodes.map((node) => ({
    presetAlias: node.presetAlias,
    nodeId: node.nodeId,
    leafName: node.leafName,
    packageName: node.packageName,
    path: node.path,
    reference: node.reference,
    packageBindings: node.packageBindings,
    pathReplacements: node.pathReplacements,
    linkedProviders: node.linkedProviders,
  }));

  return {
    ok: true,
    blueprint: {
      targetDir,
      repositoryName,
      scope: resolvedScope,
      instances,
      links,
      capabilities: {
        hasPublishable: instances.some(
          (instance) => instance.reference.publishable,
        ),
        rustWorkspace,
        rootDockerDependabot,
        cargoDependabot,
        devcontainerLayers: devcontainerLayerOrder.filter((layer) =>
          layerSet.has(layer),
        ),
        editorCapabilities: editorCapabilityOrder.filter((capability) =>
          editorSet.has(capability),
        ),
        allowBuilds: [...allowBuildSet].toSorted(),
        pnpmOverrides: [...overrideSet].toSorted(),
        ...(rootDevFilterPackage === undefined ? {} : { rootDevFilterPackage }),
      },
    },
  };
}
