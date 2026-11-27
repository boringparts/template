import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const toolingConfigRefName = "@boringparts/tooling-config";
const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".wasm",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Detects whether a file should be treated as raw binary rather than UTF-8 text. */
export function isBinaryContent(filePath: string, bytes: Uint8Array): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex !== -1) {
    const extension = filePath.slice(dotIndex).toLowerCase();
    if (binaryExtensions.has(extension)) {
      return true;
    }
  }
  return bytes.includes(0);
}

/** Collects `catalog:` and `catalog:<name>` dependency names referenced by a parsed package manifest. */
export function collectManifestCatalogUsage(
  manifest: Record<string, unknown>,
  defaultDeps: Set<string>,
  namedDeps: Map<string, Set<string>>,
): void {
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const map = manifest[field];
    if (!isRecord(map)) {
      continue;
    }
    for (const [dep, spec] of Object.entries(map)) {
      if (typeof spec !== "string") {
        continue;
      }
      if (spec === "catalog:" || spec === "catalog:default") {
        defaultDeps.add(dep);
      } else if (spec.startsWith("catalog:")) {
        const catalogName = spec.slice("catalog:".length);
        if (catalogName.length > 0) {
          let entries = namedDeps.get(catalogName);
          if (entries === undefined) {
            entries = new Set<string>();
            namedDeps.set(catalogName, entries);
          }
          entries.add(dep);
        }
      }
    }
  }
}

/**
 * Rewrites a subpackage `package.json`:
 * - assigns the instantiated package name
 * - rewrites `bin` command key if `rewriteBinName` is enabled
 * - removes the author-only `"./package.json"` export
 * - rewrites `@boringparts/tooling-config` and bound `@boringparts/reference-*` dependencies
 * - injects `"workspace:*"` dependencies for explicit `--link` providers
 */
