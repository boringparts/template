import path from "node:path";

import { z } from "zod";

/** Interpreted by content definitions and composition; does not govern directory write boundaries. */
export type PackageRole = string;

export type PackageDefinition = {
  readonly name: string;
  /** Canonical package directory; "." represents the target workspace root. */
  readonly path: string;
  readonly role: PackageRole;
};

export type PackageDefinitionId = `package-${string}`;

export type PersistedPackageDefinition = PackageDefinition & {
  readonly packageDefinitionId: PackageDefinitionId;
};

/** Package link expressed solely through persistent packageDefinitionId values. */
export type PackageLinkIntent = {
  readonly consumerId: PackageDefinitionId;
  readonly providerId: PackageDefinitionId;
};

export type ProjectBlueprint = {
  readonly schemaVersion: 4;
  readonly packages: readonly PersistedPackageDefinition[];
  readonly packageLinkIntents: readonly PackageLinkIntent[];
};

export type ProjectBlueprintDraft = {
  readonly schemaVersion: 4;
  readonly packages: readonly PackageDefinition[];
  readonly packageLinkIntents?: readonly PackageLinkIntent[];
};

export type BlueprintValidationIssue = {
  readonly path: string;
  readonly message: string;
  readonly packageIdentityIssue?: BlueprintPackageIdentityIssue;
};

export type BlueprintPackageIdentityIssue =
  | {
      readonly kind: "duplicate";
      readonly field: "name" | "path";
      readonly existing: PackageDefinition;
      readonly requested: PackageDefinition;
    }
  | {
      readonly kind: "invalid";
      readonly field: "name" | "path";
    }
  | { readonly kind: "reserved"; readonly field: "path" };

export class ProjectBlueprintValidationError extends Error {
  readonly issues: readonly BlueprintValidationIssue[];

  constructor(issues: readonly BlueprintValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
    this.name = "ProjectBlueprintValidationError";
    this.issues = issues;
  }

  get packageIdentityIssues(): readonly BlueprintPackageIdentityIssue[] {
    return this.issues.flatMap((issue) =>
      issue.packageIdentityIssue === undefined
        ? []
        : [issue.packageIdentityIssue],
    );
  }
}

export type BlueprintValidationResult =
  | { readonly ok: true; readonly value: ProjectBlueprint }
  | {
      readonly ok: false;
      readonly issues: readonly BlueprintValidationIssue[];
    };

const packageDefinitionSchema = z.strictObject({
  packageDefinitionId: z.string().regex(/^package-[a-f0-9]{64}$/),
  name: z.string(),
  path: z.string(),
  role: z.string(),
});

const packageLinkIntentSchema = z.strictObject({
  consumerId: z.string().regex(/^package-[a-f0-9]{64}$/),
  providerId: z.string().regex(/^package-[a-f0-9]{64}$/),
});

export const projectBlueprintSchema = z.strictObject({
  schemaVersion: z.literal(4),
  packages: z.array(packageDefinitionSchema),
  packageLinkIntents: z.array(packageLinkIntentSchema),
});

function isNormalizedPackagePath(value: string): boolean {
  if (value === ".") return true;
  const normalized = path.posix.normalize(value);
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    path.win32.parse(value).root.length === 0 &&
    !value.endsWith("/") &&
    normalized !== "." &&
    normalized !== ".." &&
    !normalized.startsWith("../") &&
    normalized === value
  );
}

function blueprintIssuePath(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (result, key) =>
      typeof key === "number"
        ? `${result}[${key}]`
        : `${result === "." ? "." : `${result}.`}${String(key)}`,
    ".",
  );
}

