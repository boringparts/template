import { isBuiltin } from "node:module";

import {
  defaultPackageRoles,
  isDefaultPackageRole,
} from "@boringparts/default-content-authoring/package-role";
import {
  assertProjectBlueprintDraft,
  ProjectBlueprintValidationError,
  validateProjectBlueprint,
  type BlueprintValidationIssue,
  type BlueprintValidationResult,
  type PackageDefinition,
  type ProjectBlueprint,
  type ProjectBlueprintDraft,
} from "@boringparts/template-core/project-blueprint";

const defaultPackagePath = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u;
const reservedWorkspaceCollections = new Set([
  ".git",
  ".github",
  ".devcontainer",
  ".template",
  "node_modules",
  "dist",
  "target",
]);
const reservedPackageNames = new Set(["node_modules", "favicon.ico"]);
const defaultPackageScope = /^[a-z0-9][a-z0-9._-]*$/u;

export type DefaultPackagePathValidation = {
  readonly hasValidShape: boolean;
  readonly reservedWorkspaceCollection?: string;
};

/** Validates whether a string is a legal npm package name for new packages under the default policy. */
export function isValidDefaultNpmPackageName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 214 ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value === "." ||
    value === ".." ||
    reservedPackageNames.has(value) ||
    isBuiltin(value)
  ) {
    return false;
  }

  const scopedMatch = /^@([^/]+)\/([^/]+)$/.exec(value);
  if (value.startsWith("@") && scopedMatch === null) return false;

  const scope = scopedMatch?.[1];
  const leaf = scopedMatch?.[2] ?? value;
  if (scope === undefined && /^[._-]/.test(leaf)) {
    return false;
  }
  if (scope !== undefined && leaf.startsWith(".")) {
    return false;
  }
  if (/[~'!()*]/.test(leaf)) return false;

  return (
    encodeURIComponent(leaf) === leaf &&
    (scope === undefined || encodeURIComponent(scope) === scope)
  );
}

/** Validates the npm scope segment format for the default workspace package scope. */
export function isValidDefaultPackageScope(value: string): boolean {
  return defaultPackageScope.test(value);
}

/** Validates the default two-segment package path shape and flags reserved workspace collection directories. */
export function validateDefaultPackagePath(
  value: string,
): DefaultPackagePathValidation {
  const workspaceCollection = value.split("/", 1)[0]!;
  return {
    hasValidShape: defaultPackagePath.test(value),
    ...(reservedWorkspaceCollections.has(workspaceCollection)
      ? { reservedWorkspaceCollection: workspaceCollection }
      : {}),
  };
}

function defaultPackageIssues(
  definition: PackageDefinition,
  index: number,
): BlueprintValidationIssue[] {
  const itemPath = `.packages[${index}]`;
  const issues: BlueprintValidationIssue[] = [];
  if (!isDefaultPackageRole(definition.role)) {
    const supportedRoles = `${defaultPackageRoles
      .slice(0, -1)
      .join(", ")}, or ${defaultPackageRoles.at(-1)}`;
    issues.push({
      path: `${itemPath}.role`,
      message: `Package Role must be ${supportedRoles}`,
    });
  }
  if (!isValidDefaultNpmPackageName(definition.name)) {
    issues.push({
      path: `${itemPath}.name`,
      message: "Package name must be a valid npm package name for new packages",
      packageIdentityIssue: { kind: "invalid", field: "name" },
    });
  }
  const isNativeWorkspaceRoot =
    definition.path === "." && definition.role === "native-package";
  if (!isNativeWorkspaceRoot) {
    const pathValidation = validateDefaultPackagePath(definition.path);
    if (pathValidation.reservedWorkspaceCollection !== undefined) {
      issues.push({
        path: `${itemPath}.path`,
        message: `Package Path ${definition.path} uses reserved workspace collection ${pathValidation.reservedWorkspaceCollection}`,
        packageIdentityIssue: { kind: "reserved", field: "path" },
      });
    } else if (!pathValidation.hasValidShape) {
      issues.push({
        path: `${itemPath}.path`,
        message: "Package Path must be exactly two safe path segments",
        packageIdentityIssue: { kind: "invalid", field: "path" },
      });
    }
  }
  return issues;
}

function defaultBlueprintIssues(
  blueprint: Pick<ProjectBlueprint, "packages"> | ProjectBlueprintDraft,
): BlueprintValidationIssue[] {
  return blueprint.packages.flatMap(defaultPackageIssues);
}

/** Validates a persisted project blueprint against the default policy's npm naming, role, and directory contracts. */
export function validateDefaultProjectBlueprint(
  value: unknown,
): BlueprintValidationResult {
  const result = validateProjectBlueprint(value);
  if (!result.ok) return result;
  const issues = defaultBlueprintIssues(result.value);
  return issues.length === 0 ? result : { ok: false, issues };
}

/** Validates package topology under the default policy before assigning persisted package definition IDs. Throws ProjectBlueprintValidationError on violations. */
export function assertDefaultProjectBlueprintDraft(
  value: ProjectBlueprintDraft,
): ProjectBlueprintDraft {
  const blueprint = assertProjectBlueprintDraft(value);
  const issues = defaultBlueprintIssues(blueprint);
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return blueprint;
}

/** Validates a persisted project blueprint under the default policy. Throws ProjectBlueprintValidationError on violations. */
export function assertDefaultProjectBlueprint(
  value: unknown,
): ProjectBlueprint {
  const result = validateDefaultProjectBlueprint(value);
  if (!result.ok) {
    throw new ProjectBlueprintValidationError(result.issues);
  }
  return result.value;
}

/** Validates a package definition's role, npm name, and path when instantiating under the default policy. Throws ProjectBlueprintValidationError on violations. */
export function assertDefaultPackageDefinition(
  definition: PackageDefinition,
): PackageDefinition {
  const issues = defaultPackageIssues(definition, 0);
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return definition;
}
