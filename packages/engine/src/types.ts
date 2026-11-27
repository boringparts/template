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

/** Closed set of devcontainer Dockerfile snippet layers supported by the workspace base. */
export type DevcontainerLayer =
  | "github-cli"
  | "browser-test"
  | "shellcheck"
  | "rust-toolchain";

/** Closed set of VS Code editor capability groups declared by workspace-root. */
export type EditorCapability =
  | "oxc-format-lint"
  | "vue"
  | "tailwind"
  | "rust-tooling"
  | "vitest";

/** Package-internal physical file mapping relative to the reference package directory. */
export type ReferenceFileHandle = {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly executable?: boolean;
};

/** Static file from a reference package projected verbatim to the target repository root. */
export type RootStaticFileHandle = {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly executable?: boolean;
};

/**
 * Pure declarative handle to a checked native reference package.
 * Contains no arbitrary source text fields; all content comes from `packageDir`.
 */
export type ReferencePackage = {
  readonly packageName: string;
  readonly packageDir: string;
  readonly role: PackageRole;
  readonly publishable: boolean;
  readonly rewriteBinName?: boolean;
  readonly rustPackageName?: string;
  readonly files: readonly ReferenceFileHandle[];
  readonly rootFiles?: readonly RootStaticFileHandle[];
};

export type PresetTopology = "configurable-primary-package" | "fixed";

export type WorkspaceCollection = "packages" | "apps" | "crates";

export type PresetNode = {
  readonly nodeId: string;
  readonly reference: ReferencePackage;
  readonly defaultName: string;
  readonly defaultCollection: WorkspaceCollection;
  readonly defaultPath: string;
  /** Maps a reference package name (e.g. `@boringparts/reference-hono-api`) to a sibling `nodeId`. */
  readonly internalBindings?: Readonly<Record<string, string>>;
  /** Optional relative path replacements inside text files (e.g. `references/vike-web` -> `apps/web`). */
  readonly pathReplacements?: Readonly<Record<string, string>>;
};

/** Closed root-workspace capability declarations understood natively by the monorepo engine. */
export type PresetWorkspaceCapabilities = {
  readonly devcontainerLayers?: readonly DevcontainerLayer[];
  readonly editorCapabilities?: readonly EditorCapability[];
  readonly rustWorkspace?: boolean;
  readonly rootDockerDependabot?: boolean;
  readonly cargoDependabot?: boolean;
  readonly rootDevDelegateNodeId?: string;
  readonly allowBuilds?: readonly string[];
  readonly pnpmOverrides?: readonly string[];
};

export type PresetDefinition = {
  readonly alias: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly nodes: readonly PresetNode[];
  readonly capabilities: PresetWorkspaceCapabilities;
};

export type PresetSummary = {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly topology: PresetTopology;
  readonly roles: readonly PackageRole[];
};

/** Physical paths to the shared monorepo base assets and root policy files. */
export type WorkspaceTemplateRoots = {
  readonly toolingConfigDir: string;
  readonly workspaceRootRefDir: string;
  readonly npmPublicationRefDir: string;
  readonly rootPackageJsonPath: string;
  readonly rootPnpmWorkspaceYamlPath: string;
  readonly rootRustToolchainPath: string;
  readonly rootOxfmtConfigPath: string;
  readonly rootOxlintConfigPath: string;
  readonly rustLayerDockerfilePath?: string;
};

export type GeneratedInstance = {
  readonly presetAlias: string;
  readonly nodeId: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly path: string;
  readonly reference: ReferencePackage;
  /** Maps reference package names (including self and internal bindings) to instantiated package names. */
  readonly packageBindings: ReadonlyMap<string, string>;
  /** Optional text replacements for relative reference paths. */
  readonly pathReplacements: ReadonlyMap<string, string>;
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
  readonly instances: readonly GeneratedInstance[];
  readonly links: readonly ProjectLink[];
  readonly capabilities: {
    readonly hasPublishable: boolean;
    readonly rustWorkspace: boolean;
    readonly rootDockerDependabot: boolean;
    readonly cargoDependabot: boolean;
    readonly devcontainerLayers: readonly DevcontainerLayer[];
    readonly editorCapabilities: readonly EditorCapability[];
    readonly allowBuilds: readonly string[];
    readonly pnpmOverrides: readonly string[];
    readonly rootDevFilterPackage?: string;
  };
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
  | "INVALID_LINK_SPEC"
  | "UNSUPPORTED_LINK";

export type InvalidRequestIssue = {
  readonly code: InvalidRequestIssueCode;
  readonly message: string;
};

export type PlanProjectRequest = {
  readonly cwd: string;
  readonly dir: string;
  readonly presetSpecs: readonly string[];
  readonly linkSpecs: readonly string[];
  readonly scope?: string;
  readonly presets: readonly PresetDefinition[];
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
