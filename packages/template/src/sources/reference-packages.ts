import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type RegisteredReferencePackage = {
  readonly slug: string;
  readonly packageName: string;
  readonly packageDir: string;
};

/**
 * Resolves a workspace package directory either from an explicit bundled `templatesRoot`
 * or via Node module resolution against the caller's `import.meta.url` in source mode.
 */
export function resolveReferencePackageDir(
  packageName: string,
  callerMetaUrl: string,
  templatesRoot?: string,
): string {
  if (
    templatesRoot !== undefined &&
    packageName.startsWith("@boringparts/reference-")
  ) {
    const slug = packageName.slice("@boringparts/reference-".length);
    const candidate = path.join(templatesRoot, "references", slug);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const require = createRequire(callerMetaUrl);
  return path.dirname(require.resolve(`${packageName}/reference`));
}
