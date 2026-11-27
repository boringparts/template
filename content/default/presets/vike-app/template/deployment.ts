import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CheckEnvironmentNeed,
  DeploymentEnvironmentNeed,
  DependencyMaintenancePolicy,
  DefaultCompositionFile,
  DefaultRootDeclarationData,
} from "@boringparts/default-content-authoring/contracts";
import {
  dockerEngineEnvironmentNeed,
  shellCheckEnvironmentNeed,
} from "@boringparts/default-content-authoring/environment-needs";
import type {
  DefaultPresetPackageEvaluation,
  DefaultPresetRootContributionOwner,
} from "@boringparts/default-content-authoring/preset-root-contribution";
import { databaseDependencyKey as migrationsDatabaseDependencyKey } from "@boringparts/reference-vike-migrations/template";
import { databaseDependencyKey as webDatabaseDependencyKey } from "@boringparts/reference-vike-web/template";
import { projectPnpmBootstrapDockerfile } from "@boringparts/reference-workspace-root/environment";
import type { CompositionPackage } from "@boringparts/template-core/composition";
import {
  contentIdentityKey,
  type ContentIdentity,
} from "@boringparts/template-core/content-identity";
import type { GenerationRecordSelection } from "@boringparts/template-core/generation-record";
import type { PackageDefinition } from "@boringparts/template-core/project-blueprint";
import type { CurrentProjectProjectionEntry } from "@boringparts/template-core/project-projection";
import type { PackageBinding } from "@boringparts/template-core/reference-package";
import type { ResourceFileSnapshot } from "@boringparts/template-core/reference-package";
import {
  resolveTemplateSource,
  createTemplateSourceHandle,
} from "@boringparts/template-core/template-source";
import type { NativeContentArtifactResource } from "@boringparts/template-workspace-authoring/content-artifact";
import { YAMLMap, parseDocument } from "yaml";

const deploymentDirectory = fileURLToPath(
  new URL("../resources/deployment/", import.meta.url),
);
const checkerPath = fileURLToPath(
  new URL("../scripts/check-standalone-deployment.ts", import.meta.url),
);

function packageResource(
  resourcePath: string,
  filePath: string,
  mode = 0o644,
): NativeContentArtifactResource {
  return {
    path: resourcePath,
    source: createTemplateSourceHandle(filePath),
    mode,
  };
}

/** Full resource declaration for artifact distribution; pure composition consumes only the snapshot produced by prepare. */
export const vikeDeploymentResources = [
  packageResource(
    "resources/deployment/Dockerfile",
    path.join(deploymentDirectory, "Dockerfile"),
  ),
  packageResource(
    "resources/deployment/container.dockerignore",
    path.join(deploymentDirectory, "container.dockerignore"),
  ),
  packageResource(
    "resources/deployment/scripts/container-entrypoint.sh",
    path.join(deploymentDirectory, "scripts/container-entrypoint.sh"),
    0o755,
  ),
  packageResource("scripts/check-standalone-deployment.ts", checkerPath),
  packageResource(
    "resources/deployment/setup-buildx-step.yml",
    path.join(deploymentDirectory, "setup-buildx-step.yml"),
  ),
] as const satisfies readonly NativeContentArtifactResource[];

type VikePackageContribution = {
  readonly package: CompositionPackage;
  readonly sourcePackageName: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly bindings: ReadonlyMap<string, PackageBinding>;
};

type VikePackageManifestFact = {
  /** Actual package.json path relative to the target workspace root. */
  readonly path: string;
  readonly manifest: Readonly<Record<string, unknown>>;
};

type VikeDeploymentResourceFacts = Readonly<{
  readonly dockerfile: string;
  readonly dockerfileMode: number;
  readonly dockerIgnore: string;
  readonly dockerIgnoreMode: number;
  readonly containerEntrypoint: Readonly<{
    readonly text: string;
    readonly mode: number;
  }>;
  readonly checkerSource: string;
  readonly checkerMode: number;
  readonly buildxStepSource: string;
}>;

export type VikeDeploymentOwnerFacts = Readonly<{
  readonly resources: VikeDeploymentResourceFacts;
  readonly manifests?: readonly VikePackageManifestFact[];
}>;

type VikePackageContributions = {
  readonly application: VikePackageContribution;
  readonly database: VikePackageContribution;
  readonly migrations: VikePackageContribution;
};

