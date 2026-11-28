import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  collectManifestCatalogUsage,
  formatJson,
  isBinaryContent,
  rewriteCargoToml,
  rewriteSubpackageManifest,
  rewriteSubpackageTurboConfig,
  rewriteTextSpecifiers,
  synthesizeWorkspaceCargoLock,
} from "./transform.ts";
import type {
  DevcontainerLayer,
  EditorCapability,
  ProjectBlueprint,
  ProjectProjection,
  ProjectProjectionEntry,
  WorkspaceTemplateRoots,
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

function listFilesRecursive(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

function resolveRustToolchainChannel(rustToolchainToml: string): string {
  const parsed = parseToml(rustToolchainToml);
  const toolchain = isRecord(parsed.toolchain) ? parsed.toolchain : undefined;
  const channel = toolchain?.channel;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error("Root rust-toolchain.toml must declare toolchain.channel");
  }
  return channel;
}

type EditorCapabilitiesManifest = {
  readonly capabilityOrder: readonly EditorCapability[];
  readonly capabilities: Readonly<
    Record<
      EditorCapability,
      {
        readonly extensions: readonly string[];
        readonly settings: Readonly<Record<string, unknown>>;
      }
    >
  >;
};

function synthesizeEditorFiles(options: {
  readonly capabilitiesJsonPath: string;
  readonly activeCapabilities: readonly EditorCapability[];
}): {
  readonly extensions: readonly string[];
  readonly extensionsJson: string;
  readonly settingsJson: string;
} {
  const manifest = JSON.parse(
    readText(options.capabilitiesJsonPath),
  ) as EditorCapabilitiesManifest;
  const activeSet = new Set(options.activeCapabilities);
  const extensions: string[] = [];
  const seenExt = new Set<string>();
  const settings: Record<string, unknown> = {};

  for (const capability of manifest.capabilityOrder) {
    if (!activeSet.has(capability)) {
      continue;
    }
    const config = manifest.capabilities[capability];
    for (const ext of config.extensions) {
      if (!seenExt.has(ext)) {
        seenExt.add(ext);
        extensions.push(ext);
      }
    }
    Object.assign(settings, config.settings);
  }

  return {
    extensions,
    extensionsJson: formatJson({ recommendations: extensions }),
    settingsJson: formatJson(settings),
  };
}

function synthesizeDevcontainer(options: {
  readonly blueprint: ProjectBlueprint;
  readonly roots: WorkspaceTemplateRoots;
  readonly extensions: readonly string[];
  readonly playwrightVersion?: string;
  readonly rustToolchainChannel?: string;
}): { readonly dockerfile: string; readonly devcontainerJson: string } {
  const envDir = path.join(
    options.roots.workspaceRootRefDir,
    "resources",
    "environment",
  );
  const fragments: string[] = [
    readText(path.join(envDir, "base.Dockerfile")).trimEnd(),
  ];

  const layerFileMap: Readonly<Record<DevcontainerLayer, string | undefined>> =
    {
      "github-cli": path.join(envDir, "devcontainer", "github-cli.Dockerfile"),
      "browser-test": path.join(
        envDir,
        "devcontainer",
        "browser-test.Dockerfile",
      ),
      shellcheck: path.join(envDir, "devcontainer", "shellcheck.Dockerfile"),
      "rust-toolchain": options.roots.rustLayerDockerfilePath,
    };

  for (const layer of options.blueprint.capabilities.devcontainerLayers) {
    const layerPath = layerFileMap[layer];
    if (layerPath === undefined) {
      throw new Error(
        `Devcontainer layer "${layer}" was requested but no snippet path is configured`,
      );
    }
    fragments.push(readText(layerPath).trimEnd());
  }

  const templateJson = JSON.parse(
    readText(path.join(envDir, "devcontainer", "workspace-template.json")),
  ) as Record<string, unknown>;

  const buildArgs: Record<string, string> = {};
  if (
    options.blueprint.capabilities.devcontainerLayers.includes("browser-test")
  ) {
    if (options.playwrightVersion === undefined) {
      throw new Error(
        "Root catalog must define @playwright/test when browser-test layer is enabled",
      );
    }
    buildArgs.PLAYWRIGHT_CLI_PACKAGE = `@playwright/test@${options.playwrightVersion}`;
  }
  if (
    options.blueprint.capabilities.devcontainerLayers.includes("rust-toolchain")
  ) {
    if (options.rustToolchainChannel === undefined) {
      throw new Error(
        "Root rust-toolchain.toml must declare channel when rust-toolchain layer is enabled",
      );
    }
    buildArgs.RUST_TOOLCHAIN = options.rustToolchainChannel;
  }

  const buildConfig: Record<string, unknown> = isRecord(templateJson.build)
    ? { ...templateJson.build }
    : { dockerfile: "Dockerfile" };
  if (Object.keys(buildArgs).length > 0) {
    buildConfig.args = buildArgs;
  } else {
    delete buildConfig.args;
  }

  const hasRustLayer =
    options.blueprint.capabilities.devcontainerLayers.includes(
      "rust-toolchain",
    );
  const mounts: Record<string, unknown>[] = [
    {
      type: "volume",
      source: "${devcontainerId}-pnpm-store",
      target: "/pnpm/store",
    },
  ];
  if (hasRustLayer) {
    mounts.push(
      {
        type: "volume",
        source: "${devcontainerId}-cargo-registry",
        target: "/usr/local/cargo/registry",
      },
      {
        type: "volume",
        source: "${devcontainerId}-cargo-git",
        target: "/usr/local/cargo/git",
      },
      {
        type: "volume",
        source: "${devcontainerId}-target",
        target: "${containerWorkspaceFolder}/target",
      },
    );
  }

  const baseContainerEnv = isRecord(templateJson.containerEnv)
    ? { ...templateJson.containerEnv }
    : {};
  if (hasRustLayer) {
    baseContainerEnv.RUST_BACKTRACE = "1";
  }

  const devcontainerObj: Record<string, unknown> = {
    ...templateJson,
    name: options.blueprint.repositoryName,
    build: buildConfig,
    customizations: {
      vscode: {
        extensions: options.extensions,
      },
    },
    ...(Object.keys(baseContainerEnv).length > 0
      ? { containerEnv: baseContainerEnv }
      : {}),
    mounts,
  };

  return {
    dockerfile: `${fragments.join("\n\n")}\n`,
    devcontainerJson: formatJson(devcontainerObj),
  };
}

function synthesizeDependabotYaml(
  blueprint: ProjectBlueprint,
  hasDrizzle: boolean,
): string {
  const updates: Record<string, unknown>[] = [
    {
      "package-ecosystem": "devcontainers",
      directory: "/",
      schedule: { interval: "weekly" },
    },
    {
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly" },
      ...(hasDrizzle
        ? {
            groups: {
              drizzle: {
                patterns: ["drizzle-*", "drizzle-orm"],
              },
            },
          }
        : {}),
      ignore: [
        {
          "dependency-name": "@types/node",
          "update-types": ["version-update:semver-major"],
        },
        {
          "dependency-name": "pnpm",
          "update-types": [
            "version-update:semver-major",
            "version-update:semver-minor",
            "version-update:semver-patch",
          ],
        },
      ],
    },
    {
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
    },
    {
      "package-ecosystem": "docker",
      directory: "/.devcontainer",
      schedule: { interval: "weekly" },
    },
  ];

  if (blueprint.capabilities.rootDockerDependabot) {
    updates.push({
      "package-ecosystem": "docker",
      directory: "/",
      schedule: { interval: "weekly" },
    });
  }
  if (blueprint.capabilities.cargoDependabot) {
    updates.push({
      "package-ecosystem": "cargo",
      directory: "/",
      schedule: { interval: "weekly" },
    });
  }
  if (blueprint.capabilities.rustWorkspace) {
    updates.push({
      "package-ecosystem": "rust-toolchain",
      directory: "/",
      schedule: { interval: "weekly" },
    });
  }

  return stringifyYaml({ version: 2, updates });
}

function synthesizeRootManifest(options: {
  readonly blueprint: ProjectBlueprint;
  readonly roots: WorkspaceTemplateRoots;
  readonly defaultCatalogDeps: Set<string>;
  readonly namedCatalogDeps: Map<string, Set<string>>;
}): {
  readonly rootPackageJson: string;
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
} {
  const authorRoot = JSON.parse(
    readText(options.roots.rootPackageJsonPath),
  ) as Record<string, unknown>;
  const refRoot = JSON.parse(
    readText(path.join(options.roots.workspaceRootRefDir, "package.json")),
  ) as Record<string, unknown>;

  const devEngines = isRecord(authorRoot.devEngines)
    ? authorRoot.devEngines
    : undefined;
  const runtime =
    devEngines !== undefined && isRecord(devEngines.runtime)
      ? devEngines.runtime
      : undefined;
  const nodeVersion =
    runtime !== undefined && typeof runtime.version === "string"
      ? runtime.version
      : "26.13.1";
  const packageManagerPin =
    typeof authorRoot.packageManager === "string"
      ? authorRoot.packageManager
      : "pnpm@12.21.0";

  const scripts: Record<string, string> = isRecord(refRoot.scripts)
    ? { ...(refRoot.scripts as Record<string, string>) }
    : {};
  if (options.blueprint.capabilities.hasPublishable) {
    scripts["publication:pack"] =
      "turbo run build && changeset pack --out-dir .changeset/packed";
    scripts["publication:publish"] =
      "changeset publish --from-pack-dir .changeset/packed";
  }
  if (options.blueprint.capabilities.rootDevFilterPackage !== undefined) {
    scripts.dev = `turbo run dev --filter=${options.blueprint.capabilities.rootDevFilterPackage}`;
  }

  const devDependencies: Record<string, string> = {};
  const refDevDeps = isRecord(refRoot.devDependencies)
    ? (refRoot.devDependencies as Record<string, string>)
    : {};
  for (const [dep, spec] of Object.entries(refDevDeps)) {
    if (dep === "@boringparts/reference-tooling-config") {
      devDependencies[`@${options.blueprint.scope}/tooling-config`] =
        "workspace:*";
    } else {
      devDependencies[dep] = spec;
    }
  }
  if (options.blueprint.capabilities.hasPublishable) {
    devDependencies["@changesets/cli"] = "catalog:";
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
    ...(devEngines === undefined ? {} : { devEngines }),
    packageManager: packageManagerPin,
  };

  collectManifestCatalogUsage(
    rootManifest,
    options.defaultCatalogDeps,
    options.namedCatalogDeps,
  );

  return {
    rootPackageJson: `${JSON.stringify(rootManifest, null, 2)}\n`,
    nodeVersion,
    packageManagerPin,
  };
}

function synthesizeRootTurboJson(blueprint: ProjectBlueprint): string {
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

  if (blueprint.capabilities.hasPublishable) {
    tasks["//#publication:pack"] = { tags: ["work:release"], cache: false };
    tasks["//#publication:publish"] = { tags: ["work:release"], cache: false };
  }
  if (blueprint.capabilities.rootDevFilterPackage !== undefined) {
    tasks["//#dev"] = {
      cache: false,
      persistent: true,
      tags: ["work:development"],
    };
  }

  return formatJson({
    ...(blueprint.capabilities.rustWorkspace
      ? {
          globalPassThroughEnv: [
            "CARGO_HOME",
            "RUSTUP_HOME",
            "RUSTUP_TOOLCHAIN",
          ],
        }
      : {}),
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
        ...(blueprint.capabilities.rustWorkspace
          ? { native: { dependencies: { allow: ["library"] } } }
          : {}),
      },
    },
  });
}

