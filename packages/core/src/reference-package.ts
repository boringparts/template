import {
  type ContentIdentity,
  type ContentSelector,
  type LoadedContentMember,
} from "./content-identity.ts";
import type { JsonValue } from "./json.ts";
import type { PackageContribution } from "./package-contribution.ts";
import type {
  PackageDefinition,
  PackageDefinitionId,
  PersistedPackageDefinition,
} from "./project-blueprint.ts";

export type ResourceFileSnapshot = {
  /** Canonical path relative to the owning reference package. */
  readonly path: string;
  readonly content: Uint8Array;
  readonly mode: number;
};

export type PreparedReference<Facts = JsonValue> = {
  readonly resources: readonly ResourceFileSnapshot[];
  readonly facts: Facts;
};

/** Reads UTF-8 text from an explicit resource snapshot without accessing the author directory on disk. */
export function readTextResource(
  prepared: PreparedReference,
  resourcePath: string,
): string {
  const resource = prepared.resources.find(
    (item) => item.path === resourcePath,
  );
  if (resource === undefined) {
    throw new Error(`Resource snapshot does not contain file: ${resourcePath}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(resource.content);
  } catch (cause) {
    throw new Error(
      `Resource snapshot is not valid UTF-8 text: ${resourcePath}`,
      { cause },
    );
  }
}

export type ContentIdentityReferenceDependency<
  CreationInput extends JsonValue = JsonValue,
> = {
  /** Stable dependency requirement key owned by this content definition. */
  readonly key: string;
  readonly contentIdentity: ContentIdentity;
  readonly creationInput?: CreationInput;
};

/** Native dependency resolved through the owning package's public entry point, bound only within the same source namespace. */
export type OwnerLocalReferenceDependency<
  CreationInput extends JsonValue = JsonValue,
> = {
  /** Stable dependency requirement key owned by this content definition. */
  readonly key: string;
  readonly ownerLocal: {
    /** Canonical native package specifier and public subpath, e.g. @scope/tooling/template. */
    readonly specifier: string;
    /** Package resolver belonging to the declaring module (e.g. import.meta.resolve). */
    readonly resolve: (specifier: string) => string;
  };
  readonly creationInput?: CreationInput;
};

/** Dependency declaration using either a full canonical content identity or an owner-local public entry specifier. */
export type ReferenceDependency<CreationInput extends JsonValue = JsonValue> =
  | ContentIdentityReferenceDependency<CreationInput>
  | OwnerLocalReferenceDependency<CreationInput>;

export type PackageBinding = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly contentIdentity: ContentIdentity;
  readonly definition: PersistedPackageDefinition;
  readonly facts: unknown;
};

export type ReferencePackageEvaluationOptions<
  Conventions,
  CreationInput extends JsonValue,
  PreparedFacts,
  StableCommon,
  PackageInput,
> = {
  readonly packageDefinitionId: PackageDefinitionId;
  readonly definition: PersistedPackageDefinition;
  readonly createdBy: "initialization" | "addition" | "shared-dependency";
  readonly creationInput: CreationInput | undefined;
  readonly prepared: PreparedReference<PreparedFacts>;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
  readonly conventions: Conventions;
  readonly stableCommon: StableCommon;
  readonly packageInput: PackageInput | undefined;
};

/** Reference package contract: owns its resource preparation, dependencies, layout definition, and pure evaluation. */
export type ReferencePackageDefinition<
  Conventions = JsonValue,
  CreationInput extends JsonValue = JsonValue,
  PreparedFacts = JsonValue,
  StableCommon = JsonValue,
  PackageInput = JsonValue,
  ContributionFacts = JsonValue,
> = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
  prepare(options?: {
    /** Relative paths owned by nested packages inside this package's target directory, excluded before collecting resources. */
    readonly excludedPackagePaths: readonly string[];
  }):
    | PreparedReference<PreparedFacts>
    | Promise<PreparedReference<PreparedFacts>>;
  /** Public dependencies and stable requirement keys declared by this reference package. */
  readonly dependencies?: readonly ReferenceDependency<CreationInput>[];
  parseCreationInput(value: unknown): CreationInput;
  createDefinition(options: {
    readonly conventions: Conventions;
    readonly creationInput: CreationInput | undefined;
    readonly layout?: unknown;
  }): PackageDefinition;
  evaluate(
    options: ReferencePackageEvaluationOptions<
      Conventions,
      CreationInput,
      PreparedFacts,
      StableCommon,
      PackageInput
    >,
  ): PackageContribution<ContributionFacts>;
};

export type ReferencePackage<
  Definition extends ReferencePackageDefinition = ReferencePackageDefinition,
> = LoadedContentMember<Definition, "reference">;

/** Explicit dependency binding target: a sibling node identity in this selection, or an existing packageDefinitionId during add. */
export type SelectionDependencyBindingTarget =
  | string
  | Readonly<{ readonly packageDefinitionId: PackageDefinitionId }>;

export type ReferenceSelectionRoot<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly nodeIdentity: string;
  readonly contentIdentity: ContentSelector;
  readonly dependencyBindings?: Readonly<
    Record<string, SelectionDependencyBindingTarget>
  >;
  readonly creationInput?: CreationInput;
  readonly layout?: unknown;
};

export type PresetReference = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
};

export type PresetSelectionDefinition<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly kind: "preset";
  readonly operations: readonly ("init" | "add")[];
  readonly nodes: Readonly<
    Record<
      string,
      {
        readonly reference: PresetReference;
        readonly dependencyBindings?: Readonly<Record<string, string>>;
        readonly layout?: unknown;
        readonly creationInput?: Partial<Record<"init" | "add", CreationInput>>;
      }
    >
  >;
};

export type PresetSelectionRequest<
  CreationInput extends JsonValue = JsonValue,
> = {
  readonly contentIdentity: ContentSelector;
  readonly creationInput?: CreationInput;
};
