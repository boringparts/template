import type { PackageDefinition } from "@ykdz/template-core/project-blueprint";

/** Explicit package link requested via stable node identity; linkability is enforced by workspace policy. */
export type PackageLinkRequirement = {
  readonly kind: "package-link";
  readonly consumer: PackageDefinition;
  readonly provider: PackageDefinition;
};

/** Default-policy reason for a package link planning failure that can be mapped to a user input error. */
export type PackageLinkValidationIssue =
  | { readonly kind: "unknown-consumer"; readonly path: string }
  | {
      readonly kind: "unsupported-link";
      readonly consumerPath: string;
      readonly providerPath: string;
    };

export class PackageLinkValidationError extends Error {
  readonly issue: PackageLinkValidationIssue;

  constructor(issue: PackageLinkValidationIssue, message: string) {
    super(message);
    this.name = "PackageLinkValidationError";
    this.issue = issue;
  }
}

/** Persisted root manifest toolchain declaration issue detected before adding a package. */
export type RootToolchainDeclarationIssue =
  | { readonly kind: "invalid-node-declaration" }
  | { readonly kind: "invalid-package-manager-pin" };

export class RootToolchainDeclarationError extends Error {
  readonly issue: RootToolchainDeclarationIssue;

  constructor(issue: RootToolchainDeclarationIssue, message: string) {
    super(message);
    this.name = "RootToolchainDeclarationError";
    this.issue = issue;
  }
}

export type ProjectRequirement = PackageLinkRequirement;
