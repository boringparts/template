// Derived by root sync:workspace-policy from native toolchain declarations; edit the source of truth and run sync explicitly.
export const releaseToolchainSnapshot = Object.freeze({
  nodeVersion: "26.13.1",
  packageManagerPin: "pnpm@12.21.0",
  rustVersion: "1.100.0",
} as const);

export type ReleaseToolchainSnapshot = typeof releaseToolchainSnapshot;
