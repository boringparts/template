import { readFile } from "node:fs/promises";
import path from "node:path";

import { contentIdentityKey } from "@boringparts/template-core/content-identity";
import type { GenerationRecord } from "@boringparts/template-core/generation-record";
import {
  type BlueprintPackageIdentityIssue,
  validateProjectBlueprint,
  type ProjectBlueprint,
} from "@boringparts/template-core/project-blueprint";
import {
  type ProjectProjectionAction,
  type ProjectProjectionConflict,
  type ProjectProjectionSource,
} from "@boringparts/template-core/project-projection";
import { releaseToolchainSnapshot } from "@boringparts/template-workspace/release-toolchain-snapshot";

import {
  validateInitializationInput,
  validatePackageAdditionInput,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
} from "./input-validation.ts";
import { cliGenerator, cliPresets, presetByAlias } from "./preset-catalog.ts";

export type ApplicationRuntime = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

export type InitCommandOptions = {
  readonly dir: string;
  readonly preset: string;
  readonly dryRun: boolean;
  readonly todo: boolean;
  readonly name?: string;
  readonly path?: string;
  readonly scope?: string;
};

export type AddPackageCommandOptions = {
  readonly preset: string;
  readonly name: string;
  readonly path?: string;
  readonly linkFrom: readonly string[];
  readonly dryRun: boolean;
};

type ResolvedInitialization = {
  readonly preset: string;
  readonly topology: "configurable-primary-package" | "fixed";
  readonly packages: readonly {
    readonly name: string;
    readonly path: string;
  }[];
  readonly scope: string;
};

export type InitCommandResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly targetDir: string;
      readonly resolved: ResolvedInitialization;
      readonly blueprint: ProjectBlueprint;
      readonly generationRecord: GenerationRecord;
      readonly toolchain: ReturnType<typeof toolchainReport>;
      readonly nextSteps: readonly { readonly display: string }[];
      readonly followUpDocument: {
        readonly enabled: boolean;
        readonly path?: string;
      };
    }
  | {
      readonly status: "usage-error";
      readonly targetDir: string;
      readonly issues: readonly InitializationInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly targetDir: string;
      readonly error: { readonly message: string; readonly suggestion: string };
    };

type PresetCatalogEntry = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
};

export type PresetCatalogCommandResult = {
  readonly status: "success";
  readonly presets: readonly PresetCatalogEntry[];
};

export type BlueprintValidationCommandResult =
  | {
      readonly status: "success";
      readonly path: string;
    }
  | {
      readonly status: "invalid";
      readonly path: string;
      readonly issues: readonly {
        readonly path: string;
        readonly message: string;
      }[];
    }
  | {
      readonly status: "operation-failure";
      readonly path: string;
      readonly reason:
        | "not-found"
        | "permission-denied"
        | "not-a-file"
        | "unreadable"
        | "invalid-json";
      readonly error: {
        readonly message: string;
        readonly suggestion: string;
      };
    };

type PackageAdditionCoreConflict = Omit<
  ProjectProjectionConflict,
  "before" | "current" | "after" | "sources"
> & {
  readonly sources?: ProjectProjectionSource[];
  readonly context: {
    readonly before: string;
    readonly current: string;
    readonly after: string;
  };
};

type PackageAdditionIdentityConflict = {
  readonly kind: "identity";
  readonly existing: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >["existing"];
  readonly requested: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >["requested"];
};

type PackageAdditionConflict =
  | PackageAdditionCoreConflict
  | PackageAdditionIdentityConflict;

export type PackageAdditionCommandResult =
  | {
      readonly status: "success";
      readonly dryRun: boolean;
      readonly actions: readonly ProjectProjectionAction[];
    }
  | {
      readonly status: "conflict";
      readonly dryRun: boolean;
      readonly actions: readonly [];
      readonly conflicts: readonly PackageAdditionConflict[];
    }
  | {
      readonly status: "usage-error";
      readonly issues: readonly PackageAdditionInputIssue[];
    }
  | {
      readonly status: "operation-failure";
      readonly error: { readonly message: string; readonly suggestion: string };
    };