function scriptValue(
  manifest: Readonly<Record<string, unknown>>,
  name: string,
): unknown {
  const scripts = manifest.scripts;
  return typeof scripts === "object" &&
    scripts !== null &&
    !Array.isArray(scripts)
    ? (scripts as Record<string, unknown>)[name]
    : undefined;
}

function requiredTaskScripts(options: {
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): readonly {
  readonly definition: PackageDefinition;
  readonly names: readonly string[];
}[] {
  return [
    {
      definition: options.database,
      names: ["build", "db:reset", "db:seed:example", "test"],
    },
    { definition: options.migrations, names: ["db:push", "typecheck"] },
    {
      definition: options.application,
      names: ["build", "browser:prepare", "dev", "typecheck", "test:e2e"],
    },
  ];
}

function assertVikePackageRoles(options: {
  readonly application: CompositionPackage;
  readonly database: CompositionPackage;
  readonly migrations: CompositionPackage;
}): void {
  if (options.application.definition.role !== "runtime-service") {
    throw new Error(
      "Vike app deployment requires the application package to have the runtime-service role",
    );
  }
  if (
    options.database.definition.role !== "shared-library" ||
    options.migrations.definition.role !== "shared-library"
  ) {
    throw new Error(
      "Vike app deployment requires the database and migrations packages to have the shared-library role",
    );
  }
  if (
    new Set([
      options.application.definition.name,
      options.database.definition.name,
      options.migrations.definition.name,
    ]).size !== 3 ||
    new Set([
      options.application.definition.path,
      options.database.definition.path,
      options.migrations.definition.path,
    ]).size !== 3 ||
    new Set([
      options.application.packageDefinitionId,
      options.database.packageDefinitionId,
      options.migrations.packageDefinitionId,
    ]).size !== 3
  ) {
    throw new Error(
      "Vike app deployment requires distinct instances for the application, database, and migrations packages",
    );
  }
}

function sameVikeInstance(
  left: PackageBinding,
  right: CompositionPackage,
): boolean {
  return (
    left.packageDefinitionId === right.packageDefinitionId &&
    left.definition.name === right.definition.name &&
    left.definition.path === right.definition.path &&
    left.definition.role === right.definition.role
  );
}

function sameVikeDefinition(
  left: PackageDefinition,
  right: PackageDefinition,
): boolean {
  return (
    left.name === right.name &&
    left.path === right.path &&
    left.role === right.role
  );
}

function assertVikePackageSources(options: VikePackageContributions): void {
  const { application, database, migrations } = options;
  assertVikePackageRoles({
    application: application.package,
    database: database.package,
    migrations: migrations.package,
  });

  const contributions = [database, migrations, application];
  for (const { definition, names } of requiredTaskScripts({
    application: application.package.definition,
    database: database.package.definition,
    migrations: migrations.package.definition,
  })) {
    const contribution = contributions.find((item) =>
      sameVikeDefinition(item.package.definition, definition),
    );
    if (
      contribution === undefined ||
      contribution.sourcePackageName !==
        contribution.package.contentIdentity.packageName ||
      contribution.manifest.name !== definition.name
    ) {
      throw new Error(
        `Vike preset is missing an actual package source: ${definition.name} (${definition.path})`,
      );
    }
    for (const name of names) {
      if (typeof scriptValue(contribution.manifest, name) !== "string") {
        throw new Error(
          `Vike database preparation requires ${definition.name} to declare scripts.${name}`,
        );
      }
    }
  }

  for (const { consumer, contribution, key } of [
    {
      consumer: application.package.definition,
      contribution: application,
      key: webDatabaseDependencyKey,
    },
    {
      consumer: migrations.package.definition,
      contribution: migrations,
      key: migrationsDatabaseDependencyKey,
    },
  ]) {
    const binding = contribution.bindings.get(key);
    if (binding === undefined || !sameVikeInstance(binding, database.package)) {
      throw new Error(
        `Vike database dependency must be bound to the selected instance: ${consumer.name} -> ${database.package.definition.name}`,
      );
    }
  }
}

/** Validates only the three package manifests referenced by deployment tasks against the manifest facts produced by this compute pass. */
function validateVikePackageManifestFacts(options: {
  readonly contributions: VikePackageContributions;
  readonly manifests: readonly VikePackageManifestFact[];
}): void {
  assertVikePackageSources(options.contributions);
  const { application, database, migrations } = options.contributions;
  const manifestsByPath = new Map<string, VikePackageManifestFact>();
  for (const manifest of options.manifests) {
    if (manifestsByPath.has(manifest.path)) {
      throw new Error(
        `Vike preset received a duplicate actual package manifest: ${manifest.path}`,
      );
    }
    manifestsByPath.set(manifest.path, manifest);
  }

  const packages = [database, migrations, application];
  for (const { package: item, manifest: expected } of packages) {
    const definition = item.definition;
    const manifestPath = path.posix.join(
      definition.path === "." ? "" : definition.path,
      "package.json",
    );
    const actual = manifestsByPath.get(manifestPath)?.manifest;
    if (actual === undefined || actual.name !== definition.name) {
      throw new Error(
        `Vike preset actual package identity does not match instance: ${definition.name} (${definition.path})`,
      );
    }
    for (const { definition: requiredDefinition, names } of requiredTaskScripts(
      {
        application: application.package.definition,
        database: database.package.definition,
        migrations: migrations.package.definition,
      },
    )) {
      if (!sameVikeDefinition(requiredDefinition, definition)) continue;
      for (const name of names) {
        if (scriptValue(actual, name) !== scriptValue(expected, name)) {
          throw new Error(
            `Vike database preparation requires ${definition.name} scripts.${name} to match the source package`,
          );
        }
      }
    }
  }
}

function parseVikeBuildxStep(source: string): YAMLMap<unknown> {
  const document = parseDocument(source);
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(
      `Invalid Vike deployment step YAML: ${[...document.errors, ...document.warnings].map((error) => error.message).join("; ")}`,
    );
  }
  const value = document.contents;
  const id = document.get("id");
  const uses = document.get("uses", true);
  if (
    !(value instanceof YAMLMap) ||
    typeof id !== "string" ||
    uses === undefined
  ) {
    throw new Error(
      "Vike Docker Buildx step resource must be a YAML mapping with id and uses",
    );
  }
  return value as YAMLMap<unknown>;
}

