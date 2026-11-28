import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import { resolveTemplatePackageDir } from "./template-package-dir.ts";

export type ScannedPackageFile = {
  /** Normalized POSIX path relative to the scanned package root. */
  readonly relativePath: string;
  /** Absolute filesystem path to the source file. */
  readonly absPath: string;
  /** Raw file contents read during source enumeration. */
  readonly content: Uint8Array;
  /** Whether any executable bit (`0o111`) is set on the source file. */
  readonly executable: boolean;
  /** Raw permission mode bits (`stats.mode & 0o777`). */
  readonly mode: number;
};

export type ReadPackageSourceFileResult = {
  /** Normalized POSIX path relative to the package root. */
  readonly relativePath: string;
  /** Raw file contents. */
  readonly content: Uint8Array;
  /** Whether any executable bit (`0o111`) is set on the source file. */
  readonly executable: boolean;
  /** Raw permission mode bits (`stats.mode & 0o777`). */
  readonly mode: number;
};

let cachedAuthorRepoTopLevel: string | null | undefined;

function resolveAuthorRepoTopLevel(): string | undefined {
  if (cachedAuthorRepoTopLevel !== undefined) {
    return cachedAuthorRepoTopLevel ?? undefined;
  }

  const templatePkgDir = resolveTemplatePackageDir();
  if (
    templatePkgDir === undefined ||
    templatePkgDir.split(path.sep).includes("node_modules")
  ) {
    cachedAuthorRepoTopLevel = null;
    return undefined;
  }

  try {
    const rawTopLevel = execFileSync(
      "git",
      ["-C", templatePkgDir, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (rawTopLevel.length === 0) {
      cachedAuthorRepoTopLevel = null;
      return undefined;
    }
    cachedAuthorRepoTopLevel = realpathSync(rawTopLevel);
    return cachedAuthorRepoTopLevel;
  } catch {
    cachedAuthorRepoTopLevel = null;
    return undefined;
  }
}

function isGitManagedPackageDir(
  packageDir: string,
  templatesRoot?: string,
): boolean {
  // Never invoke `git ls-files` in packaged `templatesRoot` mode.
  if (templatesRoot !== undefined) {
    return false;
  }

  let resolvedTopLevel: string;
  let resolvedPkgDir: string;
  try {
    const rawTopLevel = execFileSync(
      "git",
      ["-C", packageDir, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (rawTopLevel.length === 0) {
      return false;
    }
    resolvedTopLevel = realpathSync(rawTopLevel);
    resolvedPkgDir = realpathSync(packageDir);
  } catch {
    return false;
  }

  const relativeFromRepo = path.relative(resolvedTopLevel, resolvedPkgDir);
  if (relativeFromRepo.startsWith("..") || path.isAbsolute(relativeFromRepo)) {
    return false;
  }

  const segments =
    relativeFromRepo === "" ? [] : relativeFromRepo.split(path.sep);
  if (
    segments.includes("templates") ||
    segments.includes("node_modules") ||
    segments.includes("dist") ||
    segments.some((segment) => segment.startsWith("."))
  ) {
    return false;
  }

  if (resolvedTopLevel === resolveAuthorRepoTopLevel()) {
    return true;
  }

  // Only treat external directories as Git-managed if they already have tracked files in their Git index.
  try {
    const cachedFiles = execFileSync(
      "git",
      ["-C", resolvedPkgDir, "ls-files", "--cached", "-z", "."],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return cachedFiles.length > 0;
  } catch {
    return false;
  }
}

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

function loadGitListedPackageFiles(
  packageDir: string,
  includeResources: boolean,
): readonly ScannedPackageFile[] {
  const stdout = execFileSync(
    "git",
    [
      "-C",
      packageDir,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      ".",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const uniquePaths = [...new Set(stdout.split("\0").filter(Boolean))].toSorted(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  );

  const results: ScannedPackageFile[] = [];
  for (const rawPath of uniquePaths) {
    const relativePath = normalizeRelativePackagePath(rawPath);
    if (relativePath === undefined) {
      continue;
    }
    if (
      !includeResources &&
      (relativePath === "resources" || relativePath.startsWith("resources/"))
    ) {
      continue;
    }

    const absPath = path.join(packageDir, relativePath);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(absPath);
    } catch {
      // Skip paths tracked in the Git index that were deleted in the working tree.
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    const mode = stats.mode & 0o777;
    results.push({
      relativePath,
      absPath,
      content: readFileSync(absPath),
      executable: (mode & 0o111) !== 0,
      mode,
    });
  }

  return results;
}

function collectStaticDirectoryEntries(
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
      if (
        !includeResources &&
        relativePrefix === "" &&
        entry.name === "resources"
      ) {
        continue;
      }
      const nextPrefix =
        relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
      collectStaticDirectoryEntries(
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

    const absPath = path.join(currentDir, entry.name);
    const relativePath =
      relativePrefix === "" ? entry.name : `${relativePrefix}/${entry.name}`;
    const mode = statSync(absPath).mode & 0o777;
    results.push({
      relativePath,
      absPath,
      content: readFileSync(absPath),
      executable: (mode & 0o111) !== 0,
      mode,
    });
  }
}

/**
 * Lists clean source files and reads their contents for a template package directory
 * while preserving executable bits. Uses `git ls-files --cached --others --exclude-standard`
 * for Git-managed package directories (making `.gitignore` the single source of truth),
 * and static directory traversal for bundled `templatesRoot` directories or non-Git fixtures.
 */
export function loadPackageSourceFiles(
  packageDir: string,
  options: {
    readonly includeResources: boolean;
    readonly templatesRoot?: string;
  },
): readonly ScannedPackageFile[] {
  if (isGitManagedPackageDir(packageDir, options.templatesRoot)) {
    return loadGitListedPackageFiles(packageDir, options.includeResources);
  }

  const results: ScannedPackageFile[] = [];
  collectStaticDirectoryEntries(
    packageDir,
    "",
    options.includeResources,
    results,
  );
  return results;
}

/**
 * Reads a package-relative source file inside `packageDir` and returns its bytes and mode.
 * Rejects path traversal or invalid package-relative paths.
 */
export function readPackageSourceFile(
  packageDir: string,
  relativePath: string,
): ReadPackageSourceFileResult {
  const normalized = normalizeRelativePackagePath(relativePath);
  if (normalized === undefined) {
    throw new Error(`Invalid package-relative source path "${relativePath}".`);
  }
  const absPath = path.join(packageDir, normalized);
  const content = readFileSync(absPath);
  const mode = statSync(absPath).mode & 0o777;
  return {
    relativePath: normalized,
    content,
    executable: (mode & 0o111) !== 0,
    mode,
  };
}

/** Reads a checked source text file as UTF-8. */
export function readSourceTextFile(filePath: string): string {
  return readFileSync(filePath, "utf8");
}

/** Reads a checked source text file as UTF-8, returning `undefined` if absent or unreadable. */
export function tryReadSourceTextFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
