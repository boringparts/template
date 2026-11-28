import { isDeepStrictEqual } from "node:util";

import {
  normalizeRelativePackagePath,
  type SourceContext,
  type WorkspacePolicy,
} from "../sources/index.ts";
import type {
  InvalidRequestIssue,
  PackageInstance,
  WorkspaceRoot,
} from "./types.ts";

export type DevcontainerMount = {
  readonly type: "volume" | "bind" | "tmpfs";
  readonly source: string;
  readonly target: string;
};

/** Handle to a devcontainer Dockerfile fragment relative to its owning package's `sourceDir`. */
export type DevcontainerLayerHandle = {
  readonly id: string;
  readonly dockerfileSourcePath: string;
};

/** Merged devcontainer layer carrying the owning package `sourceDir` for synthesis reads. */
export type MergedDevcontainerLayer = DevcontainerLayerHandle & {
  readonly sourceDir: string;
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
 * Static root-converging workspace environment declaration.
 */
export type WorkspaceEnvironment = {
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

/** Read-only context supplied to functional `WorkspaceEnvironmentContributor` declarations. */
export type WorkspaceEnvironmentContext = {
  readonly instance: PackageInstance;
  readonly source: SourceContext;
  readonly workspacePolicy?: WorkspacePolicy;
};

/**
 * Environment contribution declared on a reference package (static or derived from context).
 */
export type WorkspaceEnvironmentContributor =
  | WorkspaceEnvironment
  | ((context: WorkspaceEnvironmentContext) => WorkspaceEnvironment);

export type MergedWorkspaceEnvironment = {
  readonly devcontainer: {
    readonly layers: readonly MergedDevcontainerLayer[];
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
  source: SourceContext,
  existing: MergedDevcontainerLayer,
  candidate: MergedDevcontainerLayer,
): boolean {
  if (
    existing.sourceDir === candidate.sourceDir &&
    existing.dockerfileSourcePath === candidate.dockerfileSourcePath
  ) {
    return true;
  }
  const existingText = source.tryReadPackageText(
    existing.sourceDir,
    existing.dockerfileSourcePath,
  );
  const candidateText = source.tryReadPackageText(
    candidate.sourceDir,
    candidate.dockerfileSourcePath,
  );
  return (
    existingText !== undefined &&
    candidateText !== undefined &&
    existingText === candidateText
  );
}

/**
 * Merges `WorkspaceEnvironment` declarations across `WorkspaceRoot` and all `PackageInstance`s.
 * Ordered sets deduplicate preserving insertion order; key-value entries are
 * idempotent when deeply equal and fail fast with `CONFLICTING_ENVIRONMENT_METADATA`
 * on non-equivalent definitions.
 */
export function mergeWorkspaceEnvironment(
  workspaceRoot: WorkspaceRoot,
  instances: readonly PackageInstance[],
  options: {
    readonly source: SourceContext;
    readonly workspacePolicy?: WorkspacePolicy;
  },
):
  | { readonly ok: true; readonly merged: MergedWorkspaceEnvironment }
  | { readonly ok: false; readonly issues: readonly InvalidRequestIssue[] } {
  const issues: InvalidRequestIssue[] = [];

  const layers: MergedDevcontainerLayer[] = [];
  const layerById = new Map<string, MergedDevcontainerLayer>();
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

  const contributors: readonly {
    readonly ownerLabel: string;
    readonly ownerSourceDir: string;
    readonly environment: WorkspaceEnvironment | undefined;
  }[] = [
    {
      ownerLabel: ".",
      ownerSourceDir: workspaceRoot.sourceDir,
      environment: workspaceRoot.environment,
    },
    ...instances.map((instance) => {
      const contributor = instance.referencePackage.environment;
      return {
        ownerLabel: instance.path,
        ownerSourceDir: instance.referencePackage.sourceDir,
        environment:
          typeof contributor === "function"
            ? contributor({
                instance,
                source: options.source,
                ...(options.workspacePolicy === undefined
                  ? {}
                  : { workspacePolicy: options.workspacePolicy }),
              })
            : contributor,
      };
    }),
  ];

  for (const { ownerLabel, ownerSourceDir, environment } of contributors) {
    if (environment === undefined) {
      continue;
    }

    const normalizedOwnerSourceDir =
      normalizeRelativePackagePath(ownerSourceDir);

    // .devcontainer
    for (const layer of environment.devcontainer?.layers ?? []) {
      const normalizedLayerPath = normalizeRelativePackagePath(
        layer.dockerfileSourcePath,
      );
      if (
        normalizedOwnerSourceDir === undefined ||
        normalizedLayerPath === undefined
      ) {
        issues.push({
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Devcontainer layer "${layer.id}" declared by "${ownerLabel}" escapes package directory: "${layer.dockerfileSourcePath}".`,
        });
        continue;
      }

      const candidateLayer: MergedDevcontainerLayer = {
        id: layer.id,
        dockerfileSourcePath: normalizedLayerPath,
        sourceDir: normalizedOwnerSourceDir,
      };

      const existing = layerById.get(layer.id);
      if (existing === undefined) {
        layerById.set(layer.id, candidateLayer);
        layers.push(candidateLayer);
      } else if (
        !areLayersEquivalent(options.source, existing, candidateLayer)
      ) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer layer "${layer.id}" declared by "${ownerLabel}": "${existing.sourceDir}/${existing.dockerfileSourcePath}" vs "${candidateLayer.sourceDir}/${candidateLayer.dockerfileSourcePath}".`,
        });
      }
    }

    for (const [key, value] of Object.entries(
      environment.devcontainer?.buildArgs ?? {},
    )) {
      if (Object.hasOwn(buildArgs, key) && buildArgs[key] !== value) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer build arg "${key}" declared by "${ownerLabel}": "${buildArgs[key]}" vs "${value}".`,
        });
      } else {
        buildArgs[key] = value;
      }
    }

    for (const mount of environment.devcontainer?.mounts ?? []) {
      const existing = mountByTarget.get(mount.target);
      if (existing === undefined) {
        mountByTarget.set(mount.target, mount);
        mounts.push(mount);
      } else if (!isDeepStrictEqual(existing, mount)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer mount for target "${mount.target}" declared by "${ownerLabel}".`,
        });
      }
    }

    for (const [key, value] of Object.entries(
      environment.devcontainer?.containerEnv ?? {},
    )) {
      if (Object.hasOwn(containerEnv, key) && containerEnv[key] !== value) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting devcontainer containerEnv "${key}" declared by "${ownerLabel}": "${containerEnv[key]}" vs "${value}".`,
        });
      } else {
        containerEnv[key] = value;
      }
    }

    // .vscode
    for (const ext of environment.vscode?.extensions ?? []) {
      if (!seenExtensions.has(ext)) {
        seenExtensions.add(ext);
        extensions.push(ext);
      }
    }

    for (const [key, value] of Object.entries(
      environment.vscode?.settings ?? {},
    )) {
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
          message: `Conflicting VS Code setting "${key}" declared by "${ownerLabel}".`,
        });
      }
    }

    // .github/dependabot.yml
    for (const rawUpdate of environment.dependabot?.updates ?? []) {
      const normalized = normalizeUpdateRule(rawUpdate);
      const key = `${normalized.packageEcosystem}\u0000${normalized.directory}`;
      const existing = updateByKey.get(key);
      if (existing === undefined) {
        updateByKey.set(key, normalized);
        updates.push(normalized);
      } else if (!isDeepStrictEqual(existing, normalized)) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting Dependabot update for "${normalized.packageEcosystem}" at "${normalized.directory}" declared by "${ownerLabel}".`,
        });
      }
    }

    for (const [groupName, groupDef] of Object.entries(
      environment.dependabot?.npmGroups ?? {},
    )) {
      if (
        Object.hasOwn(npmGroups, groupName) &&
        !isDeepStrictEqual(npmGroups[groupName], groupDef)
      ) {
        issues.push({
          code: "CONFLICTING_ENVIRONMENT_METADATA",
          message: `Conflicting Dependabot npm group "${groupName}" declared by "${ownerLabel}".`,
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
