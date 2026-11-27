import type { Composition } from "@boringparts/template-core/composition";
import type { PackageDefinitionId } from "@boringparts/template-core/project-blueprint";
import { createGenerator } from "@boringparts/template-generator";
import {
  deriveTemplateMembers,
  templateContent,
} from "@fixture/content-contract";

const derived = deriveTemplateMembers(templateContent);
const reference = derived.referencePackages.find(
  (member) => member.alias === "contract-reference",
);
const selectedPreset = derived.presets.find(
  (member) => member.alias === "contract-preset",
);
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Content contract fixture is incomplete");
  }
  return value;
}
const requiredReference = required(reference);
const preset = required(selectedPreset);

const authorMarker: "reference-extension-v1" | "reference-extension-v2" =
  requiredReference.definition.authorExtension.marker;
const authorFormat: "reference-format-v1" | "reference-format-v2" =
  requiredReference.definition.authorExtension.describe().format;
const preparedRevision: "reference-prepared-v1" | "reference-prepared-v2" =
  requiredReference.definition.prepare().facts.revision;
const presetTitle: string = preset.definition.metadata.title;
const presetChannel: "preset-extension-v2" =
  preset.definition.authorExtension.channel;
const presetFlavor: "neutral-project-v2" =
  preset.definition.authorExtension.describe().flavor;
const presetCreationInput: string | undefined =
  preset.definition.nodes.library.creationInput?.init?.projectName;

for (const member of derived.referencePackages) {
  if (member.definition.revision === "reference-extension-v1") {
    if (member.identity.namespace !== "alpha") {
      throw new Error("Unexpected origin namespace for v1 reference package");
    }
    const marker: "reference-extension-v1" =
      member.definition.authorExtension.marker;
    const format: "reference-format-v1" =
      member.definition.authorExtension.describe().format;
    const revision: "reference-prepared-v1" =
      member.definition.prepare().facts.revision;
    void marker;
    void format;
    void revision;
  } else {
    if (member.identity.namespace !== "beta") {
      throw new Error("Unexpected origin namespace for v2 reference package");
    }
    const marker: "reference-extension-v2" =
      member.definition.authorExtension.marker;
    const revision: "reference-prepared-v2" =
      member.definition.prepare().facts.revision;
    // @ts-expect-error Different origin revisions of the same package preserve distinct extension types.
    const wrongRevision: "reference-extension-v1" =
      member.definition.authorExtension.marker;
    void marker;
    void revision;
    void wrongRevision;
  }
}

function proveNegativeTypes(): void {
  const wrongReferenceExtension: string =
    // @ts-expect-error Reference package extensions belong only to reference package definitions.
    preset.definition.authorExtension.marker;
  const wrongPresetExtension: string =
    // @ts-expect-error Preset extensions belong only to preset definitions.
    requiredReference.definition.authorExtension.channel;
  // @ts-expect-error Derived reference package members preserve author-prepared fact types.
  const wrongPreparedFacts: number =
    requiredReference.definition.prepare().facts.revision;
  // @ts-expect-error Preset metadata preserves string types.
  const wrongPresetTitle: number = preset.definition.metadata.title;
  void wrongReferenceExtension;
  void wrongPresetExtension;
  void wrongPreparedFacts;
  void wrongPresetTitle;

  void generator.prepareProject({
    selection: {},
    conventions: {},
    // @ts-expect-error Composition accepts only declared operation facts.
    operationFacts: { providerVersion: 7, operation: "initialization" },
  });
  void generator.prepareProject({
    selection: {
      roots: [
        {
          nodeIdentity: "bad",
          contentIdentity: requiredReference.identity,
          // @ts-expect-error Creation input is inferred from the selected reference package parser.
          creationInput: { projectName: 7 },
        },
      ],
    },
    conventions: {},
    operationFacts: {
      providerVersion: "provider-v2",
      operation: "initialization",
    },
  });
  void generator.add({
    repositoryRoot: "/tmp/content-contract",
    contentIdentity: requiredReference.identity,
    creationInput: {
      // @ts-expect-error Native add entry inherits creation input from the selected reference package.
      projectName: 7,
    },
    operationFacts: {
      providerVersion: "provider-v2",
      // @ts-expect-error add accepts only declared operation kinds.
      operation: "update",
    },
  });
}

type Conventions = { readonly policy: "neutral" };
type CreationInput = ReturnType<
  typeof requiredReference.definition.parseCreationInput
>;
type StableCommon = {
  readonly edition: string;
  readonly providerVersion: string;
};
type PackageInput = { readonly providerVersion: string };
type ContributionFacts = {
  readonly kind: "contract-contribution";
  readonly projectName: string;
  readonly providerVersion: string;
  readonly ownerRevision: "reference-prepared-v1" | "reference-prepared-v2";
};
type OwnerFacts = { readonly packageCount: number };
type OperationFacts = {
  readonly providerVersion: string;
  readonly operation: "initialization" | "addition";
};

