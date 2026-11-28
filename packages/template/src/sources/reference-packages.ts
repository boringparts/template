import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type RegisteredReferencePackage = {
  readonly slug: string;
  readonly packageName: string;
  readonly packageDir: string;
};

const registeredReferenceSpecs = [
  { slug: "hono-api", packageName: "@boringparts/reference-hono-api" },
  { slug: "node-lib", packageName: "@boringparts/reference-node-lib" },
  { slug: "rust-bin", packageName: "@boringparts/reference-rust-bin" },
  {
    slug: "tooling-config",
    packageName: "@boringparts/reference-tooling-config",
  },
  { slug: "ts-cli", packageName: "@boringparts/reference-ts-cli" },
  { slug: "ts-lib", packageName: "@boringparts/reference-ts-lib" },
  { slug: "vike-db", packageName: "@boringparts/reference-vike-db" },
  {
    slug: "vike-deployment",
    packageName: "@boringparts/reference-vike-deployment",
  },
  {
    slug: "vike-migrations",
    packageName: "@boringparts/reference-vike-migrations",
  },
  { slug: "vike-web", packageName: "@boringparts/reference-vike-web" },
  { slug: "vue-app", packageName: "@boringparts/reference-vue-app" },
  { slug: "vue-hono-e2e", packageName: "@boringparts/reference-vue-hono-e2e" },
  { slug: "vue-hono-web", packageName: "@boringparts/reference-vue-hono-web" },
  {
    slug: "workspace-root",
    packageName: "@boringparts/reference-workspace-root",
  },
] as const;

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

/**
 * Resolves all declared reference package directories for template distribution packaging.
 */
export function resolveRegisteredReferencePackages(
  templatesRoot?: string,
): readonly RegisteredReferencePackage[] {
  return registeredReferenceSpecs.map((spec) => ({
    slug: spec.slug,
    packageName: spec.packageName,
    packageDir: resolveReferencePackageDir(
      spec.packageName,
      import.meta.url,
      templatesRoot,
    ),
  }));
}