/** Lists all built-in presets from the bundled content collection in declaration order. */
export function listPresetCatalog(): PresetCatalogCommandResult {
  return {
    status: "success",
    presets: cliPresets.map(({ definition }) => ({
      name: definition.metadata.alias,
      title: definition.metadata.title,
      description: definition.metadata.description,
    })),
  };
}

/** Reports the immutable release toolchain snapshot shipped with the CLI without online resolution. */
function toolchainReport() {
  return {
    nodeVersion: releaseToolchainSnapshot.nodeVersion,
    packageManagerPin: releaseToolchainSnapshot.packageManagerPin,
  };
}

function packageAdditionConflict(
  conflict: ProjectProjectionConflict,
): PackageAdditionCoreConflict {
  const { before, current, after, sources, ...details } = conflict;
  return {
    ...details,
    ...(sources === undefined ? {} : { sources: [...sources] }),
    context: { before, current, after },
  };
}

function packageAdditionIdentityConflict(
  conflict: Extract<
    BlueprintPackageIdentityIssue,
    { readonly kind: "duplicate" }
  >,
): PackageAdditionIdentityConflict {
  return {
    kind: "identity",
    existing: conflict.existing,
    requested: conflict.requested,
  };
}

function samePackageIdentityConflict(
  left: PackageAdditionIdentityConflict,
  right: PackageAdditionIdentityConflict,
): boolean {
  return (
    left.existing.name === right.existing.name &&
    left.existing.path === right.existing.path &&
    left.existing.role === right.existing.role &&
    left.requested.name === right.requested.name &&
    left.requested.path === right.requested.path &&
    left.requested.role === right.requested.role
  );
}

/** Reads and validates a project blueprint file relative to `runtime.cwd` without modifying disk state. */
export async function validateBlueprintFile(
  filePath: string,
  runtime: ApplicationRuntime,
): Promise<BlueprintValidationCommandResult> {
  const resolvedPath = path.resolve(runtime.cwd, filePath);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    return readBlueprintFailure(resolvedPath, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return {
      status: "operation-failure",
      path: resolvedPath,
      reason: "invalid-json",
      error: {
        message: "Invalid blueprint JSON.",
        suggestion:
          "Fix the JSON syntax and validate again; if the file origin is unclear, inspect it manually.",
      },
    };
  }
  const result = validateProjectBlueprint(value);
  if (!result.ok) {
    return {
      status: "invalid",
      path: resolvedPath,
      issues: result.issues,
    };
  }
  return {
    status: "success",
    path: resolvedPath,
  };
}

function readBlueprintFailure(
  filePath: string,
  error: unknown,
): Extract<
  BlueprintValidationCommandResult,
  { readonly status: "operation-failure" }
> {
  const errorCode =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const [reason, message, suggestion]: readonly [
    Extract<
      BlueprintValidationCommandResult,
      { readonly status: "operation-failure" }
    >["reason"],
    string,
    string,
  ] =
    errorCode === "ENOENT"
      ? [
          "not-found",
          "Blueprint file not found.",
          "Verify the file path and validate again.",
        ]
      : errorCode === "EACCES" || errorCode === "EPERM"
        ? [
            "permission-denied",
            "Permission denied when reading the blueprint file.",
            "Grant read permission and validate again; if ownership is unclear, handle it manually.",
          ]
        : errorCode === "EISDIR" || errorCode === "ENOTDIR"
          ? [
              "not-a-file",
              "Blueprint target is not a readable file.",
              "Provide the path to a readable blueprint JSON file and validate again.",
            ]
          : [
              "unreadable",
              "Unable to read the blueprint file.",
              "Check the path, file permissions, and mount status, then retry.",
            ];
  return {
    status: "operation-failure",
    path: filePath,
    reason,
    error: { message, suggestion },
  };
}