const composition: Composition<
  Conventions,
  StableCommon,
  PackageInput,
  ContributionFacts,
  OwnerFacts,
  CreationInput,
  OperationFacts
> = {
  identity: {
    namespace: "contract",
    packageName: "@fixture/content-contract-composition",
    exportPath: "./composition",
  },
  parseConventions(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("policy" in value) ||
      value.policy !== "neutral"
    ) {
      throw new Error("Invalid conventions");
    }
    return { policy: "neutral" };
  },
  resolve({ conventions, operationFacts, packages }) {
    const packageInputs = new Map<PackageDefinitionId, PackageInput>();
    for (const packageDefinition of packages) {
      packageInputs.set(packageDefinition.packageDefinitionId, {
        providerVersion: operationFacts.providerVersion,
      });
    }
    return {
      stableCommon: {
        edition: conventions.policy,
        providerVersion: operationFacts.providerVersion,
      },
      packageInputs,
    };
  },
  combine({ packages }) {
    return { facts: { packageCount: packages.length } };
  },
};

const generator = createGenerator({ content: templateContent, composition });
const calculated = await generator.prepareProject({
  selection: {
    presets: [{ contentIdentity: preset.identity }],
  },
  conventions: { policy: "neutral" },
  operationFacts: {
    providerVersion: "provider-v2",
    operation: "initialization",
  },
});
const result = generator.computeProject(calculated);
const ownerPackageCount: number = result.ownerFacts.packageCount;
const generatedContribution = result.packages[0];
if (generatedContribution === undefined) {
  throw new Error("Computed result is missing a package contribution");
}
const contributionKind: "contract-contribution" =
  generatedContribution.contribution.facts.kind;
const contributionOwnerRevision:
  | "reference-prepared-v1"
  | "reference-prepared-v2" =
  generatedContribution.contribution.facts.ownerRevision;

void authorMarker;
void authorFormat;
void preparedRevision;
void presetTitle;
void presetChannel;
void presetFlavor;
void presetCreationInput;
void ownerPackageCount;
void contributionKind;
void contributionOwnerRevision;
void proveNegativeTypes;

export async function runContentContractInitialization(targetRoot: string) {
  const preparedResources = requiredReference.definition
    .prepare()
    .resources.map(({ path, content }) => ({
      path,
      content: new TextDecoder().decode(content),
    }));
  const planned = await generator.planInit({
    targetRoot,
    selection: { presets: [{ contentIdentity: preset.identity }] },
    conventions: { policy: "neutral" },
    operationFacts: {
      providerVersion: "provider-v2",
      operation: "initialization",
    },
  });
  if (planned.status !== "planned") {
    throw new Error(`Planning failed: ${JSON.stringify(planned)}`);
  }
  const plannedOwnerCount: number = planned.ownerFacts.packageCount;
  const committed = await generator.commitPlan(planned.plan);
  if (committed.status !== "success") {
    throw new Error(`Commit failed: ${JSON.stringify(committed)}`);
  }
  return {
    packagePaths: committed.blueprint.packages.map(({ path }) => path),
    ownerPackageCount: committed.ownerFacts.packageCount,
    plannedOwnerCount,
    preparedResources,
    references: derived.referencePackages.map(({ identity, definition }) => ({
      namespace: identity.namespace,
      packageName: identity.packageName,
      revision: definition.authorExtension.marker,
    })),
  };
}

export async function runContentContractAddition(targetRoot: string) {
  const result = await generator.add({
    repositoryRoot: targetRoot,
    contentIdentity: requiredReference.identity,
    creationInput: { projectName: "contract-added" },
    operationFacts: {
      providerVersion: "provider-v3",
      operation: "addition",
    },
  });
  if (result.status === "success") {
    const packagePaths = new Map(
      result.blueprint.packages.map(({ packageDefinitionId, path }) => [
        packageDefinitionId,
        path,
      ]),
    );
    return {
      status: result.status,
      packagePaths: result.blueprint.packages.map(({ path }) => path),
      packageCount: result.generationRecord.packages.length,
      ownerPackageCount: result.ownerFacts.packageCount,
      additions: result.generationRecord.packages
        .filter(({ createdBy }) => createdBy === "addition")
        .map(({ packageDefinitionId, contentIdentity, creationInput }) => ({
          path: packagePaths.get(packageDefinitionId),
          namespace: contentIdentity.namespace,
          packageName: contentIdentity.packageName,
          creationInput,
        })),
      references: derived.referencePackages.map(({ identity, definition }) => ({
        namespace: identity.namespace,
        packageName: identity.packageName,
        revision: definition.authorExtension.marker,
      })),
    };
  }
  if (result.status === "conflict") {
    return {
      status: result.status,
      conflictCount: result.conflicts.length,
      actions: result.actions,
    };
  }
  return {
    status: result.status,
    phase: result.phase,
    error: result.error.message,
  };
}
