import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

let cachedAuthorRepoTopLevel: string | null | undefined;

function resolveTemplatePackageDir(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveAuthorRepoTopLevel(): string | undefined {
  if (cachedAuthorRepoTopLevel !== undefined) {
    return cachedAuthorRepoTopLevel ?? undefined;
  }

  const templatePkgDir = resolveTemplatePackageDir();
  if (templatePkgDir.split(path.sep).includes("node_modules")) {
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

function isAuthorSourcePackageDir(
  packageDir: string,
  templatesRoot?: string,
): boolean {
  // Never invoke `git ls-files` in packaged `templatesRoot` mode or inside `node_modules` / temp dirs.
  if (templatesRoot !== undefined) {
    return false;
  }
  const topLevel = resolveAuthorRepoTopLevel();
  if (topLevel === undefined) {
    return false;
  }

  let resolvedPkgDir: string;
  try {
    resolvedPkgDir = realpathSync(packageDir);
  } catch {
    return false;
  }

  const relativeFromRepo = path.relative(topLevel, resolvedPkgDir);
  if (relativeFromRepo.startsWith("..") || path.isAbsolute(relativeFromRepo)) {
    return false;
  }

  const segments =
    relativeFromRepo === "" ? [] : relativeFromRepo.split(path.sep);
  if (
    segments.includes("templates") ||
    segments.includes("node_modules") ||
    segments.includes("dist")
  ) {
    return false;
  }

  return true;
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
      executable: (mode & 0o111) !== 0,
      mode,
    });
  }
}

/**
 * Lists clean source files for a template package directory while preserving executable bits.
 * Uses `git ls-files --cached --others --exclude-standard` inside the author Git worktree
 * (making `.gitignore` the single source of truth), and pure static directory traversal for
 * bundled `templatesRoot` directories or external synthetic test fixtures.
 */
export function loadPackageSourceFiles(
  packageDir: string,
  options: {
    readonly includeResources: boolean;
    readonly templatesRoot?: string;
  },
): readonly ScannedPackageFile[] {
  if (isAuthorSourcePackageDir(packageDir, options.templatesRoot)) {
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
