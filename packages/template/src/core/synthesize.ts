import { stringify as stringifyYaml } from "yaml";

import {
  normalizeRelativePackagePath,
  type SourceContext,
  type WorkspacePolicy,
} from "../sources/index.ts";
import { mergeWorkspaceEnvironment } from "./environment.ts";
import {
  collectManifestCatalogUsage,
  collectManifestDependencyNames,
  formatJson,
  hasManifestDevScript,
  isBinaryContent,
  rewriteSubpackageManifest,
  rewriteSubpackageTurboConfig,
  rewriteTextSpecifiers,
} from "./transform.ts";
import {
  ProjectValidationError,
  type PackageContribution,
  type PackageInstance,
  type ProjectBlueprint,
  type ProjectProjection,
  type ProjectProjectionEntry,
  type WorkspaceRoot,
} from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readManifestName(
  source: SourceContext,
  sourceDir: string,
): string | undefined {
  const raw = source.tryReadPackageText(sourceDir, "package.json");
  if (raw === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) && typeof parsed.name === "string"
      ? parsed.name
      : undefined;
  } catch {
    return undefined;
  }
}

function extractOverrideLeadingPackage(overrideKey: string): string {
  const firstSegment = overrideKey.split(">", 1)[0]?.trim() ?? "";
  if (firstSegment.startsWith("@")) {
    const versionSep = firstSegment.indexOf("@", 1);
    return versionSep === -1 ? firstSegment : firstSegment.slice(0, versionSep);
  }
  const versionSep = firstSegment.indexOf("@");
  return versionSep === -1 ? firstSegment : firstSegment.slice(0, versionSep);
}

function validateWorkspaceRootManifest(refRootJson: Record<string, unknown>): {
  readonly scripts: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly devEngines: Record<string, unknown>;
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
} {
  if (!isRecord(refRootJson.scripts)) {
    throw new Error(
      'Reference workspace-root package.json must declare a "scripts" object.',
    );
  }
  const scripts: Record<string, string> = {};
  for (const [name, cmd] of Object.entries(refRootJson.scripts)) {
    if (typeof cmd !== "string") {
      throw new Error(
        `Reference workspace-root package.json script "${name}" must be a string.`,
      );
    }
    scripts[name] = cmd;
  }

  if (!isRecord(refRootJson.devDependencies)) {
    throw new Error(
      'Reference workspace-root package.json must declare a "devDependencies" object.',
    );
  }
  const devDependencies: Record<string, string> = {};
  for (const [dep, spec] of Object.entries(refRootJson.devDependencies)) {
    if (typeof spec !== "string") {
      throw new Error(
        `Reference workspace-root package.json devDependency "${dep}" must be a string.`,
      );
    }
    devDependencies[dep] = spec;
  }

  const devEngines = refRootJson.devEngines;
  if (!isRecord(devEngines)) {
    throw new Error(
      'Reference workspace-root package.json must declare a "devEngines" object.',
    );
  }
  const runtime = devEngines.runtime;
  if (!isRecord(runtime)) {
    throw new Error(
      'Reference workspace-root package.json must declare "devEngines.runtime".',
    );
  }
  const nodeVersion = runtime.version;
  if (typeof nodeVersion !== "string" || nodeVersion.trim().length === 0) {
    throw new Error(
      'Reference workspace-root package.json must declare "devEngines.runtime.version" as a non-empty string.',
    );
  }
  const packageManagerPin = refRootJson.packageManager;
  if (
    typeof packageManagerPin !== "string" ||
    packageManagerPin.trim().length === 0
  ) {
    throw new Error(
      'Reference workspace-root package.json must declare "packageManager" as a non-empty string.',
    );
  }

  return {
    scripts,
    devDependencies,
    devEngines,
    nodeVersion,
    packageManagerPin,
  };
}

