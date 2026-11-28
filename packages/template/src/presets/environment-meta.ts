import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import type { GeneratedInstance, InvalidRequestIssue } from "../core/index.ts";
import { resolvePackageDir, resolvePlaywrightVersion } from "./roots.ts";

export type DevcontainerMount = {
  readonly type: "volume" | "bind" | "tmpfs";
  readonly source: string;
  readonly target: string;
};

export type DevcontainerLayerHandle = {
  readonly id: string;
  readonly dockerfilePath: string;
};

export type DependabotIgnoreRule = {
  readonly dependencyName: string;
  readonly updateTypes?: readonly string[];
};

export type DependabotUpdateRule = {
  readonly packageEcosystem: string;
  readonly directory: string;
  readonly interval?: "daily" | "weekly" | "monthly";
  readonly ignore?: readonly DependabotIgnoreRule[];
};

export type DependabotNpmGroup = {
  readonly patterns: readonly string[];
};

/**
 * Static root-converging workspace environment metadata declaration.
 */
export type StaticWorkspaceEnvironmentMeta = {
  readonly devcontainer?: {
    readonly layers?: readonly DevcontainerLayerHandle[];
    readonly buildArgs?: Readonly<Record<string, string>>;
    readonly mounts?: readonly DevcontainerMount[];
    readonly containerEnv?: Readonly<Record<string, string>>;
  };
  readonly vscode?: {
    readonly extensions?: readonly string[];
    readonly settings?: Readonly<Record<string, unknown>>;
  };
  readonly dependabot?: {
    readonly updates?: readonly DependabotUpdateRule[];
    readonly npmGroups?: Readonly<Record<string, DependabotNpmGroup>>;
  };
};

/**
 * Closed set of root-converging workspace environment metadata that presets may
 * attach locally to individual reference packages (statically or derived from instance path).
 */
export type WorkspaceEnvironmentMeta =
  | StaticWorkspaceEnvironmentMeta
  | ((
      instance: GeneratedInstance<WorkspaceEnvironmentMeta>,
    ) => StaticWorkspaceEnvironmentMeta);

export type MergedWorkspaceEnvironmentMeta = {
  readonly devcontainer: {
    readonly layers: readonly DevcontainerLayerHandle[];
    readonly buildArgs: Readonly<Record<string, string>>;
    readonly mounts: readonly DevcontainerMount[];
    readonly containerEnv: Readonly<Record<string, string>>;
  };
  readonly vscode: {
    readonly extensions: readonly string[];
    readonly settings: Readonly<Record<string, unknown>>;
  };
  readonly dependabot: {
    readonly updates: readonly DependabotUpdateRule[];
    readonly npmGroups: Readonly<Record<string, DependabotNpmGroup>>;
  };
};

function normalizeUpdateRule(rule: DependabotUpdateRule): DependabotUpdateRule {
  return {
    packageEcosystem: rule.packageEcosystem,
    directory: rule.directory,
    interval: rule.interval ?? "weekly",
    ignore: rule.ignore ?? [],
  };
}

function areLayersEquivalent(
  existing: DevcontainerLayerHandle,
  candidate: DevcontainerLayerHandle,
): boolean {
  if (existing.dockerfilePath === candidate.dockerfilePath) {
    return true;
  }
  try {
    return (
      readFileSync(existing.dockerfilePath, "utf8") ===
      readFileSync(candidate.dockerfilePath, "utf8")
    );
  } catch {
    return false;
  }
}

/**
 * Merges `WorkspaceEnvironmentMeta` across all generated instances.
 * Ordered sets deduplicate preserving insertion order; key-value entries are
 * idempotent when deeply equal and fail fast with `CONFLICTING_ENVIRONMENT_METADATA`
 * on non-equivalent definitions.
 */
