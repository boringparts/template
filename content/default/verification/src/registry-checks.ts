import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  contentIdentityKey,
  contentIdentityLabel,
} from "@boringparts/template-core/content-identity";
import {
  readProjectedMirrorSlotScalar,
  type ProjectProjectionEntry,
  type ProjectProjectionMirrorSlot,
  type ProjectProjectionSource,
} from "@boringparts/template-core/project-projection";
import {
  loadTemplateDependencyCatalog,
  loadTemplateMinimumReleaseAgeExclusions,
  selectMinimumReleaseAgeExclusions,
  selectTemplateDependencyCatalogEntries,
} from "@boringparts/template-workspace/dependency-catalog";
import { readRustToolchainChannelFromToml } from "@boringparts/template-workspace/rust-toolchain-facts";
import { parse as parseYaml } from "yaml";

import type {
  GeneratedScenarioReceipt,
  GeneratedScenarioRuntime,
  SuccessfulScenarioResult,
} from "./generated-content.ts";

export type PlanSourceReference = {
  readonly scenarioId: string;
  readonly generatedPath: string;
  readonly sourceIdentity: string;
  readonly sourceLabel: string;
  readonly sourceModuleURL?: string;
};

function expectedProjectionSources(
  result: SuccessfulScenarioResult,
  runtime: GeneratedScenarioRuntime,
): ReadonlyMap<
  string,
  ProjectProjectionSource & { readonly moduleURL: string }
> {
  const packages = new Map(
    result.blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition,
    ]),
  );
  const members = new Map(
    runtime.content.map((member) => [
      contentIdentityKey(member.identity),
      member,
    ]),
  );
  const sources = new Map<
    string,
    ProjectProjectionSource & { readonly moduleURL: string }
  >();
  for (const record of result.generationRecord.packages) {
    const definition = packages.get(record.packageDefinitionId);
    const member = members.get(contentIdentityKey(record.contentIdentity));
    if (definition === undefined || member === undefined) {
      throw new Error(
        `Content source in generation record does not match this content collection: ${contentIdentityLabel(record.contentIdentity)}`,
      );
    }
    const identity = `content:${contentIdentityKey(record.contentIdentity)}:${record.packageDefinitionId}`;
    sources.set(identity, {
      identity,
      label: `${contentIdentityLabel(record.contentIdentity)} (${definition.path})`,
      moduleURL: member.source.moduleURL,
    });
  }
  const compositionIdentity = result.generationRecord.composition.identity;
  const identity = `composition:${contentIdentityKey(compositionIdentity)}`;
  sources.set(identity, {
    identity,
    label: `composition ${contentIdentityLabel(compositionIdentity)}`,
    moduleURL: "",
  });
  return sources;
}

function assertProjectionOwnership(
  projection: SuccessfulScenarioResult["projection"],
  result: SuccessfulScenarioResult,
  scenarioId: string,
): void {
  for (const entry of projection.entries) {
    const owners = result.blueprint.packages
      .filter(
        (definition) =>
          definition.path === "." ||
          entry.path.startsWith(`${definition.path}/`),
      )
      .toSorted((left, right) => right.path.length - left.path.length);
    if (owners[0] === undefined) {
      throw new Error(
        `${scenarioId}: projected file ${entry.path} has no owning package in the blueprint`,
      );
    }
    const sources = entry.sources;
    if (sources === undefined || sources.length === 0) {
      throw new Error(
        `${scenarioId}: projected file ${entry.path} has no source provenance`,
      );
    }
  }
}

/** Validates source provenance identities and package ownership across the projected file tree. */
export function planSourceReferences(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): readonly PlanSourceReference[] {
  const result = options.receipt.result;
  const projection = requireProjection(result);
  const expected = expectedProjectionSources(result, options.runtime);
  assertProjectionOwnership(projection, result, options.receipt.scenario.id);
  return projection.entries.flatMap((entry) =>
    (entry.sources ?? []).map((source) => {
      const known = expected.get(source.identity);
      if (known === undefined || known.label !== source.label) {
        throw new Error(
          `${options.receipt.scenario.id}: generated ${entry.path} has unknown source provenance ${source.identity}`,
        );
      }
      return {
        scenarioId: options.receipt.scenario.id,
        generatedPath: entry.path,
        sourceIdentity: source.identity,
        sourceLabel: source.label,
        ...(known.moduleURL.length === 0
          ? {}
          : { sourceModuleURL: known.moduleURL }),
      };
    }),
  );
}

export async function validatePlanSources(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): Promise<readonly PlanSourceReference[]> {
  const references = planSourceReferences(options);
  const inspectedModules = new Set<string>();
  for (const reference of references) {
    const moduleURL = reference.sourceModuleURL;
    if (moduleURL === undefined || inspectedModules.has(moduleURL)) continue;
    inspectedModules.add(moduleURL);
    try {
      await access(new URL(moduleURL));
    } catch {
      throw new Error(
        `${reference.scenarioId}: actual projection source module ${moduleURL} is unavailable for generated ${reference.generatedPath}`,
      );
    }
  }
  return references;
}