function resourceText(
  resourcesByPath: ReadonlyMap<string, ResourceFileSnapshot>,
  resourcePath: string,
): string {
  const resource = resourcesByPath.get(resourcePath);
  if (resource === undefined) {
    throw new Error(
      `Vike deployment resource snapshot is missing owned resource: ${resourcePath}`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(resource.content);
  } catch (cause) {
    throw new Error(
      `Vike deployment resource is not valid UTF-8 text: ${resourcePath}`,
      {
        cause,
      },
    );
  }
}

function resourceMode(
  resourcesByPath: ReadonlyMap<string, ResourceFileSnapshot>,
  resourcePath: string,
): number {
  const resource = resourcesByPath.get(resourcePath);
  if (resource === undefined) {
    throw new Error(
      `Vike deployment resource snapshot is missing owned resource: ${resourcePath}`,
    );
  }
  return resource.mode & 0o111;
}

/** Purely parses prepared owned resources; preserves the Buildx uses node and its inline comment. */
function parseVikeDeploymentResourceFacts(
  resources: readonly ResourceFileSnapshot[],
): VikeDeploymentResourceFacts {
  const resourcesByPath = new Map<string, ResourceFileSnapshot>();
  for (const resource of resources) {
    if (resourcesByPath.has(resource.path)) {
      throw new Error(
        `Vike deployment resource snapshot contains duplicate path: ${resource.path}`,
      );
    }
    resourcesByPath.set(resource.path, resource);
  }

  const entrypointPath = "resources/deployment/scripts/container-entrypoint.sh";
  const buildxStepSource = resourceText(
    resourcesByPath,
    "resources/deployment/setup-buildx-step.yml",
  );

  return Object.freeze({
    dockerfile: resourceText(
      resourcesByPath,
      "resources/deployment/Dockerfile",
    ),
    dockerfileMode: resourceMode(
      resourcesByPath,
      "resources/deployment/Dockerfile",
    ),
    dockerIgnore: resourceText(
      resourcesByPath,
      "resources/deployment/container.dockerignore",
    ),
    dockerIgnoreMode: resourceMode(
      resourcesByPath,
      "resources/deployment/container.dockerignore",
    ),
    containerEntrypoint: Object.freeze({
      text: resourceText(resourcesByPath, entrypointPath),
      mode: resourceMode(resourcesByPath, entrypointPath),
    }),
    checkerSource: resourceText(
      resourcesByPath,
      "scripts/check-standalone-deployment.ts",
    ),
    checkerMode: resourceMode(
      resourcesByPath,
      "scripts/check-standalone-deployment.ts",
    ),
    buildxStepSource,
  });
}

/** Invoked explicitly by the outer layer during prepare; reads only the five resources declared by this owner. */
async function prepareVikeDeploymentResourceFacts(): Promise<VikeDeploymentResourceFacts> {
  const snapshots = await Promise.all(
    vikeDeploymentResources.map(
      async (resource): Promise<ResourceFileSnapshot> => ({
        path: resource.path,
        content: new Uint8Array(
          await readFile(resolveTemplateSource(resource.source, ".")),
        ),
        mode: resource.mode,
      }),
    ),
  );
  return parseVikeDeploymentResourceFacts(snapshots);
}

async function readVikePackageManifest(options: {
  readonly repositoryRoot: string;
  readonly selectedPackage: CompositionPackage;
}): Promise<{
  readonly fact: VikePackageManifestFact;
  readonly readFact: CurrentProjectProjectionEntry;
}> {
  const packagePath = options.selectedPackage.definition.path;
  const manifestPath = path.posix.join(
    packagePath === "." ? "" : packagePath,
    "package.json",
  );
  const absolutePath = path.join(
    options.repositoryRoot,
    ...(packagePath === "." ? [] : packagePath.split("/")),
    "package.json",
  );
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile()) {
    throw new Error(
      `Vike deployment actual package manifest must be a regular file: ${manifestPath}`,
    );
  }
  const content = new Uint8Array(await readFile(absolutePath));
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(content),
    );
  } catch (cause) {
    throw new Error(
      `Vike deployment actual package manifest must be valid JSON: ${manifestPath}`,
      {
        cause,
      },
    );
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new Error(
      `Vike deployment actual package manifest must be a JSON object: ${manifestPath}`,
    );
  }
  return Object.freeze({
    fact: Object.freeze({
      path: manifestPath,
      manifest: manifest as Readonly<Record<string, unknown>>,
    }),
    readFact: Object.freeze({
      path: manifestPath,
      kind: "file" as const,
      content,
      mode: metadata.mode & 0o111,
    }),
  });
}

