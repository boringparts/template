/**
 * Package role in workspace dependency layering and target runtime boundaries.
 * Governs explicit `--link` validation across packages.
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

/** In-memory file contribution produced within an instance's own directory boundary. */
export type PackageFileContribution = {
  readonly targetPath: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

/** Rewritten manifest summary exposed read-only to package transform hooks. */
export type PackageManifestSummary = {
  readonly packageName: string;
  readonly path: string;
  readonly leafName: string;
  readonly role: PackageRole;
  readonly publishable: boolean;
  readonly hasDevScript: boolean;
  readonly binNames: readonly string[];
};

/** Read-only workspace context provided to a package's optional file transform hook. */
export type PackageTransformContext<TMeta = unknown> = {
  readonly scope: string;
  readonly repositoryName: string;
  readonly instance: GeneratedInstance<TMeta>;
  readonly instances: readonly GeneratedInstance<TMeta>[];
  readonly manifests: ReadonlyMap<string, PackageManifestSummary>;
  readonly rootBaseDir: string;
  readonly hasDevScript: boolean;
  readonly hasPublishable: boolean;
};

/**
 * Pure declarative handle to a checked native reference package.
 * Regular files are automatically discovered from `packageDir`; `resources` only
 * lists template assets from `resources/` that require explicit target remapping.
 */
export type PackageDefinition<TMeta = unknown> = {
  readonly packageName: string;
  readonly packageDir: string;
  readonly role: PackageRole;
  readonly publishable: boolean;
  readonly meta?: TMeta;
  readonly resources?: readonly ResourceFileMapping[];
  readonly validateWorkspace?: (
    instances: readonly GeneratedInstance<TMeta>[],
  ) => readonly InvalidRequestIssue[];
  readonly transformFiles?: (
    files: ReadonlyMap<string, PackageFileContribution>,
    context: PackageTransformContext<TMeta>,
  ) => ReadonlyMap<string, PackageFileContribution>;
};

export type PresetTopology = "configurable-primary-package" | "fixed";

export type WorkspaceCollection = "packages" | "apps" | "crates";

export type PresetNode<TMeta = unknown> = {
  readonly nodeId: string;
  readonly definition: PackageDefinition<TMeta>;
  readonly defaultName: string;
  readonly defaultCollection: WorkspaceCollection;
  readonly defaultPath: string;
  /** Maps a reference package name (e.g. `@boringparts/reference-hono-api`) to a sibling `nodeId`. */
  readonly dependencyBindings?: Readonly<Record<string, string>>;
};

export type PresetDefinition<TMeta = unknown> = {
  readonly alias: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly nodes: readonly PresetNode<TMeta>[];
};

export type PresetSummary = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly roles: readonly PackageRole[];
};

/** Base singleton package node (root `.` or shared `packages/tooling-config`). */
export type BasePackageNode<TMeta = unknown> = {
  readonly nodeId: string;
  readonly leafName: string;
  readonly path: string;
  readonly definition: PackageDefinition<TMeta>;
};

/** Physical paths to the shared monorepo base packages and root policy files. */
export type WorkspaceTemplateRoots<TMeta = unknown> = {
  readonly rootBaseDir: string;
  readonly basePackages: readonly BasePackageNode<TMeta>[];
  readonly rootPackageJsonPath: string;
  readonly rootPnpmWorkspaceYamlPath: string;
};

export type GeneratedInstance<TMeta = unknown> = {
  readonly kind: "base" | "package";
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly definition: PackageDefinition<TMeta>;
  /** Maps reference package names (including self, shared singletons, and internal bindings) to instantiated names. */
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

export type ProjectBlueprint<TMeta = unknown> = {
  readonly targetDir: string;
  readonly repositoryName: string;
  readonly scope: string;
  readonly instances: readonly GeneratedInstance<TMeta>[];
  readonly links: readonly ProjectLink[];
};

export type ProjectProjectionEntry = {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
};

export type ProjectProjection<TMeta = unknown> = {
  readonly blueprint: ProjectBlueprint<TMeta>;
  readonly entries: readonly ProjectProjectionEntry[];
  readonly toolchain: {
    readonly nodeVersion: string;
    readonly packageManagerPin: string;
  };
};

export type InvalidRequestIssueCode =
  | "PRESET_UNKNOWN"
  | "FIXED_TOPOLOGY_OVERRIDE"
  | "INVALID_PRESET_SPEC"
  | "INVALID_PACKAGE_NAME"
  | "INVALID_PACKAGE_PATH"
  | "RESERVED_PACKAGE_PATH"
  | "INVALID_PACKAGE_SCOPE"
  | "INVALID_REPOSITORY_SCOPE"
  | "CONFLICTING_PACKAGE_IDENTITY"
  | "CONFLICTING_ENVIRONMENT_METADATA"
  | "DIRECTORY_OWNERSHIP_VIOLATION"
  | "INVALID_LINK_SPEC"
  | "UNSUPPORTED_LINK";

export type InvalidRequestIssue = {
  readonly code: InvalidRequestIssueCode;
  readonly message: string;
};

/** Structured planning/synthesis validation failure returned as CLI `invalidRequest` (exit code `2`). */
export class ProjectValidationError extends Error {
  readonly issues: readonly InvalidRequestIssue[];

  constructor(issues: readonly InvalidRequestIssue[]) {
    super(issues.map((issue) => `[${issue.code}] ${issue.message}`).join("; "));
    this.name = "ProjectValidationError";
    this.issues = issues;
  }
}

export type PlanProjectRequest<TMeta = unknown> = {
  readonly cwd: string;
  readonly dir: string;
  readonly presetSpecs: readonly string[];
  readonly linkSpecs: readonly string[];
  readonly scope?: string;
  readonly presets: readonly PresetDefinition<TMeta>[];
  readonly basePackages?: readonly BasePackageNode<TMeta>[];
};

export type PlanProjectResult<TMeta = unknown> =
  | { readonly ok: true; readonly blueprint: ProjectBlueprint<TMeta> }
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