function requireProjection(result: SuccessfulScenarioResult) {
  if (result.projection === null) {
    throw new Error("Generated scenario result has no new projection");
  }
  return result.projection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateGeneratedDevelopmentContainerProjection(options: {
  readonly receipt: GeneratedScenarioReceipt;
}): Promise<void> {
  const projection = requireProjection(options.receipt.result);
  const expectedFile = (filePath: string): ProjectProjectionEntry => {
    const entry = projection.entries.find(
      (candidate) => candidate.path === filePath,
    );
    if (entry === undefined) {
      throw new Error(
        `${options.receipt.scenario.id}: expected file tree omitted ${filePath}`,
      );
    }
    return entry;
  };
  const dockerfilePath = path.join(
    options.receipt.projectDir,
    ".devcontainer",
    "Dockerfile",
  );
  const generatedDockerfile = await readFile(dockerfilePath, "utf8");
  const expectedDockerfile = new TextDecoder("utf-8", { fatal: true }).decode(
    expectedFile(".devcontainer/Dockerfile").content,
  );
  if (
    generatedDockerfile !== expectedDockerfile ||
    generatedDockerfile !==
      options.receipt.result.ownerFacts.container.dockerfileText
  ) {
    throw new Error(
      `Generated Development Container projection ${dockerfilePath} does not match the default workspace owner facts`,
    );
  }

  const configPath = path.join(
    options.receipt.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    readonly [key: string]: unknown;
  };
  const expectedConfig = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      expectedFile(".devcontainer/devcontainer.json").content,
    ),
  ) as unknown;
  const build = isRecord(config.build) ? config.build : {};
  const buildArguments = isRecord(build.args) ? build.args : {};
  for (const argument of options.receipt.result.ownerFacts.container
    .buildArguments) {
    if (buildArguments[argument.name] !== argument.value) {
      throw new Error(
        `Generated Development Container build argument ${argument.name} does not match the default workspace owner facts`,
      );
    }
  }
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];
  for (const { identity: _identity, ...mount } of options.receipt.result
    .ownerFacts.container.mounts) {
    if (!mounts.some((candidate) => isDeepStrictEqual(candidate, mount))) {
      throw new Error(
        `Generated Development Container mount ${mount.target} does not match the default workspace owner facts`,
      );
    }
  }
  if (!isDeepStrictEqual(config, expectedConfig)) {
    throw new Error(
      `Generated Development Container projection ${configPath} does not match the expected file tree`,
    );
  }
}

function recordByPackageId(result: SuccessfulScenarioResult) {
  return new Map(
    result.generationRecord.packages.map((record) => [
      record.packageDefinitionId,
      record,
    ]),
  );
}