export function rewriteSubpackageManifest(options: {
  readonly rawJson: string;
  readonly scope: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly preservePackageJsonExport?: boolean;
  readonly rewriteBinName?: boolean;
  readonly packageBindings: ReadonlyMap<string, string>;
  readonly pathReplacements?: ReadonlyMap<string, string>;
  readonly linkedProviders: readonly string[];
  readonly defaultCatalogDeps: Set<string>;
  readonly namedCatalogDeps: Map<string, Set<string>>;
}): string {
  const manifest = JSON.parse(options.rawJson) as Record<string, unknown>;
  manifest.name = options.packageName;

  if (options.rewriteBinName && isRecord(manifest.bin)) {
    const binEntries = Object.entries(manifest.bin);
    if (binEntries.length === 1) {
      manifest.bin = { [options.leafName]: binEntries[0]![1] };
    }
  }

  if (
    !options.preservePackageJsonExport &&
    isRecord(manifest.exports) &&
    Object.hasOwn(manifest.exports, "./package.json")
  ) {
    delete manifest.exports["./package.json"];
    if (Object.keys(manifest.exports).length === 0) {
      delete manifest.exports;
    }
  }

  if (isRecord(manifest.scripts)) {
    const rewrittenScripts: Record<string, unknown> = {};
    const pathReplacements =
      options.pathReplacements ?? new Map<string, string>();
    for (const [scriptName, scriptCmd] of Object.entries(manifest.scripts)) {
      rewrittenScripts[scriptName] =
        typeof scriptCmd === "string"
          ? rewriteTextSpecifiers({
              text: scriptCmd,
              scope: options.scope,
              packageBindings: options.packageBindings,
              pathReplacements,
            })
          : scriptCmd;
    }
    manifest.scripts = rewrittenScripts;
  }

  const toolingReplacement = `@${options.scope}/tooling-config`;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const section = manifest[field];
    if (!isRecord(section)) {
      continue;
    }
    const rewritten: Record<string, unknown> = {};
    for (const [dep, spec] of Object.entries(section)) {
      if (dep === toolingConfigRefName) {
        rewritten[toolingReplacement] = "workspace:*";
      } else if (options.packageBindings.has(dep)) {
        rewritten[options.packageBindings.get(dep)!] = "workspace:*";
      } else {
        rewritten[dep] = spec;
      }
    }
    manifest[field] = rewritten;
  }

  if (options.linkedProviders.length > 0) {
    const existingDeps = isRecord(manifest.dependencies)
      ? { ...manifest.dependencies }
      : {};
    for (const providerName of options.linkedProviders) {
      existingDeps[providerName] = "workspace:*";
    }
    const sortedDeps = Object.fromEntries(
      Object.entries(existingDeps).toSorted(([a], [b]) => a.localeCompare(b)),
    );
    manifest.dependencies = sortedDeps;
  }

  collectManifestCatalogUsage(
    manifest,
    options.defaultCatalogDeps,
    options.namedCatalogDeps,
  );
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Rewrites reference package identifiers inside a subpackage `turbo.json` task graph. */
export function rewriteSubpackageTurboConfig(options: {
  readonly rawJson: string;
  readonly scope: string;
  readonly packageBindings: ReadonlyMap<string, string>;
}): string {
  const config = JSON.parse(options.rawJson) as Record<string, unknown>;
  const tasks = config.tasks;
  if (!isRecord(tasks)) {
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  const toolingReplacement = `@${options.scope}/tooling-config`;
  for (const taskConfig of Object.values(tasks)) {
    if (!isRecord(taskConfig) || !Array.isArray(taskConfig.dependsOn)) {
      continue;
    }
    taskConfig.dependsOn = taskConfig.dependsOn.map((entry: unknown) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const hashIndex = entry.indexOf("#");
      if (hashIndex === -1) {
        return entry;
      }
      const pkgPrefix = entry.slice(0, hashIndex);
      const taskSuffix = entry.slice(hashIndex);
      if (pkgPrefix === toolingConfigRefName) {
        return `${toolingReplacement}${taskSuffix}`;
      }
      const boundPkg = options.packageBindings.get(pkgPrefix);
      return boundPkg === undefined ? entry : `${boundPkg}${taskSuffix}`;
    });
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Rewrites the crate package name inside `Cargo.toml` or `Cargo.lock`. */
export function rewriteCargoToml(options: {
  readonly rawToml: string;
  readonly isLockfile: boolean;
  readonly fromPackageName: string;
  readonly toPackageName: string;
}): string {
  const parsed = parseToml(options.rawToml);
  if (!options.isLockfile) {
    if (
      isRecord(parsed.package) &&
      parsed.package.name === options.fromPackageName
    ) {
      parsed.package.name = options.toPackageName;
    }
  } else if (Array.isArray(parsed.package)) {
    for (const pkg of parsed.package) {
      if (
        isRecord(pkg) &&
        pkg.name === options.fromPackageName &&
        pkg.source === undefined
      ) {
        pkg.name = options.toPackageName;
      }
    }
  }
  return stringifyToml(parsed);
}

/**
 * Deterministically replaces `@boringparts/tooling-config`, bound `@boringparts/reference-*`
 * specifiers, and configured relative reference paths in UTF-8 source, test, and config files.
 */
export function rewriteTextSpecifiers(options: {
  readonly text: string;
  readonly scope: string;
  readonly packageBindings: ReadonlyMap<string, string>;
  readonly pathReplacements: ReadonlyMap<string, string>;
}): string {
  const replacements: [string, string][] = [
    [toolingConfigRefName, `@${options.scope}/tooling-config`],
    ...options.packageBindings.entries(),
    ...options.pathReplacements.entries(),
  ];
  // Apply longest patterns first so prefix substrings never corrupt longer package names.
  replacements.sort(([left], [right]) => right.length - left.length);

  let output = options.text;
  for (const [from, to] of replacements) {
    output = output.replaceAll(from, to);
  }
  return output;
}
