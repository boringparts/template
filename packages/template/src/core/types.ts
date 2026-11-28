import type { SourceContext, WorkspacePolicy } from "../sources/index.ts";
import type {
  WorkspaceEnvironment,
  WorkspaceEnvironmentContributor,
} from "./environment.ts";

/**
 * Package role in workspace dependency layering and target runtime boundaries.
 * Governs explicit link validation across packages.
 */
export type PackageRole =
  | "cli-tool"
  | "runtime-service"
  | "browser-app"
  | "shared-library"
  | "node-library"
  | "native-package";

/** Explicit remapping for a template resource file inside a package's `resources` directory. */
export type ResourceFileMapping = {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly executable?: boolean;
};

/** In-memory file contribution produced within a package instance's own directory boundary. */
export type PackageContribution = {
  readonly targetPath: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

/** Read-only workspace context provided to a package's optional file transform hook. */
export type PackageTransformContext = {
  readonly scope: string;
  readonly repositoryName: string;
  readonly instance: PackageInstance;
};

/**
 * Pure declarative handle to a checked native reference package.
 * Regular files are automatically discovered from `sourceDir` within a `SourceContext`;
 * `resources` only lists template assets from `resources/` that require explicit target remapping.
 */
export type ReferencePackage = {
  readonly sourceDir: string;
  readonly packageName?: string;
  readonly role: PackageRole;
  readonly publishable: boolean;
  readonly environment?: WorkspaceEnvironmentContributor;
  readonly resources?: readonly ResourceFileMapping[];
  readonly transformFiles?: (
    files: ReadonlyMap<string, PackageContribution>,
    context: PackageTransformContext,
  ) => ReadonlyMap<string, PackageContribution>;
};

/**
 * Declarative handle to the target monorepo's workspace root shell,
 * synthesized once in memory from checked root configuration, workspace policy,
 * and merged environment declarations.
 */
export type WorkspaceRoot = {
  readonly sourceDir: string;
  readonly packageName?: string;
  readonly resources?: readonly ResourceFileMapping[];
  readonly publicationResources?: readonly ResourceFileMapping[];
  readonly devcontainerBase?: {
    readonly dockerfileSourcePath: string;
    readonly templateSourcePath: string;
  };
  readonly environment?: WorkspaceEnvironment;
};

/** Declarative singleton subpackage automatically instantiated once per workspace. */
export type SingletonPackage = {
  readonly nodeId: string;
  readonly defaultName: string;
  readonly defaultPath: string;
  readonly singleton: true;
  readonly referencePackage: ReferencePackage;
};

export type PresetTopology = "configurable-primary-package" | "fixed";

export type PresetNode = {
  readonly nodeId: string;
  readonly referencePackage: ReferencePackage;
  readonly defaultName: string;
  readonly defaultPath: string;
  /** Maps an internal reference package name to a sibling `nodeId`. */
  readonly dependencyBindings?: Readonly<Record<string, string>>;
};

export type PresetDefinition = {
  readonly alias: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly nodes: readonly PresetNode[];
};

export type PresetSummary = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly roles: readonly PackageRole[];
};

/** Explicit template catalog combining a `SourceContext`, root, singletons, presets, and policy. */
export type TemplateCatalog = {
  readonly source: SourceContext;
  readonly workspaceRoot: WorkspaceRoot;
  readonly singletonPackages?: readonly SingletonPackage[];
  readonly presets: readonly PresetDefinition[];
  readonly workspacePolicy: WorkspacePolicy;
};

export type PackageInstance = {
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly singleton: boolean;
  readonly referencePackage: ReferencePackage;
  /** Maps reference package names (including self, bound singletons, and internal bindings) to instantiated names. */
  readonly dependencyBindings: ReadonlyMap<string, string>;
  /** Target package names added via explicit `--link`. */
  readonly linkedProviders: readonly string[];
};

export type ProjectLink = {
  readonly consumerPath: string;
  readonly providerPath: string;
  readonly consumerPackageName: string;
  readonly providerPackageName: string;
};

export type ProjectBlueprint = {
  readonly targetDir: string;
  readonly repositoryName: string;
  readonly scope: string;
  readonly workspaceRoot: WorkspaceRoot;
  readonly instances: readonly PackageInstance[];
  readonly links: readonly ProjectLink[];
};

export type ProjectProjectionEntry = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

export type ProjectProjection = {
  readonly blueprint: ProjectBlueprint;
  readonly entries: readonly ProjectProjectionEntry[];
  readonly toolchain: {
    readonly nodeVersion: string;
    readonly packageManagerPin: string;
  };
};

export const invalidRequestIssueCodes = [
  "PRESET_UNKNOWN",
  "FIXED_TOPOLOGY_OVERRIDE",
  "INVALID_PRESET_SPEC",
  "INVALID_PACKAGE_NAME",
  "INVALID_PACKAGE_PATH",
  "RESERVED_PACKAGE_PATH",
  "INVALID_PACKAGE_SCOPE",
  "INVALID_REPOSITORY_SCOPE",
  "CONFLICTING_PACKAGE_IDENTITY",
  "CONFLICTING_ENVIRONMENT_METADATA",
  "DIRECTORY_OWNERSHIP_VIOLATION",
  "INVALID_LINK_SPEC",
  "UNSUPPORTED_LINK",
] as const;

export type InvalidRequestIssueCode = (typeof invalidRequestIssueCodes)[number];

export type InvalidRequestIssue = {
  readonly code: InvalidRequestIssueCode;
  readonly message: string;
};

/** Structured planning/synthesis validation failure. */
export class ProjectValidationError extends Error {
  readonly issues: readonly InvalidRequestIssue[];

  constructor(issues: readonly InvalidRequestIssue[]) {
    super(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; "));
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

export type PlanProjectRequest = {
  readonly cwd: string;
  readonly dir: string;
  readonly presetSpecs: readonly string[];
  readonly linkSpecs?: readonly string[];
  readonly scope?: string;
  readonly source: SourceContext;
  readonly workspaceRoot: WorkspaceRoot;
  readonly singletonPackages?: readonly SingletonPackage[];
  readonly presets: readonly PresetDefinition[];
  readonly workspacePolicy?: WorkspacePolicy;
};

export type PlanProjectResult =
  | { readonly ok: true; readonly blueprint: ProjectBlueprint }
  | { readonly ok: false; readonly issues: readonly InvalidRequestIssue[] };

export type MaterializeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly targetDir: string;
      readonly error: {
        readonly message: string;
        readonly suggestion: string;
      };
    };
