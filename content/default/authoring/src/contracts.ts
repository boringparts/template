import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";
import type { ProjectProjectionMirrorSlot } from "@ykdz/template-core/project-projection";
import type { PackageBinding } from "@ykdz/template-core/reference-package";
import type { TemplateSourceHandle } from "@ykdz/template-core/template-source";
import type { NativeContentManifest } from "@ykdz/template-workspace-authoring/content-artifact";
import type { YAMLMap } from "yaml";

export type ReferencePackageManifest = NativeContentManifest & {
  readonly imports?: Readonly<Record<string, unknown>>;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

export type DefaultWorkspaceConventions = {
  readonly repositoryName: string;
  readonly defaultPackageScope: string;
  readonly todo?: boolean;
};

export type DefaultNativeDocument = {
  /** Path relative to the target package directory. */
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly mode: number;
  readonly scope: "package" | "composition";
  /** Source resource path retained for diagnostics and full identity attribution. */
  readonly sourcePath: string;
};

export type DefaultCompositionFile = {
  readonly mirrorSlots?: readonly ProjectProjectionMirrorSlot[];
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
  readonly sourcePath: string;
};

export type PackageBoundaryOwner = {
  readonly kind: "package-boundary";
  readonly path: string;
};

export type WorkspaceOrchestrationOwner = {
  readonly kind: "workspace-orchestration";
  readonly path: ".";
};

export type ComponentOwner = PackageBoundaryOwner | WorkspaceOrchestrationOwner;

export type PlaywrightBrowserAssetsEnvironmentNeed = {
  readonly kind: "playwright-browser-assets";
  readonly browser: "chromium";
  readonly owner: ComponentOwner;
};

export type ShellCheckEnvironmentNeed = {
  readonly kind: "shellcheck-command";
  readonly owner: ComponentOwner;
};

/** Requires the maintained Rust toolchain in both local and CI plans. */
export type RustToolchainEnvironmentNeed = {
  readonly kind: "rust-toolchain";
  readonly owner: ComponentOwner;
  readonly toolchain: "stable";
};

/** Used only for standalone deployment verification, outside regular check environments. */
export type DockerEngineEnvironmentNeed = {
  readonly kind: "docker-engine";
};

export type CheckEnvironmentNeed =
  | PlaywrightBrowserAssetsEnvironmentNeed
  | ShellCheckEnvironmentNeed
  | RustToolchainEnvironmentNeed;

export type DeploymentEnvironmentNeed = DockerEngineEnvironmentNeed;

export type EnvironmentNeedsMetadata = {
  readonly schemaVersion: 1;
  readonly check: readonly CheckEnvironmentNeed[];
  readonly deployment: readonly DeploymentEnvironmentNeed[];
};

/** Closed, owner-scoped native diagnostic artifact retained in CI. */
export type CiDiagnosticArtifactDeclaration = {
  readonly kind: "playwright" | "vitest-browser";
  readonly owner: ComponentOwner;
};

export type RustToolchainRequirement = {
  readonly toolchain: string;
  readonly components: readonly string[];
  readonly configurationText: string;
};

export type RustToolchainTarget = {
  readonly channel: string;
  readonly declaration: string;
};

export type ApplicationRequirements = {
  readonly rustToolchain?: RustToolchainRequirement & {
    readonly existingDeclaration?: string;
  };
};

export type DependencyEcosystem =
  | "npm"
  | "cargo"
  | "github-actions"
  | "docker"
  | "devcontainers"
  | "rust-toolchain";

export type DependabotDirectory = `/${string}`;

/** Bounded root-level dependency maintenance scope that content may request. */
export type DependencyMaintenancePolicy = {
  readonly ecosystems: readonly DependencyEcosystem[];
  readonly directories?: Partial<
    Record<DependencyEcosystem, DependabotDirectory>
  >;
  readonly extraDirectories?: Partial<
    Record<DependencyEcosystem, readonly DependabotDirectory[]>
  >;
  readonly interval: "weekly";
};

type SharedRootCiStep =
  | (Readonly<Record<string, unknown>> & {
      readonly id: string;
    })
  | YAMLMap;

/** Domain entries declared for shared root files without granting direct root file write access. */
export type SharedRootContribution = {
  readonly kind: "shared-root-files";
  readonly source: string;
  readonly manifest?: {
    readonly scripts?: Readonly<Record<string, string>>;
    readonly imports?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };
  readonly turboTasks?: Readonly<Record<string, unknown>>;
  readonly typescript?: {
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly include?: readonly string[];
  };
  readonly ciSteps?: readonly {
    readonly before?: string;
    readonly steps: readonly SharedRootCiStep[];
  }[];
  readonly ciJob?: {
    readonly name?: string;
    readonly timeoutMinutes?: number;
  };
  readonly environmentNeeds?: {
    readonly check?: readonly CheckEnvironmentNeed[];
    readonly deployment?: readonly DeploymentEnvironmentNeed[];
  };
  readonly dependencyMaintenance?: DependencyMaintenancePolicy;
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
};

export type DefaultRootDeclarationData = {
  /** Merged into the root only when selected content declares this template execution dependency. */
  readonly requiredTemplateDependency?: string;
  readonly manifest?: Readonly<{
    readonly scripts?: Readonly<Record<string, string>>;
    readonly imports?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  }>;
  readonly turboTasks?: Readonly<Record<string, unknown>>;
  /** Complete compiler options and ordered include globs for the root TypeScript project. */
  readonly typescript?: Readonly<{
    readonly compilerOptions?: Readonly<Record<string, unknown>>;
    readonly include?: readonly string[];
  }>;
  /** Concatenated in declaration order; must not be sorted because negation patterns are order-sensitive. */
  readonly gitignoreFragments?: readonly string[];
  /** Closed environment declarations required for root check and deployment runs. */
  readonly environmentNeeds?: Readonly<{
    readonly check?: readonly CheckEnvironmentNeed[];
    readonly deployment?: readonly DeploymentEnvironmentNeed[];
  }>;
  /** Consumed by the shared root file composer under conflict and provenance rules. */
  readonly ciJob?: SharedRootContribution["ciJob"];
  /** Preserves insertion anchors, declaration order, and step identities. */
  readonly ciSteps?: SharedRootContribution["ciSteps"];
  /** Projected into the root Dependabot configuration by workspace policy. */
  readonly dependencyMaintenance?: SharedRootContribution["dependencyMaintenance"];
  /** Diagnostic artifact declarations for the root CI workflow. */
  readonly ciDiagnosticArtifacts?: readonly CiDiagnosticArtifactDeclaration[];
  /** Shared workspace requirements declared by tool owners during preparation. */
  readonly applicationRequirements?: ApplicationRequirements;
  /** Exclusive native root files; validated for provenance and path conflicts during default composition. */
  readonly files?: readonly DefaultCompositionFile[];
};

export type DefaultReferencePreparedFacts<OwnerFacts = undefined> = {
  readonly nativeDocuments: readonly DefaultNativeDocument[];
  readonly ownerFacts: OwnerFacts;
};

/** Documents explicitly deferred to composition alongside this instance's current manifest facts. */
export type DefaultReferencePackageInput = {
  readonly deferredNativeDocumentPaths: readonly string[];
  readonly targetManifest: Readonly<Record<string, unknown>> | undefined;
  readonly existing: boolean;
};

export type ReferenceTemplateDependencyPurpose =
  | "target"
  | "template-execution"
  | "template-build";

export type ReferenceTemplateDependency = {
  readonly name: string;
  readonly purpose: ReferenceTemplateDependencyPurpose;
};

/** Native manifest dependency normalized by target consumption and template execution purposes. */
export type ReferenceDependencyUse = {
  readonly name: string;
  readonly purposes: readonly ReferenceTemplateDependencyPurpose[];
};

export type DefaultReferenceContributionFacts<OwnerFacts = unknown> = {
  readonly sourcePackageName: string;
  /** Complete target package.json native document; kept whole rather than split into patches before composition. */
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly exposure: {
    readonly exports: Readonly<Record<string, unknown>>;
    readonly imports: Readonly<Record<string, unknown>>;
  };
  /** Native documents that depend on cross-package results and are finalized only during composition. */
  readonly deferredNativeDocuments: readonly DefaultNativeDocument[];
  /** Snapshot scoped strictly to this instance, excluding facts from other packages in the graph. */
  readonly packageInput: DefaultReferencePackageInput | undefined;
  readonly nativeDocuments: readonly DefaultNativeDocument[];
  readonly compositionFiles: readonly DefaultCompositionFile[];
  readonly dependencyUses: readonly ReferenceDependencyUse[];
  readonly templateDependencies: readonly ReferenceTemplateDependency[];
  readonly foundation: Readonly<Record<string, unknown>>;
  readonly environmentNeeds: readonly (
    | CheckEnvironmentNeed
    | DeploymentEnvironmentNeed
  )[];
  readonly ciDiagnosticArtifacts: readonly CiDiagnosticArtifactDeclaration[];
  readonly rootDeclaration?: DefaultRootDeclarationData;
  readonly workspaceConfiguration?: {
    readonly kind: "typescript-workspace-configuration";
  };
  readonly referenceBindings: Readonly<Record<string, unknown>>;
  readonly ownerFacts: OwnerFacts;
};

export type NativeReferenceResourceMapping = {
  /** Resource path within the owning package. */
  readonly path: string;
  /** External resource handle resolved by the author through a public package entry point. */
  readonly source?: TemplateSourceHandle;
  /** Path within the target package; omit for composition resources outside the current package. */
  readonly targetPath?: string;
  /** Read only during owner preparation; not copied into the target package. */
  readonly prepareOnly?: boolean;
  /** Defaults to a regular file (0o644); owners must declare executable bits explicitly. */
  readonly mode?: number;
};

export type DefaultReferenceEvaluationContext<CreationInput, OwnerFacts> = {
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly ownerFacts: OwnerFacts;
  readonly stableCommon: unknown;
};

export type DefaultReferenceManifestTransformOptions<
  CreationInput,
  OwnerFacts,
> = {
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly definition: PackageDefinition;
  readonly conventions: DefaultWorkspaceConventions;
  readonly creationInput: CreationInput | undefined;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly stableCommon: unknown;
  readonly ownerFacts: OwnerFacts;
};

export type DefaultReferenceDocumentTransformOptions<
  CreationInput,
  OwnerFacts,
> = Omit<
  DefaultReferenceManifestTransformOptions<CreationInput, OwnerFacts>,
  "manifest"
> & {
  readonly path: string;
  readonly value: Readonly<Record<string, unknown>>;
};