export function mergeWorkspaceEnvironmentMeta(
  instances: readonly GeneratedInstance<WorkspaceEnvironmentMeta>[],
):
  | { readonly ok: true; readonly merged: MergedWorkspaceEnvironmentMeta }
  | { readonly ok: false; readonly issues: readonly InvalidRequestIssue[] } {
  const issues: InvalidRequestIssue[] = [];

  const layers: DevcontainerLayerHandle[] = [];
  const layerById = new Map<string, DevcontainerLayerHandle>();
  const buildArgs: Record<string, string> = {};
  const mounts: DevcontainerMount[] = [];
  const mountByTarget = new Map<string, DevcontainerMount>();
  const containerEnv: Record<string, string> = {};

  const extensions: string[] = [];
  const seenExtensions = new Set<string>();
  const settings: Record<string, unknown> = {};

  const updates: DependabotUpdateRule[] = [];
  const updateByKey = new Map<string, DependabotUpdateRule>();
  const npmGroups: Record<string, DependabotNpmGroup> = {};

  for (const instance of instances) {
    const rawMeta = instance.definition.meta;
    if (rawMeta === undefined) {
      continue;
    }
    const meta = typeof rawMeta === "function" ? rawMeta(instance) : rawMeta;

    // .devcontainer
    for (const layer of meta.devcontainer?.layers ?? []) {
      const existing = layerById.get(layer.id);
      if (existing === undefined) {
        layerById.set(layer.id, layer);
        layers.push(layer);
      } else if (!areLayersEquivalent(existing, layer)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer layer "${layer.id}" declared by "${instance.path}": "${existing.dockerfilePath}" vs "${layer.dockerfilePath}".`,
        });
      }
    }

    for (const [key, value] of Object.entries(
      meta.devcontainer?.buildArgs ?? {},
    )) {
      if (Object.hasOwn(buildArgs, key) && buildArgs[key] !== value) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer build arg "${key}" declared by "${instance.path}": "${buildArgs[key]}" vs "${value}".`,
        });
      } else {
        buildArgs[key] = value;
      }
    }

    for (const mount of meta.devcontainer?.mounts ?? []) {
      const existing = mountByTarget.get(mount.target);
      if (existing === undefined) {
        mountByTarget.set(mount.target, mount);
        mounts.push(mount);
      } else if (!isDeepStrictEqual(existing, mount)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer mount for target "${mount.target}" declared by "${instance.path}".`,
        });
      }
    }

    for (const [key, value] of Object.entries(
      meta.devcontainer?.containerEnv ?? {},
    )) {
      if (Object.hasOwn(containerEnv, key) && containerEnv[key] !== value) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer containerEnv "${key}" declared by "${instance.path}": "${containerEnv[key]}" vs "${value}".`,
        });
      } else {
        containerEnv[key] = value;
      }
    }

    // .vscode
    for (const ext of meta.vscode?.extensions ?? []) {
      if (!seenExtensions.has(ext)) {
        seenExtensions.add(ext);
        extensions.push(ext);
      }
    }

    for (const [key, value] of Object.entries(meta.vscode?.settings ?? {})) {
      if (!Object.hasOwn(settings, key)) {
        settings[key] = Array.isArray(value) ? [...value] : value;
        continue;
      }
      const existing = settings[key];
      if (Array.isArray(existing) && Array.isArray(value)) {
        const mergedArray: unknown[] = [...existing];
        for (const item of value) {
          if (!mergedArray.some((entry) => isDeepStrictEqual(entry, item))) {
            mergedArray.push(item);
          }
        }
        settings[key] = mergedArray;
      } else if (!isDeepStrictEqual(existing, value)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting VS Code setting "${key}" declared by "${instance.path}".`,
        });
      }
    }

    // .github/dependabot.yml
    for (const rawUpdate of meta.dependabot?.updates ?? []) {
      const normalized = normalizeUpdateRule(rawUpdate);
      const key = `${normalized.packageEcosystem}\u0000${normalized.directory}`;
      const existing = updateByKey.get(key);
      if (existing === undefined) {
        updateByKey.set(key, normalized);
        updates.push(normalized);
      } else if (!isDeepStrictEqual(existing, normalized)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting Dependabot update for "${normalized.packageEcosystem}" at "${normalized.directory}" declared by "${instance.path}".`,
        });
      }
    }

    for (const [groupName, groupDef] of Object.entries(
      meta.dependabot?.npmGroups ?? {},
    )) {
      if (
        Object.hasOwn(npmGroups, groupName) &&
        !isDeepStrictEqual(npmGroups[groupName], groupDef)
      ) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting Dependabot npm group "${groupName}" declared by "${instance.path}".`,
        });
      } else {
        npmGroups[groupName] = groupDef;
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    merged: {
      devcontainer: { layers, buildArgs, mounts, containerEnv },
      vscode: { extensions, settings },
      dependabot: { updates, npmGroups },
    },
  };
}

/** Shared devcontainer Playwright browser layer and build argument for browser-tested packages. */
export function browserTestDevcontainerMeta(
  templatesRoot?: string,
): StaticWorkspaceEnvironmentMeta {
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  const playwrightVersion = resolvePlaywrightVersion(templatesRoot);

  return {
    devcontainer: {
      layers: [
        {
          id: "browser-test",
          dockerfilePath: path.join(
            workspaceRootRefDir,
            "resources",
            "environment",
            "devcontainer",
            "browser-test.Dockerfile",
          ),
        },
      ],
      buildArgs: {
        PLAYWRIGHT_CLI_PACKAGE: `@playwright/test@${playwrightVersion}`,
      },
    },
  };
}

/** Shared VS Code extension set for Vue + Tailwind + Vitest frontend packages. */
export const frontendVscodeMeta: StaticWorkspaceEnvironmentMeta = {
  vscode: {
    extensions: ["Vue.volar", "bradlc.vscode-tailwindcss", "vitest.explorer"],
  },
};