function buildRootPackageManifestObject(options: {
  readonly repositoryName: string;
  readonly scripts: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly devEngines: Record<string, unknown>;
  readonly packageManagerPin: string;
  readonly rootDependencyBindings: ReadonlyMap<string, string>;
  readonly hasDevScript: boolean;
  readonly hasPublishable: boolean;
}): Record<string, unknown> {
  const scripts: Record<string, string> = {};
  for (const [scriptName, scriptCmd] of Object.entries(options.scripts)) {
    scripts[scriptName] = rewriteTextSpecifiers({
      text: scriptCmd,
      dependencyBindings: options.rootDependencyBindings,
    });
  }
  if (options.hasDevScript) {
    scripts.dev = "turbo run dev";
  }
  if (options.hasPublishable) {
    scripts["publication:pack"] =
      "turbo run build && changeset pack --out-dir .changeset/packed";
    scripts["publication:publish"] =
      "changeset publish --from-pack-dir .changeset/packed";
  }

  const devDependencies: Record<string, string> = {};
  for (const [dep, spec] of Object.entries(options.devDependencies)) {
    const bound = options.rootDependencyBindings.get(dep);
    if (bound !== undefined) {
      devDependencies[bound] = "workspace:*";
    } else {
      devDependencies[dep] = spec;
    }
  }
  if (options.hasPublishable) {
    devDependencies["@changesets/cli"] = "catalog:";
  }

  const sortedDevDeps = Object.fromEntries(
    Object.entries(devDependencies).toSorted(([a], [b]) =>
      compareStrings(a, b),
    ),
  );

  return {
    name: options.repositoryName,
    private: true,
    type: "module",
    scripts,
    devDependencies: sortedDevDeps,
    devEngines: options.devEngines,
    packageManager: options.packageManagerPin,
  };
}

/**
 * Deterministically rootifies the checked `workspace-root/turbo.json` into the generated
 * repository's root `turbo.json`:
 * - strips subpackage `extends`, `tags`, and empty-tag bridge tasks (e.g. `build`)
 * - prefixes task names and intra-package `dependsOn` entries with `//#`
 * - restores public gate entry roles (`quality:entry` / `work:repair`)
 * - constructs `globalDependencies` dynamically from root configs and singleton config files
 * - sets generic monorepo `boundaries.tags` and conditional `//#dev` / `//#publication:*` tasks
 */
function rootifyWorkspaceTurboConfig(options: {
  readonly rawRefTurboJson: string;
  readonly singletonConfigPaths: readonly string[];
  readonly hasDevScript: boolean;
  readonly hasPublishable: boolean;
}): string {
  const parsed = JSON.parse(options.rawRefTurboJson) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
    throw new Error(
      'Reference workspace-root turbo.json must declare a "tasks" object.',
    );
  }

  const rootTasks: Record<string, unknown> = {};
  for (const [taskName, rawTask] of Object.entries(parsed.tasks)) {
    if (!isRecord(rawTask)) {
      continue;
    }
    if (Array.isArray(rawTask.tags) && rawTask.tags.length === 0) {
      continue;
    }

    const rootTaskName = `//#${taskName}`;
    const taskConfig: Record<string, unknown> = { ...rawTask };
    if (Array.isArray(rawTask.dependsOn)) {
      taskConfig.dependsOn = rawTask.dependsOn.map((dep: unknown) => {
        if (typeof dep !== "string") {
          return dep;
        }
        return dep.includes("^") || dep.includes("#") ? dep : `//#${dep}`;
      });
    }

    if (
      rootTaskName === "//#check" ||
      rootTaskName === "//#check:heavy" ||
      rootTaskName === "//#check:full"
    ) {
      taskConfig.tags = ["quality:entry"];
    } else if (rootTaskName === "//#fix") {
      taskConfig.tags = ["work:repair"];
    }

    rootTasks[rootTaskName] = taskConfig;
  }

  if (options.hasDevScript) {
    rootTasks["//#dev"] = {
      cache: false,
      persistent: true,
      tags: ["work:development"],
    };
  }

  if (options.hasPublishable) {
    rootTasks["//#publication:pack"] = {
      tags: ["work:release"],
      cache: false,
    };
    rootTasks["//#publication:publish"] = {
      tags: ["work:release"],
      cache: false,
    };
  }

  const rootConfigObj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (
      key === "extends" ||
      key === "tags" ||
      key === "globalDependencies" ||
      key === "tasks" ||
      key === "boundaries"
    ) {
      continue;
    }
    rootConfigObj[key] = value;
  }

  rootConfigObj.globalDependencies = [
    "oxfmt.config.ts",
    "oxlint.config.ts",
    ...options.singletonConfigPaths,
  ];
  rootConfigObj.tasks = rootTasks;
  rootConfigObj.boundaries = {
    tags: {
      app: { dependencies: { allow: ["app", "library"] } },
      library: { dependencies: { allow: ["library"] } },
      native: { dependencies: { allow: ["library"] } },
    },
  };

  return formatJson(rootConfigObj);
}

