import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";

/**
 * Validated pnpm workspace dependency catalogs, overrides, and install policy.
 */
export type WorkspacePolicy = {
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly overrides: Readonly<Record<string, string>>;
  readonly allowBuilds: Readonly<Record<string, boolean>>;
  readonly minimumReleaseAge: number;
  readonly minimumReleaseAgeStrict: boolean;
  readonly minimumReleaseAgeExclude: readonly string[];
  readonly nodeLinker: string;
  readonly preferSymlinkedExecutables: boolean;
  readonly shellEmulator: boolean;
  readonly autoInstallPeers: boolean;
  readonly injectWorkspacePackages: boolean;
  readonly dedupeInjectedDeps: boolean;
  readonly syncInjectedDepsAfterScripts: readonly string[];
};

/**
 * Dependency catalogs and overrides extracted from a consumer's `pnpm-workspace.yaml`.
 */
export type PnpmWorkspaceCatalog = {
  readonly catalog: Readonly<Record<string, string>>;
  readonly catalogs: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly overrides: Readonly<Record<string, string>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectStringRecord(
  value: unknown,
  field: string,
  sourceLabel: string,
  allowUndefined = false,
): Record<string, string> {
  if (value === undefined && allowUndefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing object field "${field}".`,
    );
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(
        `Workspace policy (${sourceLabel}) field "${field}.${key}" must be a string.`,
      );
    }
    result[key] = entry;
  }
  return result;
}

function expectBooleanRecord(
  value: unknown,
  field: string,
  sourceLabel: string,
  allowUndefined = false,
): Record<string, boolean> {
  if (value === undefined && allowUndefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing object field "${field}".`,
    );
  }
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "boolean") {
      throw new Error(
        `Workspace policy (${sourceLabel}) field "${field}.${key}" must be a boolean.`,
      );
    }
    result[key] = entry;
  }
  return result;
}

function expectCatalogsRecord(
  value: unknown,
  sourceLabel: string,
  allowUndefined = false,
): Record<string, Record<string, string>> {
  if (value === undefined && allowUndefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing object field "catalogs".`,
    );
  }
  const result: Record<string, Record<string, string>> = {};
  for (const [catalogName, entries] of Object.entries(value)) {
    result[catalogName] = expectStringRecord(
      entries,
      `catalogs.${catalogName}`,
      sourceLabel,
    );
  }
  return result;
}

function expectBoolean(
  value: unknown,
  field: string,
  sourceLabel: string,
): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing boolean field "${field}".`,
    );
  }
  return value;
}

function expectNonEmptyString(
  value: unknown,
  field: string,
  sourceLabel: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing non-empty string field "${field}".`,
    );
  }
  return value;
}

function expectNonNegativeNumber(
  value: unknown,
  field: string,
  sourceLabel: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing non-negative number field "${field}".`,
    );
  }
  return value;
}

function expectStringArray(
  value: unknown,
  field: string,
  sourceLabel: string,
  allowUndefined = false,
): readonly string[] {
  if (value === undefined && allowUndefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing string array field "${field}".`,
    );
  }
  return [...(value as readonly string[])];
}

/**
 * Reads `catalog`, `catalogs`, and `overrides` from a consumer's `pnpm-workspace.yaml` file
 * without spawning any package-manager subprocess.
 */
export function readPnpmWorkspaceCatalog(
  workspaceYamlPath: string,
): PnpmWorkspaceCatalog {
  const rawYaml = readFileSync(workspaceYamlPath, "utf8");
  const parsed = parseYaml(rawYaml) as unknown;
  if (parsed === null || parsed === undefined) {
    return { catalog: {}, catalogs: {}, overrides: {} };
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `Workspace config (${workspaceYamlPath}) must parse to a YAML mapping.`,
    );
  }

  return {
    catalog: expectStringRecord(
      parsed.catalog,
      "catalog",
      workspaceYamlPath,
      true,
    ),
    catalogs: expectCatalogsRecord(parsed.catalogs, workspaceYamlPath, true),
    overrides: expectStringRecord(
      parsed.overrides,
      "overrides",
      workspaceYamlPath,
      true,
    ),
  };
}

/** Validates raw workspace policy data and rejects missing or malformed fields. */
export function validateWorkspacePolicy(
  raw: unknown,
  sourceLabel = "workspace-policy",
): WorkspacePolicy {
  if (!isRecord(raw)) {
    throw new Error(`Workspace policy (${sourceLabel}) must be a JSON object.`);
  }

  return {
    catalog: expectStringRecord(raw.catalog, "catalog", sourceLabel, true),
    catalogs: expectCatalogsRecord(raw.catalogs, sourceLabel, true),
    overrides: expectStringRecord(
      raw.overrides,
      "overrides",
      sourceLabel,
      true,
    ),
    allowBuilds: expectBooleanRecord(
      raw.allowBuilds,
      "allowBuilds",
      sourceLabel,
      true,
    ),
    minimumReleaseAge: expectNonNegativeNumber(
      raw.minimumReleaseAge,
      "minimumReleaseAge",
      sourceLabel,
    ),
    minimumReleaseAgeStrict: expectBoolean(
      raw.minimumReleaseAgeStrict,
      "minimumReleaseAgeStrict",
      sourceLabel,
    ),
    minimumReleaseAgeExclude: expectStringArray(
      raw.minimumReleaseAgeExclude,
      "minimumReleaseAgeExclude",
      sourceLabel,
      true,
    ),
    nodeLinker: expectNonEmptyString(raw.nodeLinker, "nodeLinker", sourceLabel),
    preferSymlinkedExecutables: expectBoolean(
      raw.preferSymlinkedExecutables,
      "preferSymlinkedExecutables",
      sourceLabel,
    ),
    shellEmulator: expectBoolean(
      raw.shellEmulator,
      "shellEmulator",
      sourceLabel,
    ),
    autoInstallPeers: expectBoolean(
      raw.autoInstallPeers,
      "autoInstallPeers",
      sourceLabel,
    ),
    injectWorkspacePackages: expectBoolean(
      raw.injectWorkspacePackages,
      "injectWorkspacePackages",
      sourceLabel,
    ),
    dedupeInjectedDeps: expectBoolean(
      raw.dedupeInjectedDeps,
      "dedupeInjectedDeps",
      sourceLabel,
    ),
    syncInjectedDepsAfterScripts: expectStringArray(
      raw.syncInjectedDepsAfterScripts,
      "syncInjectedDepsAfterScripts",
      sourceLabel,
      true,
    ),
  };
}