function synthesizePnpmWorkspaceYaml(options: {
  readonly blueprint: ProjectBlueprint;
  readonly authorWorkspaceYaml: Record<string, unknown>;
  readonly defaultCatalogDeps: ReadonlySet<string>;
  readonly namedCatalogDeps: ReadonlyMap<string, ReadonlySet<string>>;
}): {
  readonly yamlText: string;
  readonly playwrightVersion?: string;
} {
  const collections = new Set<string>(["packages/*"]);
  for (const instance of options.blueprint.instances) {
    const firstSegment = instance.path.split("/", 1)[0];
    if (firstSegment !== undefined && firstSegment.length > 0) {
      collections.add(`${firstSegment}/*`);
    }
  }

  const authorCatalog = isRecord(options.authorWorkspaceYaml.catalog)
    ? (options.authorWorkspaceYaml.catalog as Record<string, string>)
    : {};
  const authorNamedCatalogs = isRecord(options.authorWorkspaceYaml.catalogs)
    ? (options.authorWorkspaceYaml.catalogs as Record<
        string,
        Record<string, string>
      >)
    : {};

  const prunedCatalog: Record<string, string> = {};
  for (const dep of [...options.defaultCatalogDeps].toSorted()) {
    const version = authorCatalog[dep];
    if (version === undefined) {
      throw new Error(
        `Author pnpm-workspace.yaml catalog is missing dependency "${dep}"`,
      );
    }
    prunedCatalog[dep] = version;
  }

  const prunedNamedCatalogs: Record<string, Record<string, string>> = {};
  for (const [catalogName, deps] of [
    ...options.namedCatalogDeps.entries(),
  ].toSorted(([a], [b]) => a.localeCompare(b))) {
    const sourceCatalog = authorNamedCatalogs[catalogName];
    if (sourceCatalog === undefined) {
      throw new Error(
        `Author pnpm-workspace.yaml catalogs is missing "${catalogName}"`,
      );
    }
    const entries: Record<string, string> = {};
    for (const dep of [...deps].toSorted()) {
      const version = sourceCatalog[dep];
      if (version === undefined) {
        throw new Error(
          `Author pnpm-workspace.yaml catalog "${catalogName}" is missing "${dep}"`,
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

  const authorExclusions = Array.isArray(
    options.authorWorkspaceYaml.minimumReleaseAgeExclude,
  )
    ? (
        options.authorWorkspaceYaml.minimumReleaseAgeExclude as unknown[]
      ).filter(
        (item): item is string =>
          typeof item === "string" && selectedPackages.has(item),
      )
    : [];

  const authorAllowBuilds = isRecord(options.authorWorkspaceYaml.allowBuilds)
    ? (options.authorWorkspaceYaml.allowBuilds as Record<string, boolean>)
    : {};
  const prunedAllowBuilds: Record<string, boolean> = {};
  for (const pkg of options.blueprint.capabilities.allowBuilds) {
    if (authorAllowBuilds[pkg] !== undefined) {
      prunedAllowBuilds[pkg] = authorAllowBuilds[pkg];
    }
  }

  const authorOverrides = isRecord(options.authorWorkspaceYaml.overrides)
    ? (options.authorWorkspaceYaml.overrides as Record<string, string>)
    : {};
  const prunedOverrides: Record<string, string> = {};
  for (const key of options.blueprint.capabilities.pnpmOverrides) {
    if (authorOverrides[key] !== undefined) {
      prunedOverrides[key] = authorOverrides[key];
    }
  }

  const workspaceObj: Record<string, unknown> = {
    nodeLinker: options.authorWorkspaceYaml.nodeLinker ?? "isolated",
    preferSymlinkedExecutables:
      options.authorWorkspaceYaml.preferSymlinkedExecutables ?? true,
    shellEmulator: options.authorWorkspaceYaml.shellEmulator ?? true,
    autoInstallPeers: options.authorWorkspaceYaml.autoInstallPeers ?? false,
    injectWorkspacePackages:
      options.authorWorkspaceYaml.injectWorkspacePackages ?? false,
    dedupeInjectedDeps: options.authorWorkspaceYaml.dedupeInjectedDeps ?? false,
    syncInjectedDepsAfterScripts: options.authorWorkspaceYaml
      .syncInjectedDepsAfterScripts ?? ["build"],
    minimumReleaseAge: options.authorWorkspaceYaml.minimumReleaseAge ?? 1440,
    minimumReleaseAgeStrict:
      options.authorWorkspaceYaml.minimumReleaseAgeStrict ?? true,
    ...(Object.keys(prunedAllowBuilds).length > 0
      ? { allowBuilds: prunedAllowBuilds }
      : {}),
    ...(Object.keys(prunedOverrides).length > 0
      ? { overrides: prunedOverrides }
      : {}),
    ...(authorExclusions.length > 0
      ? { minimumReleaseAgeExclude: authorExclusions }
      : {}),
    packages: [...collections].toSorted(),
    catalog: prunedCatalog,
    ...(Object.keys(prunedNamedCatalogs).length > 0
      ? { catalogs: prunedNamedCatalogs }
      : {}),
  };

  const playwrightVersion = authorCatalog["@playwright/test"];
  return {
    yamlText: stringifyYaml(workspaceObj),
    ...(playwrightVersion === undefined ? {} : { playwrightVersion }),
  };
}

/**
 * Synthesizes the complete in-memory `ProjectProjection` from a validated `ProjectBlueprint`
 * and workspace template roots. Performs zero disk writes.
 */
export function buildProjectProjection(
  blueprint: ProjectBlueprint,
  roots: WorkspaceTemplateRoots,
): ProjectProjection {
  const entriesByPath = new Map<string, ProjectProjectionEntry>();
  const addText = (
    targetPath: string,
    textContent: string,
    executable = false,
  ): void => {
    if (entriesByPath.has(targetPath)) {
      throw new Error(
        `Conflicting generated file path "${targetPath}" in ProjectProjection.`,
      );
    }
    entriesByPath.set(targetPath, {
      path: targetPath,
      content: encoder.encode(textContent),
      executable,
    });
  };
  const addBinary = (
    targetPath: string,
    bytes: Uint8Array,
    executable = false,
  ): void => {
    if (entriesByPath.has(targetPath)) {
      throw new Error(
        `Conflicting generated file path "${targetPath}" in ProjectProjection.`,
      );
    }
    entriesByPath.set(targetPath, {
      path: targetPath,
      content: bytes,
      executable,
    });
  };

  const defaultCatalogDeps = new Set<string>();
  const namedCatalogDeps = new Map<string, Set<string>>();

  // 1. Singleton packages/tooling-config
  const emptyBindings = new Map<string, string>();
  const emptyPaths = new Map<string, string>();
  const toolingFiles = listFilesRecursive(roots.toolingConfigDir);
  for (const absPath of toolingFiles) {
    const rel = path.relative(roots.toolingConfigDir, absPath);
    const normalizedRel = rel.split(path.sep).join("/");
    const targetPath = `packages/tooling-config/${normalizedRel}`;
    if (normalizedRel === "package.json") {
      addText(
        targetPath,
        rewriteSubpackageManifest({
          rawJson: readText(absPath),
          scope: blueprint.scope,
          leafName: "tooling-config",
          packageName: `@${blueprint.scope}/tooling-config`,
          dependencyBindings: emptyBindings,
          linkedProviders: [],
          defaultCatalogDeps,
          namedCatalogDeps,
        }),
      );
    } else {
      const { bytes, executable } = readBytes(absPath);
      if (isBinaryContent(normalizedRel, bytes)) {
        addBinary(targetPath, bytes, executable);
      } else {
        addText(
          targetPath,
          rewriteTextSpecifiers({
            text: decoder.decode(bytes),
            scope: blueprint.scope,
            dependencyBindings: emptyBindings,
            pathReplacements: emptyPaths,
          }),
          executable,
        );
      }
    }
  }

  // 2. Instantiate each planned reference package
  for (const instance of blueprint.instances) {
    for (const file of instance.reference.files) {
      const sourceAbs = path.join(
        instance.reference.packageDir,
        file.sourcePath,
      );
      const targetPath = `${instance.path}/${file.targetPath}`;
      const { bytes, executable: sourceExecutable } = readBytes(sourceAbs);
      const executable = file.executable ?? sourceExecutable;

      if (isBinaryContent(file.sourcePath, bytes)) {
        addBinary(targetPath, bytes, executable);
        continue;
      }

      const rawText = decoder.decode(bytes);
      if (file.targetPath === "package.json") {
        addText(
          targetPath,
          rewriteSubpackageManifest({
            rawJson: rawText,
            scope: blueprint.scope,
            leafName: instance.leafName,
            packageName: instance.packageName,
            ...(instance.reference.rewriteBinName === undefined
              ? {}
              : { rewriteBinName: instance.reference.rewriteBinName }),
            dependencyBindings: instance.dependencyBindings,
            pathReplacements: instance.pathReplacements,
            linkedProviders: instance.linkedProviders,
            defaultCatalogDeps,
            namedCatalogDeps,
          }),
          executable,
        );
      } else if (file.targetPath === "turbo.json") {
        addText(
          targetPath,
          rewriteSubpackageTurboConfig({
            rawJson: rawText,
            scope: blueprint.scope,
            dependencyBindings: instance.dependencyBindings,
          }),
          executable,
        );
      } else if (
        instance.reference.rustPackageName !== undefined &&
        file.targetPath === "Cargo.toml"
      ) {
        addText(
          targetPath,
          rewriteCargoToml({
            rawToml: rawText,
            fromPackageName: instance.reference.rustPackageName,
            toPackageName: instance.leafName,
          }),
          executable,
        );
      } else {
        addText(
          targetPath,
          rewriteTextSpecifiers({
            text: rawText,
            scope: blueprint.scope,
            dependencyBindings: instance.dependencyBindings,
            pathReplacements: instance.pathReplacements,
          }),
          executable,
        );
      }
    }

    for (const rootFile of instance.reference.rootFiles ?? []) {
      const sourceAbs = path.join(
        instance.reference.packageDir,
        rootFile.sourcePath,
      );
      const { bytes, executable: sourceExecutable } = readBytes(sourceAbs);
      addBinary(
        rootFile.targetPath,
        bytes,
        rootFile.executable ?? sourceExecutable,
      );
    }
  }

  // 3. Shared workspace-root assets (copied verbatim or rewritten for scope)
  const rewriteRootText = (textContent: string): string =>
    rewriteTextSpecifiers({
      text: textContent,
      scope: blueprint.scope,
      dependencyBindings: emptyBindings,
      pathReplacements: emptyPaths,
    });

  addText(
    ".gitignore",
    readText(path.join(roots.workspaceRootRefDir, "resources", "gitignore")),
  );
  addText(
    "AGENTS.md",
    readText(
      path.join(
        roots.workspaceRootRefDir,
        "resources",
        "agent-instructions.md",
      ),
    ),
  );
  addText(
    "scripts/task-gates.ts",
    readText(path.join(roots.workspaceRootRefDir, "scripts", "task-gates.ts")),
  );
  addText(
    "tsconfig.json",
    readText(path.join(roots.workspaceRootRefDir, "tsconfig.json")),
  );
  addText(
    "tsconfig.config.json",
    rewriteRootText(
      readText(path.join(roots.workspaceRootRefDir, "tsconfig.config.json")),
    ),
  );
  addText(
    "tsconfig.scripts.json",
    readText(path.join(roots.workspaceRootRefDir, "tsconfig.scripts.json")),
  );
  addText(
    "oxfmt.config.ts",
    rewriteRootText(
      readText(path.join(roots.workspaceRootRefDir, "oxfmt.config.ts")),
    ),
  );
  addText(
    "oxlint.config.ts",
    rewriteRootText(
      readText(path.join(roots.workspaceRootRefDir, "oxlint.config.ts")),
    ),
  );
  addText(
    ".github/workflows/check.yml",
    readText(
      path.join(roots.workspaceRootRefDir, "resources", "github", "check.yml"),
    ),
  );

  // 4. Optional npm-publication (enabled automatically whenever any package is publishable)
  if (blueprint.capabilities.hasPublishable) {
    addText(
      ".changeset/config.json",
      readText(
        path.join(
          roots.workspaceRootRefDir,
          "resources",
          "publication",
          "config.json",
        ),
      ),
    );
    addText(
      ".github/workflows/release.yml",
      readText(
        path.join(
          roots.workspaceRootRefDir,
          "resources",
          "publication",
          "release.yml",
        ),
      ),
    );
  }

  // 5. Optional Rust workspace root & toolchain
  let rustToolchainChannel: string | undefined;
  if (
    blueprint.capabilities.rustWorkspace ||
    blueprint.capabilities.devcontainerLayers.includes("rust-toolchain")
  ) {
    const toolchainText = readText(roots.rootRustToolchainPath);
    rustToolchainChannel = resolveRustToolchainChannel(toolchainText);
    if (blueprint.capabilities.rustWorkspace) {
      addText("rust-toolchain.toml", toolchainText);
      const rustInstances = blueprint.instances.filter(
        (instance) => instance.reference.rustPackageName !== undefined,
      );
      const crateMembers = rustInstances.map((instance) => instance.path);
      addText(
        "Cargo.toml",
        `[workspace]\nresolver = "3"\nmembers = ${JSON.stringify(crateMembers)}\n\n[profile.release]\nstrip = "symbols"\nlto = "thin"\ncodegen-units = 1\n`,
      );
      if (rustInstances.length > 0) {
        addText(
          "Cargo.lock",
          synthesizeWorkspaceCargoLock(
            rustInstances.map((instance) => ({
              fromPackageName: instance.reference.rustPackageName!,
              toPackageName: instance.leafName,
              rawLockfile: readText(
                roots.rustLockfilePath ??
                  path.join(instance.reference.packageDir, "Cargo.lock"),
              ),
            })),
          ),
        );
      }
    }
  }

  // 6. Synthesize root package.json, turbo.json, .vscode/*, .github/dependabot.yml, pnpm-workspace.yaml, .devcontainer/*
  const { rootPackageJson, nodeVersion, packageManagerPin } =
    synthesizeRootManifest({
      blueprint,
      roots,
      defaultCatalogDeps,
      namedCatalogDeps,
    });
  addText("package.json", rootPackageJson);
  addText("turbo.json", synthesizeRootTurboJson(blueprint));
  addText(
    ".github/dependabot.yml",
    synthesizeDependabotYaml(
      blueprint,
      defaultCatalogDeps.has("drizzle-orm") ||
        defaultCatalogDeps.has("drizzle-kit"),
    ),
  );

  const editor = synthesizeEditorFiles({
    capabilitiesJsonPath: path.join(
      roots.workspaceRootRefDir,
      "resources",
      "environment",
      "editor-customization",
      "capabilities.json",
    ),
    activeCapabilities: blueprint.capabilities.editorCapabilities,
  });
  addText(".vscode/extensions.json", editor.extensionsJson);
  addText(".vscode/settings.json", editor.settingsJson);

  const authorWorkspaceYaml = parseYaml(
    readText(roots.rootPnpmWorkspaceYamlPath),
  ) as Record<string, unknown>;
  const { yamlText: workspaceYaml, playwrightVersion } =
    synthesizePnpmWorkspaceYaml({
      blueprint,
      authorWorkspaceYaml,
      defaultCatalogDeps,
      namedCatalogDeps,
    });
  addText("pnpm-workspace.yaml", workspaceYaml);

  const devcontainer = synthesizeDevcontainer({
    blueprint,
    roots,
    extensions: editor.extensions,
    ...(playwrightVersion === undefined ? {} : { playwrightVersion }),
    ...(rustToolchainChannel === undefined ? {} : { rustToolchainChannel }),
  });
  addText(".devcontainer/Dockerfile", devcontainer.dockerfile);
  addText(".devcontainer/devcontainer.json", devcontainer.devcontainerJson);

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