/** Validates dependency catalog alignment using only the written manifests, workspace YAML, generation record, and blueprint. */
export async function validatePlanDependencyCatalog(
  result: SuccessfulScenarioResult,
  projectDir: string,
  scenarioId: string,
): Promise<void> {
  const rootManifest = JSON.parse(
    await readFile(path.join(projectDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const workspaceValue: unknown = parseYaml(
    await readFile(path.join(projectDir, "pnpm-workspace.yaml"), "utf8"),
  );
  const catalog =
    isRecord(workspaceValue) && isRecord(workspaceValue.catalog)
      ? workspaceValue.catalog
      : {};
  const manifests = new Map<string, Record<string, unknown>>([
    ["package.json", rootManifest],
  ]);
  for (const definition of result.blueprint.packages) {
    const file = `${definition.path}/package.json`;
    const manifest = JSON.parse(
      await readFile(path.join(projectDir, file), "utf8"),
    ) as Record<string, unknown>;
    if (manifest.name !== definition.name) {
      throw new Error(
        `${scenarioId}: ${file} package name does not match the actual blueprint`,
      );
    }
    manifests.set(file, manifest);
  }

  const packageRecordById = recordByPackageId(result);
  const packagePathById = new Map(
    result.blueprint.packages.map((definition) => [
      definition.packageDefinitionId,
      definition.path,
    ]),
  );
  const packageRecordByPath = new Map(
    result.blueprint.packages.flatMap((definition) => {
      const record = packageRecordById.get(definition.packageDefinitionId);
      return record === undefined ? [] : [[definition.path, record] as const];
    }),
  );
  const templateCatalog = loadTemplateDependencyCatalog();
  const references = new Set<string>();
  for (const [manifestPath, manifest] of manifests) {
    const packagePath =
      manifestPath === "package.json" ? "." : path.posix.dirname(manifestPath);
    const packageRecord = packageRecordByPath.get(packagePath);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = manifest[field];
      if (!isRecord(dependencies)) continue;
      for (const [dependency, specifier] of Object.entries(dependencies)) {
        if (typeof specifier !== "string") {
          throw new Error(
            `${scenarioId}: ${manifestPath} ${field} ${dependency} must use a string specifier`,
          );
        }
        const provider = result.blueprint.packages.find(
          (definition) => definition.name === dependency,
        );
        const providerRecord =
          provider === undefined
            ? undefined
            : packageRecordById.get(provider.packageDefinitionId);
        const isBoundReference =
          providerRecord !== undefined &&
          packageRecord !== undefined &&
          Object.values(packageRecord.dependencyBindings).includes(
            providerRecord.packageDefinitionId,
          );
        const isLinkIntent =
          field === "dependencies" &&
          result.blueprint.packageLinkIntents.some(
            (intent) =>
              packagePathById.get(intent.consumerId) === packagePath &&
              packagePathById.get(intent.providerId) === provider?.path,
          );
        const rootToolingDependency =
          manifestPath === "package.json" && field === "devDependencies";
        const internalWorkspace =
          specifier.startsWith("workspace:") &&
          provider !== undefined &&
          (isBoundReference || isLinkIntent || rootToolingDependency);
        const internalConfiguration =
          isBoundReference &&
          provider !== undefined &&
          field === "devDependencies" &&
          specifier ===
            `link:${path.posix.relative(packagePath, provider.path)}`;
        if (internalWorkspace || internalConfiguration) continue;

        const expectedVersion = templateCatalog[dependency];
        const actualVersion = catalog[dependency];
        if (
          specifier !== "catalog:" ||
          typeof expectedVersion !== "string" ||
          expectedVersion.trim().length === 0 ||
          /^(?:catalog|workspace|link):/u.test(expectedVersion) ||
          actualVersion !== expectedVersion
        ) {
          throw new Error(
            `${scenarioId}: ${manifestPath} ${field} ${dependency} ${JSON.stringify(specifier)} violates the default dependency catalog contract`,
          );
        }
        references.add(dependency);
      }
    }
  }
  const expected = selectTemplateDependencyCatalogEntries(
    [...references],
    templateCatalog,
  );
  if (
    Object.entries(expected).some(
      ([name, version]) => catalog[name] !== version,
    )
  ) {
    throw new Error(
      `${scenarioId}: generated dependency catalog does not match actual manifest references`,
    );
  }
  const expectedExclusions = selectMinimumReleaseAgeExclusions(
    loadTemplateMinimumReleaseAgeExclusions(),
    new Set(Object.keys(expected)),
  );
  const actualExclusions = isRecord(workspaceValue)
    ? workspaceValue.minimumReleaseAgeExclude
    : undefined;
  if (expectedExclusions.length === 0) {
    if (actualExclusions !== undefined) {
      throw new Error(
        `${scenarioId}: generated minimumReleaseAgeExclude must be omitted when no excluded dependency is selected`,
      );
    }
  } else if (!isDeepStrictEqual(actualExclusions, expectedExclusions)) {
    throw new Error(
      `${scenarioId}: generated minimumReleaseAgeExclude ${JSON.stringify(actualExclusions)} does not match expected ${JSON.stringify(expectedExclusions)}`,
    );
  }
}

export async function assertGeneratedManifestDefaultsPrivate(options: {
  readonly result: SuccessfulScenarioResult;
  readonly projectDir: string;
  readonly scenarioId: string;
}): Promise<void> {
  const rootManifest = JSON.parse(
    await readFile(path.join(options.projectDir, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  if (rootManifest.private !== true) {
    throw new Error(
      `${options.scenarioId}: generated workspace root package.json must remain private:true`,
    );
  }
  for (const definition of options.result.blueprint.packages) {
    const manifestPath = `${definition.path}/package.json`;
    const manifest = JSON.parse(
      await readFile(path.join(options.projectDir, manifestPath), "utf8"),
    ) as Record<string, unknown>;
    if (manifest.private !== true) {
      throw new Error(
        `${options.scenarioId}: generated package ${manifestPath} must default to private:true`,
      );
    }
  }
}

function escapeLocationName(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function readArgCarrierValue(
  carrierLine: string,
  name: string,
): string | undefined {
  return new RegExp(
    String.raw`^ARG\s+${escapeLocationName(name)}\s*=\s*"([^"\r\n]*)"\s*$`,
    "u",
  ).exec(carrierLine)?.[1];
}

function mirrorSlotRootToken(slot: ProjectProjectionMirrorSlot): string {
  return slot.location.kind === "json-pointer"
    ? (slot.location.pointer.split("/").at(-1) ?? "")
    : slot.location.name;
}

function plannedMirrorSlots(result: SuccessfulScenarioResult): readonly {
  readonly path: string;
  readonly slot: ProjectProjectionMirrorSlot;
}[] {
  const projection = requireProjection(result);
  const projectedPaths = new Set(projection.entries.map((entry) => entry.path));
  return projection.reconciliation.flatMap((policy) => {
    if (policy.driver === "canonical" || !projectedPaths.has(policy.path)) {
      return [];
    }
    return (policy.mirrorSlots ?? []).map((slot) => ({
      path: policy.path,
      slot,
    }));
  });
}

const rustChannelSourcePath = "rust-toolchain.toml";
const rustMirrorSlotToken = "RUST_TOOLCHAIN";

export async function validatePlanMirrorSlotProjections(options: {
  readonly receipt: GeneratedScenarioReceipt;
}): Promise<void> {
  const slots = plannedMirrorSlots(options.receipt.result);
  if (slots.length === 0) return;
  const owner = options.receipt.scenario.id;
  const rootManifest = JSON.parse(
    await readFile(
      path.join(options.receipt.projectDir, "package.json"),
      "utf8",
    ),
  ) as unknown;
  const rootRuntime =
    isRecord(rootManifest) &&
    isRecord(rootManifest.devEngines) &&
    isRecord(rootManifest.devEngines.runtime)
      ? rootManifest.devEngines.runtime
      : undefined;
  const rootNode =
    rootRuntime?.name === "node" &&
    rootRuntime.onFail === "download" &&
    typeof rootRuntime.version === "string"
      ? rootRuntime.version
      : undefined;
  if (typeof rootNode !== "string") {
    throw new Error(
      `${owner}: mirror slots require actual root package.json devEngines.runtime`,
    );
  }
  let rustChannel: string | undefined;
  const expectedRustChannel = async (): Promise<string> => {
    if (rustChannel !== undefined) return rustChannel;
    const text = await readFile(
      path.join(options.receipt.projectDir, rustChannelSourcePath),
      "utf8",
    );
    const reading = readRustToolchainChannelFromToml(text);
    if (reading.status !== "explained") {
      throw new Error(
        `${owner}: root Rust toolchain source is not explainable: ${reading.reason}`,
      );
    }
    rustChannel = reading.channel;
    return rustChannel;
  };
  for (const { path: filePath, slot } of slots) {
    const fullPath = path.join(options.receipt.projectDir, filePath);
    const content = await readFile(fullPath);
    const metadata = await stat(fullPath);
    const entry: ProjectProjectionEntry = {
      path: filePath,
      kind: "file",
      content,
      mode: metadata.mode & 0o777,
    };
    const observed = readProjectedMirrorSlotScalar(entry, slot.location);
    if (!observed.ok) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual mirror slot is not explainable: ${observed.reason}`,
      );
    }
    const pnpmBootstrap = slot.id === "pnpm-bootstrap";
    const projected = pnpmBootstrap
      ? observed.scalar.trim()
      : slot.location.kind === "json-pointer"
        ? observed.scalar
        : readArgCarrierValue(observed.scalar, slot.location.name);
    if (projected === undefined) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual mirror slot has no scalar value`,
      );
    }
    const isRustSlot = mirrorSlotRootToken(slot) === rustMirrorSlotToken;
    const expected = pnpmBootstrap
      ? `COPY --from=ghcr.io/pnpm/pnpm:${String((rootManifest as Record<string, unknown>).packageManager).replace(/^pnpm@/u, "")} /opt/pnpm /opt/pnpm`
      : isRustSlot
        ? await expectedRustChannel()
        : rootNode;
    if (projected !== expected) {
      throw new Error(
        `${owner} ${filePath}#${slot.id}: actual value ${JSON.stringify(projected)} differs from ${pnpmBootstrap ? "root packageManager" : isRustSlot ? "root Rust channel" : "root devEngines.runtime"} ${JSON.stringify(expected)}`,
      );
    }
  }
}

export async function validateRegistryMirrorSlotProjections(
  receipt: GeneratedScenarioReceipt,
): Promise<void> {
  await validatePlanMirrorSlotProjections({ receipt });
}

export async function validateGeneratedScenarioReceipt(options: {
  readonly receipt: GeneratedScenarioReceipt;
  readonly runtime: GeneratedScenarioRuntime;
}): Promise<void> {
  await validatePlanSources(options);
  await validatePlanDependencyCatalog(
    options.receipt.result,
    options.receipt.projectDir,
    options.receipt.scenario.id,
  );
  await assertGeneratedManifestDefaultsPrivate({
    result: options.receipt.result,
    projectDir: options.receipt.projectDir,
    scenarioId: options.receipt.scenario.id,
  });
  await validateGeneratedDevelopmentContainerProjection({
    receipt: options.receipt,
  });
  await validateRegistryMirrorSlotProjections(options.receipt);
}
