import type { CiDiagnosticArtifactDeclaration } from "@boringparts/default-content-authoring/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

const reservedWorkspaceCollections = new Set([
  ".git",
  ".github",
  ".devcontainer",
  ".template",
  "node_modules",
  "dist",
  "target",
]);

function isSafePackagePath(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u.test(value) &&
    !reservedWorkspaceCollections.has(value.split("/", 1)[0]!)
  );
}

/**
 * Validates a closed CI diagnostic artifact declaration. Declarations cannot supply arbitrary
 * paths; native artifact paths are derived only after owner resolution.
 */
export function assertCiDiagnosticArtifactDeclaration(
  value: unknown,
): CiDiagnosticArtifactDeclaration {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "owner"])) {
    throw new Error(
      "CI diagnostic artifact declaration must contain only kind and owner",
    );
  }
  if (value.kind !== "playwright" && value.kind !== "vitest-browser") {
    throw new Error("Unsupported CI diagnostic artifact kind");
  }
  if (!isRecord(value.owner) || !hasExactKeys(value.owner, ["kind", "path"])) {
    throw new Error(
      "CI diagnostic artifact owner must be an object with kind and path",
    );
  }
  if (
    (value.owner.kind !== "workspace-orchestration" ||
      value.owner.path !== ".") &&
    (value.owner.kind !== "package-boundary" ||
      typeof value.owner.path !== "string" ||
      !isSafePackagePath(value.owner.path))
  ) {
    throw new Error(
      "Unsafe package boundary path for CI diagnostic artifact owner",
    );
  }
  return {
    kind: value.kind,
    owner:
      value.owner.kind === "workspace-orchestration"
        ? { kind: "workspace-orchestration", path: "." }
        : { kind: "package-boundary", path: value.owner.path },
  };
}

/**
 * Composes closed native CI diagnostic artifacts independently of presets and environment
 * preparation, deduplicating and sorting stably by owner then kind.
 */
export function composeCiDiagnosticArtifacts(options: {
  readonly packagePaths: readonly string[];
  readonly declarations: readonly unknown[];
}): readonly CiDiagnosticArtifactDeclaration[] {
  for (const packagePath of options.packagePaths) {
    if (!isSafePackagePath(packagePath)) {
      throw new Error(
        `Unsafe package boundary path for CI diagnostic artifact: ${packagePath}`,
      );
    }
  }
  const owners = new Set(options.packagePaths);
  const artifacts = new Map<string, CiDiagnosticArtifactDeclaration>();
  for (const value of options.declarations) {
    const declaration = assertCiDiagnosticArtifactDeclaration(value);
    if (
      declaration.owner.kind === "package-boundary" &&
      !owners.has(declaration.owner.path)
    ) {
      throw new Error(
        `CI diagnostic artifact owner is not a declared package boundary: ${declaration.owner.path}`,
      );
    }
    const key = `${declaration.kind}:${declaration.owner.path}`;
    artifacts.set(key, declaration);
  }
  return [...artifacts.values()].toSorted((left, right) => {
    const ownerOrder = left.owner.path.localeCompare(right.owner.path);
    return ownerOrder === 0 ? left.kind.localeCompare(right.kind) : ownerOrder;
  });
}
