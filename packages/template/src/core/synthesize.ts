import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  loadPackageSourceFiles,
  normalizeRelativePackagePath,
  type WorkspacePolicy,
} from "../sources/index.ts";
import {
  collectManifestCatalogUsage,
  formatJson,
  isBinaryContent,
  rewriteSubpackageManifest,
  rewriteSubpackageTurboConfig,
  rewriteTextSpecifiers,
  summarizePackageManifest,
} from "./transform.ts";
import {
  ProjectValidationError,
  type GeneratedInstance,
  type PackageFileContribution,
  type PackageManifestSummary,
  type ProjectBlueprint,
  type ProjectProjection,
  type ProjectProjectionEntry,
  type WorkspaceTemplateRoots,
} from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

function readBytes(filePath: string): {
  readonly bytes: Uint8Array;
  readonly executable: boolean;
} {
  const bytes = readFileSync(filePath);
  const stats = statSync(filePath);
  return { bytes, executable: (stats.mode & 0o111) !== 0 };
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

function resolveAuthorToolchain(refRootJson: Record<string, unknown>): {
  readonly devEngines: Record<string, unknown>;
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
} {
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
  return { devEngines, nodeVersion, packageManagerPin };
}

function synthesizeRootBaseManifest<TMeta>(options: {
  readonly blueprint: ProjectBlueprint<TMeta>;
  readonly devEngines: Record<string, unknown>;
  readonly packageManagerPin: string;
  readonly refRootJson: Record<string, unknown>;
  readonly rootDependencyBindings: ReadonlyMap<string, string>;
  readonly hasDevScript: boolean;
}): string {
  const scripts: Record<string, string> = isRecord(options.refRootJson.scripts)
    ? { ...(options.refRootJson.scripts as Record<string, string>) }
    : {};
  if (options.hasDevScript) {
    scripts.dev = "turbo run dev";
  }

  const devDependencies: Record<string, string> = {};
  const refDevDeps = isRecord(options.refRootJson.devDependencies)
    ? (options.refRootJson.devDependencies as Record<string, string>)
    : {};
  for (const [dep, spec] of Object.entries(refDevDeps)) {
    const bound = options.rootDependencyBindings.get(dep);
    if (bound !== undefined) {
      devDependencies[bound] = "workspace:*";
    } else {
      devDependencies[dep] = spec;
    }
  }

  const sortedDevDeps = Object.fromEntries(
    Object.entries(devDependencies).toSorted(([a], [b]) => a.localeCompare(b)),
  );

  const rootManifest: Record<string, unknown> = {
    name: options.blueprint.repositoryName,
    private: true,
    type: "module",
    scripts,
    devDependencies: sortedDevDeps,
    devEngines: options.devEngines,
    packageManager: options.packageManagerPin,
  };

  return `${JSON.stringify(rootManifest, null, 2)}\n`;
}

function synthesizeRootBaseTurboJson(options: {
  readonly hasDevScript: boolean;
}): string {
  const tasks: Record<string, unknown> = {
    "//#boundaries": { tags: ["quality:light"] },
    "//#check": { tags: ["quality:entry"] },
    "//#check:full": { tags: ["quality:entry"] },
    "//#check:heavy": { tags: ["quality:entry"] },
    "//#fix": { tags: ["work:repair"] },
    "//#format:check": { outputs: [], tags: ["quality:light"] },
    "//#format:write": {
      cache: false,
      dependsOn: ["//#lint:fix"],
      tags: ["work:repair"],
    },
    "//#lint": { dependsOn: ["^lint"], outputs: [], tags: ["quality:light"] },
    "//#lint:fix": { cache: false, tags: ["work:repair"] },
    "//#typecheck": { outputs: [], tags: ["quality:light"] },
  };

  if (options.hasDevScript) {
    tasks["//#dev"] = {
      cache: false,
      persistent: true,
      tags: ["work:development"],
    };
  }

  return formatJson({
    globalDependencies: [
      "oxfmt.config.ts",
      "oxlint.config.ts",
      "packages/tooling-config/oxfmt.config.ts",
      "packages/tooling-config/oxlint.config.ts",
    ],
    tasks,
    boundaries: {
      tags: {
        app: { dependencies: { allow: ["app", "library"] } },
        library: { dependencies: { allow: ["library"] } },
        native: { dependencies: { allow: ["library"] } },
      },
    },
  });
}

function synthesizePnpmWorkspaceYaml<TMeta>(options: {
  readonly blueprint: ProjectBlueprint<TMeta>;
  readonly workspacePolicy: WorkspacePolicy;
  readonly defaultCatalogDeps: ReadonlySet<string>;
  readonly namedCatalogDeps: ReadonlyMap<string, ReadonlySet<string>>;
}): string {
  const collections = new Set<string>(["packages/*"]);
  for (const instance of options.blueprint.instances) {
    if (instance.path === ".") {
      continue;
    }
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
  ].toSorted(([a], [b]) => a.localeCompare(b))) {
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

  const prunedAllowBuilds: Record<string, boolean> = {
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
    ...(Object.keys(prunedAllowBuilds).length > 0
      ? { allowBuilds: prunedAllowBuilds }
      : {}),
    ...(Object.keys(prunedOverrides).length > 0
      ? { overrides: prunedOverrides }
      : {}),
    ...(prunedExclusions.length > 0
      ? { minimumReleaseAgeExclude: prunedExclusions }
      : {}),
    packages: [...collections].toSorted(),
    catalog: prunedCatalog,
    ...(Object.keys(prunedNamedCatalogs).length > 0
      ? { catalogs: prunedNamedCatalogs }
      : {}),
  };

  return stringifyYaml(workspaceObj);
}

function collectBaseInstanceFiles<TMeta>(
  instance: GeneratedInstance<TMeta>,
  options: {
    readonly blueprint: ProjectBlueprint<TMeta>;
    readonly devEngines: Record<string, unknown>;
    readonly packageManagerPin: string;
    readonly hasDevScript: boolean;
    readonly templatesRoot?: string;
  },
): Map<string, PackageFileContribution> {
  const localFiles = new Map<string, PackageFileContribution>();

  const setLocalFile = (
    rawTargetPath: string,
    content: Uint8Array,
    executable: boolean,
  ): void => {
    const normalized = normalizeRelativePackagePath(rawTargetPath);
    if (normalized === undefined) {
      throw new ProjectValidationError([
        {
          code: "DIRECTORY_OWNERSHIP_VIOLATION",
          message: `Package "${instance.path}" emitted invalid path "${rawTargetPath}".`,
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
    localFiles.set(normalized, {
      targetPath: normalized,
      content,
      executable,
    });
  };

  const scanned = loadPackageSourceFiles(instance.definition.packageDir, {
    includeResources: false,
    ...(options.templatesRoot === undefined
      ? {}
      : { templatesRoot: options.templatesRoot }),
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
    if (isBinaryContent(normalized, bytes)) {
      setLocalFile(normalized, bytes, executable);
      return;
    }

    const rawText = decoder.decode(bytes);
    if (normalized === "package.json") {
      if (instance.path === ".") {
        const refRootJson = JSON.parse(rawText) as Record<string, unknown>;
        const rootPackageJson = synthesizeRootBaseManifest({
          blueprint: options.blueprint,
          devEngines: options.devEngines,
          packageManagerPin: options.packageManagerPin,
          refRootJson,
          rootDependencyBindings: instance.dependencyBindings,
          hasDevScript: options.hasDevScript,
        });
        setLocalFile(targetPath, encoder.encode(rootPackageJson), executable);
      } else {
        setLocalFile(
          targetPath,
          encoder.encode(
            rewriteSubpackageManifest({
              rawJson: rawText,
              leafName: instance.leafName,
              packageName: instance.packageName,
              dependencyBindings: instance.dependencyBindings,
              linkedProviders: instance.linkedProviders,
            }),
          ),
          executable,
        );
      }
      return;
    }

    if (targetPath === "turbo.json") {
      if (instance.path === ".") {
        setLocalFile(
          targetPath,
          encoder.encode(
            synthesizeRootBaseTurboJson({
              hasDevScript: options.hasDevScript,
            }),
          ),
          executable,
        );
      } else {
        setLocalFile(
          targetPath,
          encoder.encode(
            rewriteSubpackageTurboConfig({
              rawJson: rawText,
              dependencyBindings: instance.dependencyBindings,
            }),
          ),
          executable,
        );
      }
      return;
    }

    setLocalFile(
      targetPath,
      encoder.encode(
        rewriteTextSpecifiers({
          text: rawText,
          dependencyBindings: instance.dependencyBindings,
        }),
      ),
      executable,
    );
  };

  for (const file of scanned) {
    const { bytes, executable } = readBytes(file.absPath);
    rewriteEntry(file.relativePath, bytes, executable);
  }

  for (const resource of instance.definition.resources ?? []) {
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
    const sourceAbs = path.join(
      instance.definition.packageDir,
      normalizedSource,
    );
    const { bytes, executable: sourceExecutable } = readBytes(sourceAbs);
    rewriteEntry(
      normalizedTarget,
      bytes,
      resource.executable ?? sourceExecutable,
    );
  }

  return localFiles;
}

/**
 * Synthesizes the complete in-memory `ProjectProjection` from a validated `ProjectBlueprint`
 * and workspace template roots. Performs zero disk writes and enforces strict directory ownership.
 */
export function buildProjectProjection<TMeta>(
  blueprint: ProjectBlueprint<TMeta>,
  roots: WorkspaceTemplateRoots<TMeta>,
): ProjectProjection<TMeta> {
  const entriesByPath = new Map<string, ProjectProjectionEntry>();
  const nonRootPaths = blueprint.instances
    .filter((instance) => instance.path !== ".")
    .map((instance) => instance.path);

  const commitInstanceContribution = (
    instance: GeneratedInstance<TMeta>,
    contribution: PackageFileContribution,
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

    const repoTargetPath =
      instance.path === "."
        ? normalizedLocal
        : `${instance.path}/${normalizedLocal}`;

    if (instance.path === ".") {
      for (const subPath of nonRootPaths) {
        if (
          repoTargetPath === subPath ||
          repoTargetPath.startsWith(`${subPath}/`)
        ) {
          throw new ProjectValidationError([
            {
              code: "DIRECTORY_OWNERSHIP_VIOLATION",
              message: `Root package attempted to emit "${repoTargetPath}" inside subpackage "${subPath}".`,
            },
          ]);
        }
      }
    } else if (!repoTargetPath.startsWith(`${instance.path}/`)) {
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

  const rootInstances = blueprint.instances.filter(
    (instance) => instance.path === ".",
  );
  const rootInstanceForToolchain = rootInstances[0];
  if (rootInstanceForToolchain === undefined) {
    throw new Error("Missing workspace-root base package in ProjectBlueprint.");
  }
  const refRootJson = JSON.parse(
    readText(
      path.join(rootInstanceForToolchain.definition.packageDir, "package.json"),
    ),
  ) as Record<string, unknown>;
  const { devEngines, nodeVersion, packageManagerPin } =
    resolveAuthorToolchain(refRootJson);

  const hasPublishable = blueprint.instances.some(
    (instance) => instance.definition.publishable,
  );

  const manifests = new Map<string, PackageManifestSummary>();
  const nonRootOutputs = new Map<
    GeneratedInstance<TMeta>,
    ReadonlyMap<string, PackageFileContribution>
  >();

  // 1. Collect and transform all non-root instances first so root synthesis sees final manifests.
  const nonRootInstances = blueprint.instances.filter(
    (instance) => instance.path !== ".",
  );
  for (const instance of nonRootInstances) {
    const baseFiles = collectBaseInstanceFiles(instance, {
      blueprint,
      devEngines,
      packageManagerPin,
      hasDevScript: false,
      ...(roots.templatesRoot === undefined
        ? {}
        : { templatesRoot: roots.templatesRoot }),
    });
    const manifestEntry = baseFiles.get("package.json");
    if (manifestEntry !== undefined) {
      manifests.set(
        instance.path,
        summarizePackageManifest({
          rawJson: decoder.decode(manifestEntry.content),
          packageName: instance.packageName,
          path: instance.path,
          leafName: instance.leafName,
          role: instance.definition.role,
          publishable: instance.definition.publishable,
        }),
      );
    }
    nonRootOutputs.set(instance, baseFiles);
  }

  const hasDevScript = [...manifests.values()].some((m) => m.hasDevScript);

  for (const instance of nonRootInstances) {
    const baseFiles = nonRootOutputs.get(instance)!;
    const finalFiles =
      instance.definition.transformFiles !== undefined
        ? instance.definition.transformFiles(baseFiles, {
            scope: blueprint.scope,
            repositoryName: blueprint.repositoryName,
            instance,
            instances: blueprint.instances,
            manifests,
            hasDevScript,
            hasPublishable,
          })
        : baseFiles;

    const finalManifestEntry = finalFiles.get("package.json");
    if (finalManifestEntry !== undefined) {
      manifests.set(
        instance.path,
        summarizePackageManifest({
          rawJson: decoder.decode(finalManifestEntry.content),
          packageName: instance.packageName,
          path: instance.path,
          leafName: instance.leafName,
          role: instance.definition.role,
          publishable: instance.definition.publishable,
        }),
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

  const finalHasDevScript = [...manifests.values()].some((m) => m.hasDevScript);

  // 2. Collect and transform root instances (`path === "."`) using the homogeneous model.
  for (const rootInstance of rootInstances) {
    const baseFiles = collectBaseInstanceFiles(rootInstance, {
      blueprint,
      devEngines,
      packageManagerPin,
      hasDevScript: finalHasDevScript,
      ...(roots.templatesRoot === undefined
        ? {}
        : { templatesRoot: roots.templatesRoot }),
    });
    const finalFiles =
      rootInstance.definition.transformFiles !== undefined
        ? rootInstance.definition.transformFiles(baseFiles, {
            scope: blueprint.scope,
            repositoryName: blueprint.repositoryName,
            instance: rootInstance,
            instances: blueprint.instances,
            manifests,
            hasDevScript: finalHasDevScript,
            hasPublishable,
          })
        : baseFiles;

    for (const [key, contribution] of finalFiles) {
      if (key !== contribution.targetPath) {
        throw new ProjectValidationError([
          {
            code: "DIRECTORY_OWNERSHIP_VIOLATION",
            message: `Root package returned mismatched contribution key "${key}" vs "${contribution.targetPath}".`,
          },
        ]);
      }
      commitInstanceContribution(rootInstance, contribution);
    }
  }

  // 3. Collect final catalog usage across all generated manifests and emit `pnpm-workspace.yaml`.
  const defaultCatalogDeps = new Set<string>();
  const namedCatalogDeps = new Map<string, Set<string>>();
  for (const entry of entriesByPath.values()) {
    if (entry.path === "package.json" || entry.path.endsWith("/package.json")) {
      const parsed = JSON.parse(decoder.decode(entry.content)) as Record<
        string,
        unknown
      >;
      collectManifestCatalogUsage(parsed, defaultCatalogDeps, namedCatalogDeps);
    }
  }

  const workspaceYaml = synthesizePnpmWorkspaceYaml({
    blueprint,
    workspacePolicy: roots.workspacePolicy,
    defaultCatalogDeps,
    namedCatalogDeps,
  });
  if (entriesByPath.has("pnpm-workspace.yaml")) {
    throw new ProjectValidationError([
      {
        code: "DIRECTORY_OWNERSHIP_VIOLATION",
        message: 'Conflicting generated file path "pnpm-workspace.yaml".',
      },
    ]);
  }
  entriesByPath.set("pnpm-workspace.yaml", {
    path: "pnpm-workspace.yaml",
    content: encoder.encode(workspaceYaml),
    executable: false,
  });

  const sortedEntries = [...entriesByPath.values()].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );

  return {
    blueprint,
    entries: sortedEntries,
    toolchain: {
      nodeVersion,
      packageManagerPin,
    },
  };
}