function selectedPackage(
  selection: GenerationRecordSelection,
  selectedPackages: ReadonlyMap<string, CompositionPackage>,
  nodeIdentity: "web" | "database" | "migrations",
): CompositionPackage {
  const selectedPackageId = selection.nodes[nodeIdentity];
  const item = selectedPackages.get(nodeIdentity);
  if (
    selectedPackageId === undefined ||
    item === undefined ||
    item.packageDefinitionId !== selectedPackageId
  ) {
    throw new Error(
      `Vike preset prepare is missing selected node instance: ${nodeIdentity}`,
    );
  }
  return item;
}

async function prepareVikeRootContribution(options: {
  readonly ownerIdentity: ContentIdentity;
  readonly repositoryRoot?: string;
  readonly selection?: GenerationRecordSelection;
  readonly selectedPackages?: ReadonlyMap<string, CompositionPackage>;
}): Promise<{
  readonly ownerFacts: VikeDeploymentOwnerFacts;
  readonly readFacts?: readonly CurrentProjectProjectionEntry[];
}> {
  const resources = await prepareVikeDeploymentResourceFacts();
  if (options.repositoryRoot === undefined) {
    return Object.freeze({
      ownerFacts: Object.freeze({ resources }),
    });
  }
  if (
    options.selection === undefined ||
    options.selectedPackages === undefined ||
    options.selection.presetIdentity === null ||
    contentIdentityKey(options.selection.presetIdentity) !==
      contentIdentityKey(options.ownerIdentity)
  ) {
    throw new Error(
      "Vike deployment prepare requires a persisted preset selection matching the full owner identity",
    );
  }
  const packages = [
    selectedPackage(options.selection, options.selectedPackages, "web"),
    selectedPackage(options.selection, options.selectedPackages, "database"),
    selectedPackage(options.selection, options.selectedPackages, "migrations"),
  ];
  const current = await Promise.all(
    packages.map((selectedPackage) =>
      readVikePackageManifest({
        repositoryRoot: options.repositoryRoot!,
        selectedPackage,
      }),
    ),
  );
  return Object.freeze({
    ownerFacts: Object.freeze({
      resources,
      manifests: Object.freeze(current.map(({ fact }) => fact)),
    }),
    readFacts: Object.freeze(current.map(({ readFact }) => readFact)),
  });
}

