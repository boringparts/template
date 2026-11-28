import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  validateWorkspacePolicy,
  type WorkspacePolicy,
} from "./workspace-policy.ts";

const decoder = new TextDecoder();

/** Clean template file read from a `SourceContext`. */
export type SourceFile = {
  /** Normalized POSIX path relative to the scanned package root. */
  readonly relativePath: string;
  /** Raw file contents read during source enumeration. */
  readonly content: Uint8Array;
  /** Whether any executable bit (`0o111`) is set on the source file. */
  readonly executable: boolean;
  /** Raw permission mode bits (`stats.mode & 0o777`). */
  readonly mode: number;
};

/**
 * Read-only template loader bound explicitly to a workspace base directory
 * or a packaged template snapshot directory.
 */
export type SourceContext = {
  readonly kind: "workspace" | "packaged";
  readonly rootDir: string;
  listPackageFiles(
    sourceDir: string,
    options?: { readonly includeResources?: boolean },
  ): readonly SourceFile[];
  readPackageFile(sourceDir: string, relativePath: string): SourceFile;
  readPackageText(sourceDir: string, relativePath: string): string;
  tryReadPackageText(
    sourceDir: string,
    relativePath: string,
  ): string | undefined;
};

/**
 * Packaged read-only source context exposing static template files alongside
 * the serialized `workspace-policy.json` snapshot.
 */
export type PackagedSourceContext = SourceContext & {
  readonly kind: "packaged";
  readWorkspacePolicy(): WorkspacePolicy;
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

function resolveValidatedPackageDir(
  rootDir: string,
  sourceDir: string,
): string {
  const normalized = normalizeRelativePackagePath(sourceDir);
  if (normalized === undefined) {
    throw new Error(`Invalid package source directory "${sourceDir}".`);
  }
  return path.join(rootDir, normalized);
}

function isGitManagedPackageDir(absPkgDir: string, rootDir: string): boolean {
  let resolvedTopLevel: string;
  let resolvedPkgDir: string;
  let resolvedBaseDir: string;
  try {
    const rawTopLevel = execFileSync(
      "git",
      ["-C", absPkgDir, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
    if (rawTopLevel.length === 0) {
      return false;
    }
    resolvedTopLevel = realpathSync(rawTopLevel);
    resolvedPkgDir = realpathSync(absPkgDir);
    resolvedBaseDir = realpathSync(rootDir);
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
    segments.includes("node_modules") ||
    segments.some((segment) => segment.startsWith("."))
  ) {
    return false;
  }

  // When the Git worktree root lives at or inside `baseDir`, respect its `.gitignore` directly.
  const relTopToBase = path.relative(resolvedBaseDir, resolvedTopLevel);
  if (!relTopToBase.startsWith("..") && !path.isAbsolute(relTopToBase)) {
    return true;
  }

  // Otherwise only treat external subdirectories as Git-managed if they already have tracked files.
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

function loadGitListedPackageFiles(
  packageDir: string,
  includeResources: boolean,
): readonly SourceFile[] {
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

  const results: SourceFile[] = [];
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
  results: SourceFile[],
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
      content: readFileSync(absPath),
      executable: (mode & 0o111) !== 0,
      mode,
    });
  }
}

function createBaseSourceContext(
  kind: "workspace" | "packaged",
  rootDir: string,
): SourceContext {
  const resolvedRootDir = path.resolve(rootDir);

  const readPackageFile = (
    sourceDir: string,
    relativePath: string,
  ): SourceFile => {
    const absPkgDir = resolveValidatedPackageDir(resolvedRootDir, sourceDir);
    const normalizedRel = normalizeRelativePackagePath(relativePath);
    if (normalizedRel === undefined) {
      throw new Error(
        `Invalid package-relative source path "${relativePath}".`,
      );
    }
    const absPath = path.join(absPkgDir, normalizedRel);
    const content = readFileSync(absPath);
    const mode = statSync(absPath).mode & 0o777;
    return {
      relativePath: normalizedRel,
      content,
      executable: (mode & 0o111) !== 0,
      mode,
    };
  };

  const readPackageText = (sourceDir: string, relativePath: string): string =>
    decoder.decode(readPackageFile(sourceDir, relativePath).content);

  const tryReadPackageText = (
    sourceDir: string,
    relativePath: string,
  ): string | undefined => {
    if (
      normalizeRelativePackagePath(sourceDir) === undefined ||
      normalizeRelativePackagePath(relativePath) === undefined
    ) {
      return undefined;
    }
    try {
      return readPackageText(sourceDir, relativePath);
    } catch {
      return undefined;
    }
  };

  const listPackageFiles = (
    sourceDir: string,
    options?: { readonly includeResources?: boolean },
  ): readonly SourceFile[] => {
    const absPkgDir = resolveValidatedPackageDir(resolvedRootDir, sourceDir);
    const includeResources = options?.includeResources ?? false;
    if (
      kind === "workspace" &&
      isGitManagedPackageDir(absPkgDir, resolvedRootDir)
    ) {
      return loadGitListedPackageFiles(absPkgDir, includeResources);
    }

    const results: SourceFile[] = [];
    collectStaticDirectoryEntries(absPkgDir, "", includeResources, results);
    return results;
  };

  return {
    kind,
    rootDir: resolvedRootDir,
    listPackageFiles,
    readPackageFile,
    readPackageText,
    tryReadPackageText,
  };
}

/**
 * Creates a workspace `SourceContext` anchored at `baseDir`.
 * Uses `git ls-files --cached --others --exclude-standard` inside Git-managed directories
 * and falls back to deterministic static traversal otherwise.
 */
export function createWorkspaceSourceContext(baseDir: string): SourceContext {
  return createBaseSourceContext("workspace", baseDir);
}

/**
 * Creates a packaged `PackagedSourceContext` anchored at a static template snapshot directory.
 * Never invokes `git` and exposes `readWorkspacePolicy()` for `workspace-policy.json`.
 */
export function createPackagedSourceContext(
  templatesDir: string,
): PackagedSourceContext {
  const base = createBaseSourceContext("packaged", templatesDir);
  return {
    ...base,
    kind: "packaged",
    readWorkspacePolicy(): WorkspacePolicy {
      const policyPath = path.join(base.rootDir, "workspace-policy.json");
      const parsed = JSON.parse(readFileSync(policyPath, "utf8")) as unknown;
      return validateWorkspacePolicy(parsed, policyPath);
    },
  };
}
