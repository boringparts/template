import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveTemplatePackageDir } from "./template-package-dir.ts";

/**
 * Validated pnpm workspace dependency catalogs, overrides, and install policy
 * loaded from `pnpm config list --json` in source mode or `workspace-policy.json`
 * in packaged distributions.
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

let cachedSourceWorkspacePolicy: WorkspacePolicy | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectStringRecord(
  value: unknown,
  field: string,
  sourceLabel: string,
): Record<string, string> {
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
): Record<string, boolean> {
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
  stripDefaultMirror: boolean,
): Record<string, Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error(
      `Workspace policy (${sourceLabel}) is missing object field "catalogs".`,
    );
  }
  const result: Record<string, Record<string, string>> = {};
  for (const [catalogName, entries] of Object.entries(value)) {
    // `pnpm config list --json` mirrors top-level `catalog` under `catalogs.default`.
    if (stripDefaultMirror && catalogName === "default") {
      continue;
    }
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
): readonly string[] {
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

/** Validates raw workspace policy data and rejects missing or malformed fields. */
export function validateWorkspacePolicy(
  raw: unknown,
  sourceLabel: string,
  options: { readonly stripDefaultCatalogMirror?: boolean } = {},
): WorkspacePolicy {
  if (!isRecord(raw)) {
    throw new Error(`Workspace policy (${sourceLabel}) must be a JSON object.`);
  }

  return {
    catalog: expectStringRecord(raw.catalog, "catalog", sourceLabel),
    catalogs: expectCatalogsRecord(
      raw.catalogs,
      sourceLabel,
      options.stripDefaultCatalogMirror ?? false,
    ),
    overrides: expectStringRecord(raw.overrides, "overrides", sourceLabel),
    allowBuilds: expectBooleanRecord(
      raw.allowBuilds,
      "allowBuilds",
      sourceLabel,
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
    ),
  };
}

/**
 * Loads `WorkspacePolicy` from `${templatesRoot}/workspace-policy.json` when running from
 * bundled distribution templates, or via `pnpm config list --json` in monorepo source mode
 * (cached once per process).
 */
export function loadWorkspacePolicy(templatesRoot?: string): WorkspacePolicy {
  if (templatesRoot !== undefined) {
    const policyPath = path.join(templatesRoot, "workspace-policy.json");
    const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
    return validateWorkspacePolicy(parsed, policyPath);
  }

  if (cachedSourceWorkspacePolicy !== undefined) {
    return cachedSourceWorkspacePolicy;
  }

  const packageDir = resolveTemplatePackageDir();
  if (packageDir === undefined) {
    throw new Error(
      "Unable to locate @boringparts/template package directory for workspace policy resolution.",
    );
  }
  const stdout = execFileSync("pnpm", ["config", "list", "--json"], {
    cwd: packageDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout) as unknown;
  cachedSourceWorkspacePolicy = validateWorkspacePolicy(
    parsed,
    "pnpm config list --json",
    { stripDefaultCatalogMirror: true },
  );
  return cachedSourceWorkspacePolicy;
}
