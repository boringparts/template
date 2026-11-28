import { readdirSync, statSync } from "node:fs";
import path from "node:path";

/** Directory names excluded during deterministic reference package scanning and distribution packaging. */
export const excludedPackageDirectoryNames: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "target",
  ".turbo",
  ".local",
  "test-results",
  "playwright-report",
  ".vitest",
  "coverage",
  ".pnpm-store",
]);

/** File names excluded during deterministic reference package scanning and distribution packaging. */
export const excludedPackageFileNames: ReadonlySet<string> = new Set([
  ".DS_Store",
]);

export type ScannedPackageFile = {
  /** Normalized POSIX path relative to the scanned package root. */
  readonly relativePath: string;
  /** Absolute filesystem path to the source file. */
  readonly absPath: string;
  /** Whether any executable bit (`0o111`) is set on the source file. */
  readonly executable: boolean;
  /** Raw permission mode bits (`stats.mode & 0o777`). */
  readonly mode: number;
};

/**
 * Validates and normalizes a package-relative POSIX path, rejecting empty strings,
 * absolute paths, backslashes, NUL bytes, and `.` or `..` traversal segments.
 */
export function normalizeRelativePackagePath(
  rawPath: string,
): string | undefined {
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.startsWith("/")
  ) {
    return undefined;
  }
  const segments = rawPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return undefined;
  }
  return segments.join("/");
}

function collectDirectoryEntries(
  currentDir: string,
  relativePrefix: string,
  includeResources: boolean,
  results: ScannedPackageFile[],
): void {
  const entries = readdirSync(currentDir, { withFileTypes: true }).toSorted(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedPackageDirectoryNames.has(entry.name)) {
        continue;
      }
      if (
        !includeResources &&
        relativePrefix === "" &&
        entry.name === "resources"
      ) {
        continue;
      }
      const nextPrefix =
        relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
      collectDirectoryEntries(
        path.join(currentDir, entry.name),
        nextPrefix,
        includeResources,
        results,
      );
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (
      excludedPackageFileNames.has(entry.name) ||
      entry.name.endsWith(".tsbuildinfo")
    ) {
      continue;
    }

    const absPath = path.join(currentDir, entry.name);
    const relativePath =
      relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
    const mode = statSync(absPath).mode & 0o777;
    results.push({
      relativePath,
      absPath,
      executable: (mode & 0o111) !== 0,
      mode,
    });
  }
}

/**
 * Deterministically scans a reference package directory, omitting runtime/build caches
 * and incremental TypeScript metadata while preserving source executable permissions.
 */
export function scanPackageDirectory(
  packageDir: string,
  options: { readonly includeResources: boolean },
): readonly ScannedPackageFile[] {
  const results: ScannedPackageFile[] = [];
  collectDirectoryEntries(packageDir, "", options.includeResources, results);
  return results;
}
