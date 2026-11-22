import {
  assertContentIdentity,
  type ContentIdentity,
  type LoadedContentMember,
} from "@ykdz/template-core/content-identity";
import type { ReferenceDependency } from "@ykdz/template-core/reference-package";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicReferenceSpecifierAddress(specifier: string): {
  readonly packageName: string;
  readonly exportPath: string;
} {
  if (
    specifier.trim() !== specifier ||
    specifier.length === 0 ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.includes("\\")
  ) {
    throw new Error(
      `Native dependency must use a canonical public package specifier: ${specifier}`,
    );
  }
  const parts = specifier.split("/");
  const packageLength = specifier.startsWith("@") ? 2 : 1;
  if (
    parts.length < packageLength ||
    parts.slice(0, packageLength).some((part) => part.length === 0) ||
    parts.slice(packageLength).some((part) => part.length === 0)
  ) {
    throw new Error(
      `Invalid public package specifier for native dependency: ${specifier}`,
    );
  }
  const packageName = parts.slice(0, packageLength).join("/");
  const exportSegments = parts.slice(packageLength);
  return {
    packageName,
    exportPath:
      exportSegments.length === 0 ? "." : `./${exportSegments.join("/")}`,
  };
}

function canonicalModuleURL(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${label} is not an absolute module URL: ${value}`, {
      cause: error,
    });
  }
  if (url.protocol !== "file:") {
    throw new Error(`${label} must be a file URL: ${value}`);
  }
  return url.href;
}

/** Normalizes a reference dependency to its canonical `ContentIdentity` using the consumer's namespace, public package specifier, and resolved module URL. Throws if an `ownerLocal` dependency does not resolve to the current revision within the same namespace. */
export function resolveReferenceDependencyIdentity(options: {
  readonly consumerIdentity: ContentIdentity;
  readonly dependency: ReferenceDependency;
  readonly members: readonly LoadedContentMember[];
}): ContentIdentity {
  if ("contentIdentity" in options.dependency) {
    assertContentIdentity(options.dependency.contentIdentity);
    return options.dependency.contentIdentity;
  }

  const { ownerLocal } = options.dependency;
  const address = publicReferenceSpecifierAddress(ownerLocal.specifier);
  let resolved: string;
  try {
    resolved = ownerLocal.resolve(ownerLocal.specifier);
  } catch (error) {
    throw new Error(
      `Failed to resolve native dependency public entry ${ownerLocal.specifier}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const resolvedURL = canonicalModuleURL(
    resolved,
    "Resolved native dependency",
  );
  const namespaceCandidates = options.members.filter(
    (member) =>
      member.kind === "reference" &&
      member.identity.namespace === options.consumerIdentity.namespace &&
      member.identity.packageName === address.packageName &&
      member.identity.exportPath === address.exportPath,
  );
  const resolvedCandidates = namespaceCandidates.filter(
    (member) =>
      canonicalModuleURL(
        member.source.moduleURL,
        "Content member public module entry",
      ) === resolvedURL,
  );
  if (resolvedCandidates.length > 1) {
    throw new Error(
      `Native dependency resolved to multiple content revisions with the same public identity: ${ownerLocal.specifier}`,
    );
  }
  if (resolvedCandidates.length === 1) {
    return resolvedCandidates[0]!.identity;
  }
  if (namespaceCandidates.length > 0) {
    throw new Error(
      `Native dependency ${ownerLocal.specifier} did not resolve to the current content revision's public module entry`,
    );
  }
  const sameNamespaceModuleCandidates = options.members.filter(
    (member) =>
      member.kind === "reference" &&
      member.identity.namespace === options.consumerIdentity.namespace &&
      canonicalModuleURL(
        member.source.moduleURL,
        "Content member public module entry",
      ) === resolvedURL,
  );
  if (sameNamespaceModuleCandidates.length > 0) {
    throw new Error(
      `Native dependency public address does not match the actual content entry: ${ownerLocal.specifier}`,
    );
  }
  throw new Error(
    `Native dependency ${ownerLocal.specifier} must be published in the same namespace as the consumer and resolve to the current revision`,
  );
}