function validateBlueprintSemantics(
  blueprint: Omit<ProjectBlueprint, "packages"> & {
    readonly packages: readonly PackageDefinition[];
  },
): BlueprintValidationIssue[] {
  const issues: BlueprintValidationIssue[] = [];
  for (const [index, definition] of blueprint.packages.entries()) {
    const itemPath = `.packages[${index}]`;
    if (definition.name.trim().length === 0) {
      issues.push({
        path: `${itemPath}.name`,
        message: "Package name must not be empty",
        packageIdentityIssue: { kind: "invalid", field: "name" },
      });
    }
    if (definition.role.trim().length === 0) {
      issues.push({
        path: `${itemPath}.role`,
        message: "Package role must not be empty",
      });
    }
    if (!isNormalizedPackagePath(definition.path)) {
      issues.push({
        path: `${itemPath}.path`,
        message: "Package path must be a normalized safe relative path",
        packageIdentityIssue: { kind: "invalid", field: "path" },
      });
    }
  }

  for (const [property, label] of [
    ["name", "Package name"],
    ["path", "Package path"],
  ] as const) {
    const seen = new Map<string, PackageDefinition>();
    for (const definition of blueprint.packages) {
      const member = definition[property];
      const existing = seen.get(member);
      if (existing !== undefined) {
        issues.push({
          path: ".packages",
          message: `${label} must be unique: ${member}`,
          packageIdentityIssue: {
            kind: "duplicate",
            field: property,
            existing: {
              name: existing.name,
              path: existing.path,
              role: existing.role,
            },
            requested: {
              name: definition.name,
              path: definition.path,
              role: definition.role,
            },
          },
        });
      }
      seen.set(member, definition);
    }
  }

  const ids = new Set<PackageDefinitionId>();
  for (const [index, definition] of blueprint.packages.entries()) {
    if (!("packageDefinitionId" in definition)) continue;
    const id = definition.packageDefinitionId;
    if (typeof id !== "string") continue;
    const packageId = id as PackageDefinitionId;
    if (ids.has(packageId)) {
      issues.push({
        path: `.packages[${index}].packageDefinitionId`,
        message: `Package definition ID must be unique: ${packageId}`,
      });
    }
    ids.add(packageId);
  }

  const links = new Set<string>();
  for (const [index, intent] of blueprint.packageLinkIntents.entries()) {
    const itemPath = `.packageLinkIntents[${index}]`;
    if (!ids.has(intent.consumerId)) {
      issues.push({
        path: `${itemPath}.consumerId`,
        message:
          "Package link references a non-existent consumer package instance",
      });
    }
    if (!ids.has(intent.providerId)) {
      issues.push({
        path: `${itemPath}.providerId`,
        message:
          "Package link references a non-existent provider package instance",
      });
    }
    if (intent.consumerId === intent.providerId) {
      issues.push({
        path: itemPath,
        message: "Package link must not target itself",
      });
    }
    const key = `${intent.consumerId}\0${intent.providerId}`;
    if (links.has(key)) {
      issues.push({
        path: itemPath,
        message: "Package link must not be duplicated",
      });
    }
    links.add(key);
  }
  return issues;
}

function structureIssues(
  value: unknown,
  issues: readonly z.core.$ZodIssue[],
): BlueprintValidationIssue[] {
  return issues.flatMap((issue): BlueprintValidationIssue[] => {
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: blueprintIssuePath([...issue.path, key]),
        message: "Blueprint v4 contains an unknown field",
      }));
    }
    const issuePath = blueprintIssuePath(issue.path);
    if (issuePath === ".schemaVersion") {
      return [
        {
          path: issuePath,
          message: `Unsupported local template metadata version ${String(isObject(value) ? value.schemaVersion : undefined)}; only schema4 is supported`,
        },
      ];
    }
    const parent = issue.path
      .slice(0, -1)
      .reduce<unknown>(
        (current, key) =>
          typeof current === "object" && current !== null
            ? Reflect.get(current, key)
            : undefined,
        value,
      );
    const key = issue.path.at(-1);
    const missing =
      key !== undefined &&
      typeof parent === "object" &&
      parent !== null &&
      !Object.hasOwn(parent, key);
    return [
      {
        path: issuePath,
        message: missing
          ? "Blueprint is missing a required field"
          : "Field type or structure does not match the blueprint schema",
      },
    ];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateProjectBlueprint(
  value: unknown,
): BlueprintValidationResult {
  const result = projectBlueprintSchema.safeParse(value);
  if (!result.success)
    return { ok: false, issues: structureIssues(value, result.error.issues) };
  const parsed = result.data;
  const blueprint: ProjectBlueprint = {
    schemaVersion: parsed.schemaVersion,
    packages: parsed.packages as readonly PersistedPackageDefinition[],
    packageLinkIntents:
      parsed.packageLinkIntents as readonly PackageLinkIntent[],
  };
  const issues = validateBlueprintSemantics(blueprint);
  return issues.length === 0
    ? { ok: true, value: blueprint }
    : { ok: false, issues };
}

export function assertProjectBlueprintDraft(
  value: ProjectBlueprintDraft,
): ProjectBlueprintDraft {
  if (value.schemaVersion !== 4) {
    throw new Error("Project blueprint draft must use schema4");
  }
  const issues = validateBlueprintSemantics({
    schemaVersion: value.schemaVersion,
    packages: value.packages,
    packageLinkIntents: value.packageLinkIntents ?? [],
  });
  if (issues.length > 0) {
    throw new ProjectBlueprintValidationError(issues);
  }
  return value;
}

export function assertProjectBlueprint(value: unknown): ProjectBlueprint {
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    throw new ProjectBlueprintValidationError(result.issues);
  }
  return result.value;
}