function synthesizePnpmWorkspaceYaml(options: {
  readonly instances: readonly PackageInstance[];
  readonly workspacePolicy: WorkspacePolicy;
  readonly defaultCatalogDeps: ReadonlySet<string>;
  readonly namedCatalogDeps: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  const collections = new Set<string>();
  for (const instance of options.instances) {
    const firstSegment = instance.path.split("/", 1)[0];
    if (firstSegment !== undefined && firstSegment.length > 0) {
      collections.add(`${firstSegment}/*`);
    }
  }

  const { workspacePolicy } = options;

  const prunedCatalog: Record<string, string> = {};
  for (const dep of [...options.defaultCatalogDeps].toSorted()) {
    const version = workspacePolicy.catalog[dep];
    if (version === undefined) {
      throw new Error(
        `Workspace policy catalog is missing dependency "${dep}"`,
      );
    }
    prunedCatalog[dep] = version;
  }

  const prunedNamedCatalogs: Record<string, Record<string, string>> = {};
  for (const [catalogName, deps] of [
    ...options.namedCatalogDeps.entries(),
  ].toSorted(([a], [b]) => compareStrings(a, b))) {
    const sourceCatalog = workspacePolicy.catalogs[catalogName];
    if (sourceCatalog === undefined) {
      throw new Error(`Workspace policy catalogs is missing "${catalogName}"`);
    }
    const entries: Record<string, string> = {};
    for (const dep of [...deps].toSorted()) {
      const version = sourceCatalog[dep];
      if (version === undefined) {
        throw new Error(
          `Workspace policy catalog "${catalogName}" is missing "${dep}"`,
        );
      }
      entries[dep] = version;
    }
    if (Object.keys(entries).length > 0) {
      prunedNamedCatalogs[catalogName] = entries;
    }
  }

  const selectedPackages = new Set<string>(Object.keys(prunedCatalog));
  for (const named of Object.values(prunedNamedCatalogs)) {
    for (const dep of Object.keys(named)) {
      selectedPackages.add(dep);
    }
  }

  const prunedExclusions = workspacePolicy.minimumReleaseAgeExclude.filter(
    (item) => selectedPackages.has(item),
  );

  const allowBuilds: Record<string, boolean> = {
    ...workspacePolicy.allowBuilds,
  };

  const prunedOverrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(workspacePolicy.overrides)) {
    const leadingPkg = extractOverrideLeadingPackage(key);
    if (selectedPackages.has(leadingPkg)) {
      prunedOverrides[key] = value;
    }
  }

  const workspaceObj: Record<string, unknown> = {
    nodeLinker: workspacePolicy.nodeLinker,
    preferSymlinkedExecutables: workspacePolicy.preferSymlinkedExecutables,
    shellEmulator: workspacePolicy.shellEmulator,
    autoInstallPeers: workspacePolicy.autoInstallPeers,
    injectWorkspacePackages: workspacePolicy.injectWorkspacePackages,
    dedupeInjectedDeps: workspacePolicy.dedupeInjectedDeps,
    syncInjectedDepsAfterScripts: [
      ...workspacePolicy.syncInjectedDepsAfterScripts,
    ],
    minimumReleaseAge: workspacePolicy.minimumReleaseAge,
    minimumReleaseAgeStrict: workspacePolicy.minimumReleaseAgeStrict,
    ...(Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(Object.keys(prunedOverrides).length > 0
      ? { overrides: prunedOverrides }
      : {}),
    ...(prunedExclusions.length > 0
      ? { minimumReleaseAgeExclude: prunedExclusions }
      : {}),
    packages: [...collections].toSorted(),
    ...(Object.keys(prunedCatalog).length > 0
      ? { catalog: prunedCatalog }
      : {}),
    ...(Object.keys(prunedNamedCatalogs).length > 0
      ? { catalogs: prunedNamedCatalogs }
      : {}),
  };

  return stringifyYaml(workspaceObj);
}

function collectInstanceFiles(
  instance: PackageInstance,
  source: SourceContext,
): Map<string, PackageContribution> {
  const localFiles = new Map<string, PackageContribution>();
  const normalizedSourceDir = normalizeRelativePackagePath(
    instance.referencePackage.sourceDir,
  );
  if (normalizedSourceDir === undefined) {
    throw new ProjectValidationError([
      {
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: `Package "${instance.path}" source directory "${instance.referencePackage.sourceDir}" escapes source context.`,
      },
    ]);
  }

  const scanned = source.listPackageFiles(normalizedSourceDir, {
    includeResources: false,
  });

  const rewriteEntry = (
    targetPath: string,
    bytes: Uint8Array,
    executable: boolean,
  ): void => {
    const normalized = normalizeRelativePackagePath(targetPath);
    if (normalized === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${instance.path}" emitted invalid path "${targetPath}".`,
        },
      ]);
    }
    if (localFiles.has(normalized)) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${instance.path}" emitted conflicting duplicate path "${normalized}".`,
        },
      ]);
    }

    let finalContent: Uint8Array;
    if (isBinaryContent(normalized, bytes)) {
      finalContent = bytes;
    } else {
      const rawText = decoder.decode(bytes);
      if (normalized === "package.json") {
        finalContent = encoder.encode(
          rewriteSubpackageManifest({
            rawJson: rawText,
            leafName: instance.leafName,
            packageName: instance.packageName,
            dependencyBindings: instance.dependencyBindings,
            linkedProviders: instance.linkedProviders,
          }),
        );
      } else if (normalized === "turbo.json") {
        finalContent = encoder.encode(
          rewriteSubpackageTurboConfig({
            rawJson: rawText,
            dependencyBindings: instance.dependencyBindings,
          }),
        );
      } else {
        finalContent = encoder.encode(
          rewriteTextSpecifiers({
            text: rawText,
            dependencyBindings: instance.dependencyBindings,
          }),
        );
      }
    }

    localFiles.set(normalized, {
      targetPath: normalized,
      content: finalContent,
      executable,
    });
  };

  for (const file of scanned) {
    rewriteEntry(file.relativePath, file.content, file.executable);
  }

  for (const resource of instance.referencePackage.resources ?? []) {
    const normalizedSource = normalizeRelativePackagePath(resource.sourcePath);
    const normalizedTarget = normalizeRelativePackagePath(resource.targetPath);
    if (normalizedSource === undefined || normalizedTarget === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${instance.path}" resource "${resource.sourcePath}" -> "${resource.targetPath}" escapes package directory.`,
        },
      ]);
    }
    const sourceFile = source.readPackageFile(
      normalizedSourceDir,
      normalizedSource,
    );
    rewriteEntry(
      normalizedTarget,
      sourceFile.content,
      resource.executable ?? sourceFile.executable,
    );
  }

  return localFiles;
}

