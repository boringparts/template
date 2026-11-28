import type { PackageManifestSummary, PackageRole } from "./types.ts";

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

function tryFormatInlineJsonArray(
  items: readonly unknown[],
  prefixWidth: number,
  printWidth: number,
): string | undefined {
  if (items.length === 0) {
    return "[]";
  }
  const inlineParts: string[] = [];
  for (const item of items) {
    if (Array.isArray(item)) {
      if (item.length === 0) {
        inlineParts.push("[]");
        continue;
      }
      return undefined;
    }
    if (isRecord(item)) {
      if (Object.keys(item).length === 0) {
        inlineParts.push("{}");
        continue;
      }
      return undefined;
    }
    inlineParts.push(JSON.stringify(item));
  }
  const candidate = `[${inlineParts.join(", ")}]`;
  return prefixWidth + candidate.length <= printWidth ? candidate : undefined;
}

function formatJsonValue(
  value: unknown,
  indent: number,
  prefixWidth: number,
  printWidth: number,
): string {
  if (Array.isArray(value)) {
    const inline = tryFormatInlineJsonArray(value, prefixWidth, printWidth);
    if (inline !== undefined) {
      return inline;
    }
    const childIndent = indent + 2;
    const pad = " ".repeat(childIndent);
    const items = value.map(
      (item) =>
        `${pad}${formatJsonValue(item, childIndent, childIndent, printWidth)}`,
    );
    return `[\n${items.join(",\n")}\n${" ".repeat(indent)}]`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return "{}";
    }
    const childIndent = indent + 2;
    const pad = " ".repeat(childIndent);
    const lines = entries.map(([key, entryValue]) => {
      const encodedKey = JSON.stringify(key);
      const entryPrefix = `${pad}${encodedKey}: `;
      return `${entryPrefix}${formatJsonValue(
        entryValue,
        childIndent,
        entryPrefix.length,
        printWidth,
      )}`;
    });
    return `{\n${lines.join(",\n")}\n${" ".repeat(indent)}}`;
  }
  return JSON.stringify(value);
}

/** Formats a JSON value using Prettier/oxfmt 80-column single-line array rules. */
export function formatJson(value: unknown, printWidth = 80): string {
  return `${formatJsonValue(value, 0, 0, printWidth)}\n`;
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

/** Summarizes a parsed package `package.json` for read-only workspace inspection. */
export function summarizePackageManifest(options: {
  readonly rawJson: string;
  readonly packageName: string;
  readonly path: string;
  readonly leafName: string;
  readonly role: PackageRole;
  readonly publishable: boolean;
}): PackageManifestSummary {
  const manifest = JSON.parse(options.rawJson) as Record<string, unknown>;
  const hasDevScript =
    isRecord(manifest.scripts) &&
    typeof manifest.scripts.dev === "string" &&
    manifest.scripts.dev.length > 0;
  const binNames = isRecord(manifest.bin) ? Object.keys(manifest.bin) : [];
  return {
    packageName: options.packageName,
    path: options.path,
    leafName: options.leafName,
    role: options.role,
    publishable: options.publishable,
    hasDevScript,
    binNames,
  };
}

/**
 * Rewrites a subpackage `package.json`:
 * - assigns the instantiated package name
 * - automatically rewrites a single-entry `bin` object key to the instantiated leaf name
 * - unconditionally removes the author-only `"./reference"` export while preserving runtime exports
 * - rewrites bound `@boringparts/reference-*` dependencies via `dependencyBindings`
 * - injects `"workspace:*"` dependencies for explicit `--link` providers
 */
export function rewriteSubpackageManifest(options: {
  readonly rawJson: string;
  readonly leafName: string;
  readonly packageName: string;
  readonly dependencyBindings: ReadonlyMap<string, string>;
  readonly linkedProviders: readonly string[];
}): string {
  const manifest = JSON.parse(options.rawJson) as Record<string, unknown>;
  manifest.name = options.packageName;

  if (isRecord(manifest.bin)) {
    const binEntries = Object.entries(manifest.bin);
    if (binEntries.length === 1) {
      manifest.bin = { [options.leafName]: binEntries[0]![1] };
    }
  }

  if (
    isRecord(manifest.exports) &&
    Object.hasOwn(manifest.exports, "./reference")
  ) {
    delete manifest.exports["./reference"];
    if (Object.keys(manifest.exports).length === 0) {
      delete manifest.exports;
    }
  }

  if (isRecord(manifest.scripts)) {
    const rewrittenScripts: Record<string, unknown> = {};
    for (const [scriptName, scriptCmd] of Object.entries(manifest.scripts)) {
      rewrittenScripts[scriptName] =
        typeof scriptCmd === "string"
          ? rewriteTextSpecifiers({
              text: scriptCmd,
              dependencyBindings: options.dependencyBindings,
            })
          : scriptCmd;
    }
    manifest.scripts = rewrittenScripts;
  }

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
      const bound = options.dependencyBindings.get(dep);
      if (bound !== undefined) {
        rewritten[bound] = "workspace:*";
      } else {
        rewritten[dep] = spec;
      }
    }
    const sortedRewritten = Object.fromEntries(
      Object.entries(rewritten).toSorted(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    manifest[field] = sortedRewritten;
  }

  if (options.linkedProviders.length > 0) {
    const existingDeps = isRecord(manifest.dependencies)
      ? { ...manifest.dependencies }
      : {};
    for (const providerName of options.linkedProviders) {
      existingDeps[providerName] = "workspace:*";
    }
    const sortedDeps = Object.fromEntries(
      Object.entries(existingDeps).toSorted(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    );
    manifest.dependencies = sortedDeps;
  }

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Rewrites reference package identifiers inside a subpackage `turbo.json` task graph. */
export function rewriteSubpackageTurboConfig(options: {
  readonly rawJson: string;
  readonly dependencyBindings: ReadonlyMap<string, string>;
}): string {
  const config = JSON.parse(options.rawJson) as Record<string, unknown>;
  const tasks = config.tasks;
  if (!isRecord(tasks)) {
    return formatJson(config);
  }

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
      const boundPkg = options.dependencyBindings.get(pkgPrefix);
      return boundPkg === undefined ? entry : `${boundPkg}${taskSuffix}`;
    });
  }

  return formatJson(config);
}

/**
 * Deterministically replaces bound `@boringparts/reference-*` specifiers
 * in UTF-8 source, test, and config files.
 */
export function rewriteTextSpecifiers(options: {
  readonly text: string;
  readonly dependencyBindings: ReadonlyMap<string, string>;
}): string {
  const replacements: [string, string][] = [
    ...options.dependencyBindings.entries(),
  ];
  // Apply longest patterns first so prefix substrings never corrupt longer package names.
  replacements.sort(([left], [right]) => right.length - left.length);

  let output = options.text;
  for (const [from, to] of replacements) {
    output = output.replaceAll(from, to);
  }
  return output;
}
