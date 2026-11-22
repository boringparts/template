export const defaultPackageRoles = [
  "cli-tool",
  "runtime-service",
  "shared-library",
  "native-package",
] as const;

/** Package role contract exposed to reference package authors by the default Node/Rust workspace policy. */
export type DefaultPackageRole = (typeof defaultPackageRoles)[number];

export function isDefaultPackageRole(
  value: string,
): value is DefaultPackageRole {
  return (defaultPackageRoles as readonly string[]).includes(value);
}