function synthesizeWorkspaceRoot(options: {
  readonly blueprint: ProjectBlueprint;
  readonly workspaceRoot: WorkspaceRoot;
  readonly source: SourceContext;
  readonly workspacePolicy: WorkspacePolicy;
  readonly hasDevScript: boolean;
  readonly hasPublishable: boolean;
  readonly defaultCatalogDeps: Set<string>;
  readonly namedCatalogDeps: Map<string, Set<string>>;
  readonly entriesByPath: Map<string, ProjectProjectionEntry>;
}): { readonly nodeVersion: string; readonly packageManagerPin: string } {
  const { workspaceRoot, blueprint, entriesByPath, source } = options;
  const subpackagePaths = blueprint.instances.map((instance) => instance.path);
  const rootSourceDir = normalizeRelativePackagePath(workspaceRoot.sourceDir);
  if (rootSourceDir === undefined) {
    throw new ProjectValidationError([
      {
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: `Workspace root source directory "${workspaceRoot.sourceDir}" escapes source context.`,
      },
    ]);
  }

  const commitRootContribution = (
    rawTargetPath: string,
    content: Uint8Array,
    executable: boolean,
  ): void => {
    const normalized = normalizeRelativePackagePath(rawTargetPath);
    if (normalized === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Workspace root attempted to emit out-of-bounds path "${rawTargetPath}".`,
        },
      ]);
    }
    for (const subPath of subpackagePaths) {
      if (normalized === subPath || normalized.startsWith(`${subPath}/`)) {
        throw new ProjectValidationError([
          {
            code: "DIRECTORY_OWNERSHIP_VIOLATION",
            message: `Workspace root attempted to emit "${normalized}" inside subpackage "${subPath}".`,
          },
        ]);
      }
    }
    if (entriesByPath.has(normalized)) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Conflicting generated file path "${normalized}" in ProjectProjection.`,
        },
      ]);
    }
    entriesByPath.set(normalized, {
      path: normalized,
      content,
      executable,
    });
  };

  const commitRootText = (
    targetPath: string,
    text: string,
    executable = false,
  ): void => {
    commitRootContribution(targetPath, encoder.encode(text), executable);
  };

  const refRootJson = JSON.parse(
    source.readPackageText(rootSourceDir, "package.json"),
  ) as unknown;
  if (!isRecord(refRootJson)) {
    throw new Error("Reference workspace-root package.json must be an object.");
  }
  const {
    scripts,
    devDependencies,
    devEngines,
    nodeVersion,
    packageManagerPin,
  } = validateWorkspaceRootManifest(refRootJson);

  // Bind only singleton reference packages actually declared in workspace-root/package.json.
  const declaredRootDeps = collectManifestDependencyNames(refRootJson);
  const rootDependencyBindings = new Map<string, string>();
  for (const instance of blueprint.instances) {
    if (!instance.singleton) {
      continue;
    }
    const refPkgName =
      instance.referencePackage.packageName ??
      readManifestName(source, instance.referencePackage.sourceDir);
    if (refPkgName !== undefined && declaredRootDeps.has(refPkgName)) {
      rootDependencyBindings.set(refPkgName, instance.packageName);
    }
  }

  // 1. Copy/rewrite non-manifest regular files from workspace-root reference package.
  const scannedRootFiles = source.listPackageFiles(rootSourceDir, {
    includeResources: false,
  });

  for (const file of scannedRootFiles) {
    if (
      file.relativePath === "package.json" ||
      file.relativePath === "turbo.json"
    ) {
      continue;
    }
    if (isBinaryContent(file.relativePath, file.content)) {
      commitRootContribution(file.relativePath, file.content, file.executable);
    } else {
      commitRootText(
        file.relativePath,
        rewriteTextSpecifiers({
          text: decoder.decode(file.content),
          dependencyBindings: rootDependencyBindings,
        }),
        file.executable,
      );
    }
  }

  // 2. Emit declared root resources and (if publishable) publication resources.
  const rootResourceMappings = [
    ...(workspaceRoot.resources ?? []),
    ...(options.hasPublishable
      ? (workspaceRoot.publicationResources ?? [])
      : []),
  ];
  for (const resource of rootResourceMappings) {
    const normalizedSource = normalizeRelativePackagePath(resource.sourcePath);
    const normalizedTarget = normalizeRelativePackagePath(resource.targetPath);
    if (normalizedSource === undefined || normalizedTarget === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Workspace root resource "${resource.sourcePath}" -> "${resource.targetPath}" escapes package directory.`,
        },
      ]);
    }
    const sourceFile = source.readPackageFile(rootSourceDir, normalizedSource);
    const executable = resource.executable ?? sourceFile.executable;
    if (isBinaryContent(normalizedTarget, sourceFile.content)) {
      commitRootContribution(normalizedTarget, sourceFile.content, executable);
    } else {
      commitRootText(
        normalizedTarget,
        rewriteTextSpecifiers({
          text: decoder.decode(sourceFile.content),
          dependencyBindings: rootDependencyBindings,
        }),
        executable,
      );
    }
  }

  // 3. Synthesize root package.json once in memory and collect its catalog references directly.
  const rootManifest = buildRootPackageManifestObject({
    repositoryName: blueprint.repositoryName,
    scripts,
    devDependencies,
    devEngines,
    packageManagerPin,
    rootDependencyBindings,
    hasDevScript: options.hasDevScript,
    hasPublishable: options.hasPublishable,
  });
  collectManifestCatalogUsage(
    rootManifest,
    options.defaultCatalogDeps,
    options.namedCatalogDeps,
  );
  commitRootText("package.json", `${JSON.stringify(rootManifest, null, 2)}\n`);

  // 4. Deterministically rootify checked workspace-root/turbo.json in a single pass.
  const singletonConfigPaths: string[] = [];
  for (const instance of blueprint.instances) {
    if (!instance.singleton) {
      continue;
    }
    for (const configFile of ["oxfmt.config.ts", "oxlint.config.ts"] as const) {
      const candidate = `${instance.path}/${configFile}`;
      if (entriesByPath.has(candidate)) {
        singletonConfigPaths.push(candidate);
      }
    }
  }
  const rootTurboJson = rootifyWorkspaceTurboConfig({
    rawRefTurboJson: source.readPackageText(rootSourceDir, "turbo.json"),
    singletonConfigPaths,
    hasDevScript: options.hasDevScript,
    hasPublishable: options.hasPublishable,
  });
  commitRootText("turbo.json", rootTurboJson);

  // 5. Merge workspace environment declarations and emit .vscode, .devcontainer, and dependabot.yml.
  const envMerge = mergeWorkspaceEnvironment(
    workspaceRoot,
    blueprint.instances,
    { source, workspacePolicy: options.workspacePolicy },
  );
  if (!envMerge.ok) {
    throw new ProjectValidationError(envMerge.issues);
  }
  const { merged } = envMerge;

  commitRootText(
    ".vscode/extensions.json",
    formatJson({ recommendations: merged.vscode.extensions }),
  );
  commitRootText(".vscode/settings.json", formatJson(merged.vscode.settings));

  if (workspaceRoot.devcontainerBase === undefined) {
    throw new Error(
      "WorkspaceRoot must declare devcontainerBase paths for environment synthesis.",
    );
  }
  const baseDockerfilePath = normalizeRelativePackagePath(
    workspaceRoot.devcontainerBase.dockerfileSourcePath,
  );
  const baseTemplatePath = normalizeRelativePackagePath(
    workspaceRoot.devcontainerBase.templateSourcePath,
  );
  if (baseDockerfilePath === undefined || baseTemplatePath === undefined) {
    throw new ProjectValidationError([
      {
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message:
          "Workspace root devcontainerBase paths escape package directory.",
      },
    ]);
  }

  const dockerfileFragments = [
    source.readPackageText(rootSourceDir, baseDockerfilePath).trimEnd(),
    ...merged.devcontainer.layers.map((layer) =>
      source
        .readPackageText(layer.sourceDir, layer.dockerfileSourcePath)
        .trimEnd(),
    ),
  ];
  commitRootText(
    ".devcontainer/Dockerfile",
    `${dockerfileFragments.join("\n\n")}\n`,
  );

  const templateJson = JSON.parse(
    source.readPackageText(rootSourceDir, baseTemplatePath),
  ) as Record<string, unknown>;

  const buildConfig: Record<string, unknown> = isRecord(templateJson.build)
    ? { ...templateJson.build }
    : { dockerfile: "Dockerfile" };
  if (Object.keys(merged.devcontainer.buildArgs).length > 0) {
    buildConfig.args = merged.devcontainer.buildArgs;
  } else {
    delete buildConfig.args;
  }

  const baseContainerEnv = isRecord(templateJson.containerEnv)
    ? { ...templateJson.containerEnv }
    : {};
  const mergedContainerEnv: Record<string, unknown> = {
    ...baseContainerEnv,
    ...merged.devcontainer.containerEnv,
  };

  const devcontainerObj: Record<string, unknown> = {
    ...templateJson,
    name: blueprint.repositoryName,
    build: buildConfig,
    customizations: {
      vscode: {
        extensions: merged.vscode.extensions,
      },
    },
    ...(Object.keys(mergedContainerEnv).length > 0
      ? { containerEnv: mergedContainerEnv }
      : {}),
    mounts: merged.devcontainer.mounts,
  };
  commitRootText(
    ".devcontainer/devcontainer.json",
    formatJson(devcontainerObj),
  );

  const hasNpmGroups = Object.keys(merged.dependabot.npmGroups).length > 0;
  const dependabotUpdates = merged.dependabot.updates.map((update) => {
    const isRootNpm =
      update.packageEcosystem === "npm" && update.directory === "/";
    return {
      "package-ecosystem": update.packageEcosystem,
      directory: update.directory,
      schedule: { interval: update.interval ?? "weekly" },
      ...(isRootNpm && hasNpmGroups
        ? { groups: merged.dependabot.npmGroups }
        : {}),
      ...(update.ignore !== undefined && update.ignore.length > 0
        ? {
            ignore: update.ignore.map((rule) => ({
              "dependency-name": rule.dependencyName,
              ...(rule.updateTypes !== undefined
                ? { "update-types": [...rule.updateTypes] }
                : {}),
            })),
          }
        : {}),
    };
  });
  commitRootText(
    ".github/dependabot.yml",
    stringifyYaml({ version: 2, updates: dependabotUpdates }),
  );

  // 6. Emit pruned pnpm-workspace.yaml from instance top-level directories and collected catalog usage.
  commitRootText(
    "pnpm-workspace.yaml",
    synthesizePnpmWorkspaceYaml({
      instances: blueprint.instances,
      workspacePolicy: options.workspacePolicy,
      defaultCatalogDeps: options.defaultCatalogDeps,
      namedCatalogDeps: options.namedCatalogDeps,
    }),
  );

  return { nodeVersion, packageManagerPin };
}

/**
 * Synthesizes the complete in-memory `ProjectProjection` from a validated `ProjectBlueprint`,
 * an explicit `SourceContext`, and a `WorkspacePolicy`. Performs zero disk writes and enforces strict directory ownership.
 */
export function buildProjectProjection(
  blueprint: ProjectBlueprint,
  options: {
    readonly source: SourceContext;
    readonly workspacePolicy: WorkspacePolicy;
  },
): ProjectProjection {
  const entriesByPath = new Map<string, ProjectProjectionEntry>();

  const commitInstanceContribution = (
    instance: PackageInstance,
    contribution: PackageContribution,
  ): void => {
    const normalizedLocal = normalizeRelativePackagePath(
      contribution.targetPath,
    );
    if (normalizedLocal === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${instance.path}" attempted to emit out-of-bounds path "${contribution.targetPath}".`,
        },
      ]);
    }

    const repoTargetPath = `${instance.path}/${normalizedLocal}`;
    if (!repoTargetPath.startsWith(`${instance.path}/`)) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Subpackage "${instance.path}" attempted to emit out-of-bounds path "${repoTargetPath}".`,
        },
      ]);
    }

    if (entriesByPath.has(repoTargetPath)) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Conflicting generated file path "${repoTargetPath}" in ProjectProjection.`,
        },
      ]);
    }

    entriesByPath.set(repoTargetPath, {
      path: repoTargetPath,
      content: contribution.content,
      executable: contribution.executable,
    });
  };

  const hasPublishable = blueprint.instances.some(
    (instance) => instance.referencePackage.publishable,
  );

  let hasDevScript = false;
  const defaultCatalogDeps = new Set<string>();
  const namedCatalogDeps = new Map<string, Set<string>>();

  // 1. Collect, rewrite, and validate all homogeneous PackageInstances.
  for (const instance of blueprint.instances) {
    const baseFiles = collectInstanceFiles(instance, options.source);
    const finalFiles =
      instance.referencePackage.transformFiles !== undefined
        ? instance.referencePackage.transformFiles(baseFiles, {
            scope: blueprint.scope,
            repositoryName: blueprint.repositoryName,
            instance,
          })
        : baseFiles;

    const finalManifestEntry = finalFiles.get("package.json");
    if (finalManifestEntry !== undefined) {
      const finalManifestRaw = decoder.decode(finalManifestEntry.content);
      if (hasManifestDevScript(finalManifestRaw)) {
        hasDevScript = true;
      }
      collectManifestCatalogUsage(
        JSON.parse(finalManifestRaw) as Record<string, unknown>,
        defaultCatalogDeps,
        namedCatalogDeps,
      );
    }

    for (const [key, contribution] of finalFiles) {
      if (key !== contribution.targetPath) {
        throw new ProjectValidationError([
          {
            code: "DIRECTORY_OWNERSHIP_VIOLATION",
            message: `Package "${instance.path}" returned mismatched contribution key "${key}" vs "${contribution.targetPath}".`,
          },
        ]);
      }
      const normalizedKey = normalizeRelativePackagePath(key);
      if (normalizedKey === undefined || !baseFiles.has(normalizedKey)) {
        throw new ProjectValidationError([
          {
            code: "DIRECTORY_OWNERSHIP_VIOLATION",
            message: `Package "${instance.path}" transformFiles attempted to introduce unbacked file "${key}".`,
          },
        ]);
      }
      commitInstanceContribution(instance, contribution);
    }
  }

  // 2. Synthesize WorkspaceRoot in a single in-memory pass.
  const toolchain = synthesizeWorkspaceRoot({
    blueprint,
    workspaceRoot: blueprint.workspaceRoot,
    source: options.source,
    workspacePolicy: options.workspacePolicy,
    hasDevScript,
    hasPublishable,
    defaultCatalogDeps,
    namedCatalogDeps,
    entriesByPath,
  });

  const sortedEntries = [...entriesByPath.values()].toSorted((a, b) =>
    compareStrings(a.path, b.path),
  );

  return {
    blueprint,
    entries: sortedEntries,
    toolchain,
  };
}