function initOperationFailure(options: {
  readonly targetDir: string;
  readonly message?: string;
}): Extract<InitCommandResult, { readonly status: "operation-failure" }> {
  const fallbackMessage = "Initialization failed.";
  return {
    status: "operation-failure",
    targetDir: options.targetDir,
    error: {
      message:
        options.message === undefined
          ? fallbackMessage
          : safeGeneratorFailureMessage(options.message, fallbackMessage),
      suggestion:
        options.message === undefined
          ? "Check the target directory and runtime environment, then retry."
          : "Check the content package, declared resources, and target directory based on the error message, then retry.",
    },
  };
}

function safeGeneratorFailureMessage(
  message: string,
  fallback: string,
): string {
  const firstLine = message.split(/\r?\n/u, 1)[0]?.trim();
  if (firstLine === undefined || firstLine.length === 0) return fallback;
  return firstLine
    .replace(/file:\/\/\S+/gu, "<local module path>")
    .replace(/(^|[\s("'`])(?:[A-Za-z]:[\\/]|\/)[^\s"'`)]*/gu, "$1<local path>");
}

function initPackageIdentities(
  presetAlias: string,
  generationRecord: GenerationRecord,
  blueprint: ProjectBlueprint,
): ResolvedInitialization["packages"] {
  const preset = presetByAlias(presetAlias);
  if (preset === undefined) {
    throw new Error("Initialization preset missing during result mapping");
  }
  const selection = generationRecord.selections.find(
    (candidate) =>
      candidate.presetIdentity !== null &&
      contentIdentityKey(candidate.presetIdentity) ===
        contentIdentityKey(preset.identity),
  );
  if (selection === undefined) {
    throw new Error(
      "Generation result is missing package instances for the selected preset",
    );
  }
  return Object.entries(preset.definition.nodes).map(([nodeIdentity]) => {
    const packageDefinitionId = selection.nodes[nodeIdentity];
    if (packageDefinitionId === undefined) {
      throw new Error(
        `Generation result is missing a package instance for preset node: ${nodeIdentity}`,
      );
    }
    const record = generationRecord.packages.find(
      (candidate) => candidate.packageDefinitionId === packageDefinitionId,
    );
    if (record === undefined) {
      throw new Error(
        `Generation result is missing a package record for preset node: ${nodeIdentity}`,
      );
    }
    const definition = blueprint.packages.find(
      (candidate) =>
        candidate.packageDefinitionId === record.packageDefinitionId,
    );
    if (definition === undefined) {
      throw new Error(
        `Generation blueprint is missing a package definition for preset node: ${nodeIdentity}`,
      );
    }
    return {
      name: definition.name,
      path: definition.path,
    };
  });
}

/**
 * Plans and optionally commits repository initialization for a built-in preset.
 *
 * Writes nothing when `options.dryRun` is `true` or when validation, planning, or preconditions fail.
 */
export async function runInit(
  options: InitCommandOptions,
  runtime: ApplicationRuntime,
): Promise<InitCommandResult> {
  const targetDir = path.resolve(runtime.cwd, options.dir);
  const validation = validateInitializationInput({
    preset: options.preset,
    targetDir,
    overrides: {
      ...(options.name === undefined ? {} : { name: options.name }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    },
  });
  if (validation.status === "input-invalid") {
    return {
      status: "usage-error",
      targetDir: options.dir,
      issues: validation.issues,
    };
  }
  const { preset, repositoryName, defaultPackageScope } = validation.value;
  const creationInput =
    options.name === undefined && options.path === undefined
      ? undefined
      : {
          ...(options.name === undefined ? {} : { leafName: options.name }),
          ...(options.path === undefined ? {} : { packagePath: options.path }),
        };
  const planned = await cliGenerator.planInit({
    targetRoot: targetDir,
    selection: {
      presets: [
        {
          contentIdentity: preset.identity,
          ...(creationInput === undefined ? {} : { creationInput }),
        },
      ],
    },
    conventions: { repositoryName, defaultPackageScope, todo: options.todo },
  });
  if (planned.status === "operation-failure") {
    return initializationFailureFromPlanning({
      targetDir: options.dir,
      message: planned.error.message,
      ...(planned.error.packageIdentityIssues === undefined
        ? {}
        : { packageIdentityIssues: planned.error.packageIdentityIssues }),
      inputOverrides: {
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
      },
    });
  }
  if (planned.status === "conflict") {
    return initOperationFailure({
      targetDir: options.dir,
      message: planned.reason,
    });
  }

  const result = options.dryRun
    ? { ...planned, status: "success" as const, dryRun: true }
    : await cliGenerator.commitPlan(planned.plan);
  if (result.status === "operation-failure") {
    return initOperationFailure({
      targetDir: options.dir,
      message: result.error.message,
    });
  }
  if (result.status === "conflict") {
    return initOperationFailure({
      targetDir: options.dir,
      message: result.reason,
    });
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    targetDir: options.dir,
    resolved: {
      preset: preset.definition.metadata.alias,
      topology:
        Object.keys(preset.definition.nodes).length === 1
          ? "configurable-primary-package"
          : "fixed",
      packages: initPackageIdentities(
        preset.definition.metadata.alias,
        result.generationRecord,
        result.blueprint,
      ),
      scope: defaultPackageScope,
    },
    blueprint: result.blueprint,
    generationRecord: result.generationRecord,
    toolchain: toolchainReport(),
    nextSteps: [
      { display: "pnpm install" },
      { display: "pnpm run fix" },
      { display: "pnpm run check" },
    ],
    followUpDocument: {
      enabled: options.todo,
      ...(options.todo ? { path: "TODO.md" } : {}),
    },
  };
}

function initializationFailureFromPlanning(options: {
  readonly targetDir: string;
  readonly message: string;
  readonly packageIdentityIssues?: readonly BlueprintPackageIdentityIssue[];
  readonly inputOverrides: {
    readonly name?: string;
    readonly scope?: string;
  };
}): InitCommandResult {
  const identityIssues = options.packageIdentityIssues ?? [];
  const issues = identityIssues.map((issue) => {
    if (issue.kind === "duplicate") {
      return { code: "CONFLICTING_PACKAGE_IDENTITY" as const };
    }
    if (issue.field === "name") {
      return {
        code:
          options.inputOverrides.name !== undefined
            ? ("INVALID_PACKAGE_NAME" as const)
            : options.inputOverrides.scope !== undefined
              ? ("INVALID_PACKAGE_SCOPE" as const)
              : ("INVALID_REPOSITORY_SCOPE" as const),
      };
    }
    return {
      code:
        issue.kind === "reserved"
          ? ("RESERVED_PACKAGE_PATH" as const)
          : ("INVALID_PACKAGE_PATH" as const),
    };
  });
  if (issues.length > 0) {
    return {
      status: "usage-error",
      targetDir: options.targetDir,
      issues: issues.filter(
        (issue, index) =>
          issues.findIndex((candidate) => candidate.code === issue.code) ===
          index,
      ),
    };
  }
  return initOperationFailure(options);
}

function packageUpdateOperationFailure(
  diagnostic?: { readonly message: string; readonly suggestion: string },
  message?: string,
  fallbackMessage = "Package addition operation failed.",
): Extract<
  PackageAdditionCommandResult,
  { readonly status: "operation-failure" }
> {
  return {
    status: "operation-failure",
    error: diagnostic ?? {
      message:
        message === undefined
          ? fallbackMessage
          : safeGeneratorFailureMessage(message, fallbackMessage),
      suggestion:
        message === undefined
          ? "Check the target repository and runtime environment, then retry."
          : "Check the target project configuration and directory contents, then retry.",
    },
  };
}

/**
 * Plans and optionally commits non-destructive package addition in the generated repository at `runtime.cwd`.
 *
 * Writes nothing when `options.dryRun` is `true` or when validation, conflicts, or operational failures occur.
 */
export async function runAddPackage(
  options: AddPackageCommandOptions,
  runtime: ApplicationRuntime,
): Promise<PackageAdditionCommandResult> {
  const validation = validatePackageAdditionInput({
    preset: options.preset,
    packageLeafName: options.name,
    linkFrom: options.linkFrom,
    ...(options.path === undefined ? {} : { packagePath: options.path }),
  });
  if (validation.status === "input-invalid") {
    return { status: "usage-error", issues: validation.issues };
  }
  const planned = await cliGenerator.planAdd({
    repositoryRoot: runtime.cwd,
    preset: validation.preset.identity,
    creationInput: {
      leafName: options.name,
      ...(options.path === undefined ? {} : { packagePath: options.path }),
      ...(validation.linkFrom.length === 0
        ? {}
        : { linkFrom: validation.linkFrom }),
    },
  });
  if (planned.status === "operation-failure") {
    const rootToolchainIssue = planned.error.rootToolchainIssue;
    if (rootToolchainIssue !== undefined) {
      return packageUpdateOperationFailure({
        message: safeGeneratorFailureMessage(
          planned.error.message,
          "Package addition requires a valid root toolchain declaration.",
        ),
        suggestion:
          rootToolchainIssue.kind === "invalid-node-declaration"
            ? "Fix devEngines.runtime in root package.json before adding a package."
            : "Fix packageManager in root package.json before adding a package.",
      });
    }
    const packageLinkIssue = planned.error.packageLinkIssue;
    if (packageLinkIssue !== undefined) {
      return {
        status: "usage-error",
        issues: [
          {
            code:
              packageLinkIssue.kind === "unknown-consumer"
                ? "UNKNOWN_LINK_FROM"
                : "UNSUPPORTED_LINK",
          },
        ],
      };
    }
    const identityIssues = planned.error.packageIdentityIssues ?? [];
    const identityConflicts = identityIssues
      .filter(
        (
          issue,
        ): issue is Extract<
          BlueprintPackageIdentityIssue,
          { readonly kind: "duplicate" }
        > => issue.kind === "duplicate",
      )
      .filter(
        (issue, index, issues) =>
          issues.findIndex((candidate) =>
            samePackageIdentityConflict(
              packageAdditionIdentityConflict(candidate),
              packageAdditionIdentityConflict(issue),
            ),
          ) === index,
      );
    if (identityConflicts.length > 0) {
      return {
        status: "conflict",
        dryRun: options.dryRun,
        actions: [],
        conflicts: identityConflicts.map(packageAdditionIdentityConflict),
      };
    }
    const usageIssues = identityIssues.map((issue) => ({
      code:
        issue.field === "name"
          ? ("INVALID_PACKAGE_NAME" as const)
          : issue.kind === "reserved"
            ? ("RESERVED_PACKAGE_PATH" as const)
            : ("INVALID_PACKAGE_PATH" as const),
    }));
    if (usageIssues.length > 0) {
      return {
        status: "usage-error",
        issues: usageIssues.filter(
          (issue, index) =>
            usageIssues.findIndex(
              (candidate) => candidate.code === issue.code,
            ) === index,
        ),
      };
    }
    return packageUpdateOperationFailure(undefined, planned.error.message);
  }
  if (planned.status === "conflict") {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: planned.conflicts.map(packageAdditionConflict),
    };
  }
  const result = options.dryRun
    ? { status: "success" as const, dryRun: true, actions: planned.actions }
    : await cliGenerator.commitPlan(planned.plan);
  if (result.status === "operation-failure") {
    return packageUpdateOperationFailure(undefined, result.error.message);
  }
  if (result.status === "conflict") {
    return {
      status: "conflict",
      dryRun: options.dryRun,
      actions: [],
      conflicts: result.conflicts.map(packageAdditionConflict),
    };
  }
  return {
    status: "success",
    dryRun: options.dryRun,
    actions: result.actions,
  };
}