function transformVikeDeploymentChecker(
  checkerSource: string,
  names: {
    readonly applicationName: string;
    readonly applicationPath: string;
    readonly databaseName: string;
    readonly migrationsName: string;
  },
): string {
  return checkerSource
    .replaceAll(
      JSON.stringify("@boringparts/reference-vike-web"),
      JSON.stringify(names.applicationName),
    )
    .replaceAll(
      JSON.stringify("references/vike-web"),
      JSON.stringify(names.applicationPath),
    )
    .replaceAll(
      JSON.stringify("@boringparts/reference-vike-db"),
      JSON.stringify(names.databaseName),
    )
    .replaceAll(
      JSON.stringify("@boringparts/reference-vike-migrations"),
      JSON.stringify(names.migrationsName),
    );
}

function packageScript(
  profile: "dev" | "test" | "e2e",
  definition: PackageDefinition,
  script: string,
): string {
  return `DATABASE_PROFILE=${profile} pnpm --filter ${definition.name} run ${script}`;
}

function preparationScripts(options: {
  readonly application: PackageDefinition;
  readonly database: PackageDefinition;
  readonly migrations: PackageDefinition;
}): Readonly<Record<string, string>> {
  const { application, database, migrations } = options;
  return Object.freeze({
    "database:prepare:dev": [
      packageScript("dev", migrations, "db:push"),
      packageScript("dev", database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:test": [
      packageScript("test", database, "db:reset"),
      packageScript("test", migrations, "db:push"),
      packageScript("test", database, "db:seed:example"),
    ].join(" && "),
    "database:prepare:e2e": [
      packageScript("e2e", database, "db:reset"),
      packageScript("e2e", migrations, "db:push"),
      packageScript("e2e", database, "db:seed:example"),
    ].join(" && "),
    dev: `pnpm run database:prepare:dev && turbo watch dev --filter=${application.name}`,
    deployment:
      "node --conditions=source scripts/check-standalone-deployment.ts",
  });
}

function deploymentTask(
  application: PackageDefinition,
  database: PackageDefinition,
  migrations: PackageDefinition,
) {
  return Object.freeze({
    cache: false,
    dependsOn: Object.freeze([
      `${application.name}#build`,
      `${application.name}#browser:prepare`,
      `${database.name}#build`,
      `${migrations.name}#build`,
    ]),
    tags: ["quality:heavy"],
  });
}

function rootFile(
  path: string,
  text: string,
  mode: number,
  sourcePath: string,
): DefaultCompositionFile {
  return Object.freeze({
    path,
    content: new TextEncoder().encode(text),
    mode,
    sourcePath,
  });
}

function selectedEvaluation(
  selection: GenerationRecordSelection,
  selectedPackages: ReadonlyMap<string, DefaultPresetPackageEvaluation>,
  nodeIdentity: "web" | "database" | "migrations",
): DefaultPresetPackageEvaluation {
  const selectedPackageId = selection.nodes[nodeIdentity];
  const evaluation = selectedPackages.get(nodeIdentity);
  if (
    selectedPackageId === undefined ||
    evaluation === undefined ||
    evaluation.package.packageDefinitionId !== selectedPackageId
  ) {
    throw new Error(
      `Vike preset composition is missing evaluated node: ${nodeIdentity}`,
    );
  }
  return evaluation;
}

function packageContribution(
  evaluation: DefaultPresetPackageEvaluation,
): VikePackageContribution {
  return {
    package: evaluation.package,
    sourcePackageName: evaluation.contribution.facts.sourcePackageName,
    manifest: evaluation.contribution.facts.manifest,
    bindings: evaluation.bindings,
  };
}

/** Composes Vike root tasks and deployment attachments without accessing disk, environment, or the target working tree. */
function composeVikeDeploymentContribution(options: {
  readonly ownerIdentity: ContentIdentity;
  readonly selection: GenerationRecordSelection;
  readonly selectedPackages: ReadonlyMap<
    string,
    DefaultPresetPackageEvaluation
  >;
  readonly rootPackage: CompositionPackage;
  readonly rootManifest: Readonly<Record<string, unknown>>;
  readonly ownerFacts: VikeDeploymentOwnerFacts;
}): {
  readonly rootPackageDefinitionId: CompositionPackage["packageDefinitionId"];
  readonly rootDeclaration: DefaultRootDeclarationData;
} {
  if (
    options.selection.presetIdentity === null ||
    contentIdentityKey(options.selection.presetIdentity) !==
      contentIdentityKey(options.ownerIdentity)
  ) {
    throw new Error(
      "Vike deployment composition requires a preset selection matching the full owner identity",
    );
  }
  const contributions: VikePackageContributions = {
    application: packageContribution(
      selectedEvaluation(options.selection, options.selectedPackages, "web"),
    ),
    database: packageContribution(
      selectedEvaluation(
        options.selection,
        options.selectedPackages,
        "database",
      ),
    ),
    migrations: packageContribution(
      selectedEvaluation(
        options.selection,
        options.selectedPackages,
        "migrations",
      ),
    ),
  };
  const { application, database, migrations } = contributions;
  assertVikePackageSources(contributions);
  if (options.ownerFacts.manifests !== undefined) {
    validateVikePackageManifestFacts({
      contributions,
      manifests: options.ownerFacts.manifests,
    });
  }

  const resources = options.ownerFacts.resources;
  const packageManagerPin = options.rootManifest.packageManager;
  if (typeof packageManagerPin !== "string")
    throw new Error(
      "Vike deployment requires a root packageManager declaration",
    );
  const buildxStep = parseVikeBuildxStep(resources.buildxStepSource);
  const rootDeclaration: DefaultRootDeclarationData = Object.freeze({
    manifest: Object.freeze({
      scripts: preparationScripts({
        application: application.package.definition,
        database: database.package.definition,
        migrations: migrations.package.definition,
      }),
    }),
    turboTasks: Object.freeze({
      "//#dev": {
        cache: false,
        persistent: true,
        tags: ["work:development"],
      },
      "//#database:prepare:dev": { cache: false, tags: ["work:preparation"] },
      "//#database:prepare:e2e": { cache: false, tags: ["work:preparation"] },
      "//#database:prepare:test": { cache: false, tags: ["work:preparation"] },
      "//#deployment": deploymentTask(
        application.package.definition,
        database.package.definition,
        migrations.package.definition,
      ),
    }),
    files: Object.freeze([
      {
        ...rootFile(
          "Dockerfile",
          projectPnpmBootstrapDockerfile(
            resources.dockerfile,
            packageManagerPin,
          ),
          resources.dockerfileMode,
          "resources/deployment/Dockerfile",
        ),
        mirrorSlots: [
          {
            id: "pnpm-bootstrap",
            location: { kind: "text-anchor" as const, name: "pnpm-bootstrap" },
          },
        ],
      },
      rootFile(
        ".dockerignore",
        resources.dockerIgnore,
        resources.dockerIgnoreMode,
        "resources/deployment/container.dockerignore",
      ),
      rootFile(
        "scripts/check-standalone-deployment.ts",
        transformVikeDeploymentChecker(resources.checkerSource, {
          applicationName: application.package.definition.name,
          applicationPath: application.package.definition.path,
          databaseName: database.package.definition.name,
          migrationsName: migrations.package.definition.name,
        }),
        resources.checkerMode,
        "scripts/check-standalone-deployment.ts",
      ),
      rootFile(
        "scripts/container-entrypoint.sh",
        resources.containerEntrypoint.text,
        resources.containerEntrypoint.mode,
        "resources/deployment/scripts/container-entrypoint.sh",
      ),
    ]),
    ciJob: Object.freeze({ name: "Full Check", timeoutMinutes: 45 }),
    ciSteps: Object.freeze([
      Object.freeze({
        before: "run-heavy-check",
        steps: Object.freeze([buildxStep]),
      }),
    ]),
    environmentNeeds: Object.freeze({
      check: Object.freeze([
        shellCheckEnvironmentNeed({
          kind: "workspace-orchestration",
          path: ".",
        }),
      ] satisfies readonly CheckEnvironmentNeed[]),
      deployment: Object.freeze([
        dockerEngineEnvironmentNeed(),
      ] satisfies readonly DeploymentEnvironmentNeed[]),
    }),
    dependencyMaintenance: Object.freeze({
      ecosystems: ["docker"],
      extraDirectories: { docker: ["/"] },
      interval: "weekly",
    } satisfies DependencyMaintenancePolicy),
  });
  return Object.freeze({
    rootPackageDefinitionId: options.rootPackage.packageDefinitionId,
    rootDeclaration,
  });
}

export const vikeRootContribution = Object.freeze({
  prepare: prepareVikeRootContribution,
  compose: composeVikeDeploymentContribution,
}) satisfies DefaultPresetRootContributionOwner<VikeDeploymentOwnerFacts>;
