import { projectTomlStringValues } from "@boringparts/template-core/toml";
import type { TomlTable } from "smol-toml";

export type CargoFileSnapshot = {
  readonly source: string;
  readonly data: TomlTable;
};

function cargoManifestName(manifest: CargoFileSnapshot): string {
  const packageMetadata = manifest.data.package;
  const name =
    typeof packageMetadata === "object" &&
    packageMetadata !== null &&
    !Array.isArray(packageMetadata)
      ? (packageMetadata as Record<string, unknown>).name
      : undefined;
  if (typeof name !== "string") {
    throw new Error(
      "Rust Cargo manifest is missing a string [package].name field",
    );
  }
  return name;
}

function cargoLockPackages(lock: CargoFileSnapshot): readonly unknown[] {
  const packages = lock.data.package;
  if (!Array.isArray(packages)) {
    throw new Error("Rust Cargo lockfile is missing [[package]] entries");
  }
  return packages;
}

/** Projects Cargo.toml and Cargo.lock to the target package leaf name while preserving unrelated TOML bytes. */
export function projectRustCargoFiles(options: {
  readonly cargoManifest: CargoFileSnapshot;
  readonly cargoLock: CargoFileSnapshot;
  readonly targetName: string;
}): { readonly manifestText: string; readonly lockText: string } {
  const nativeName = cargoManifestName(options.cargoManifest);
  const lockPackages = cargoLockPackages(options.cargoLock);
  return {
    manifestText: projectTomlStringValues(options.cargoManifest.source, [
      { path: ["package", "name"], value: options.targetName },
    ]),
    lockText: projectTomlStringValues(
      options.cargoLock.source,
      lockPackages.flatMap((packageValue, index) => {
        if (
          typeof packageValue !== "object" ||
          packageValue === null ||
          Array.isArray(packageValue)
        ) {
          return [];
        }
        const packageRecord = packageValue as Record<string, unknown>;
        return packageRecord.name === nativeName &&
          packageRecord.source === undefined
          ? [{ path: ["package", index, "name"], value: options.targetName }]
          : [];
      }),
    ),
  };
}

/** Replaces generator lint and test scripts with Cargo commands and drops TypeScript-only scripts. */
export function projectRustPackageScripts(
  scripts: Readonly<Record<string, string>>,
): Record<string, string> {
  const projected: Record<string, string> = {
    ...scripts,
    lint: "cargo clippy --workspace --all-targets -- -D warnings",
    test: "cargo test --workspace",
  };
  delete projected["lint:fix"];
  delete projected["typecheck"];
  return projected;
}

/** Removes TypeScript-only Turbo tasks and detaches dropped lint dependencies from Rust package tasks. */
export function projectRustTurboTasks(
  source: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const tasks = { ...source };
  delete tasks["lint:fix"];
  delete tasks.typecheck;
  const lintTask = tasks.lint as
    | { readonly dependsOn?: readonly string[] }
    | undefined;
  if (lintTask?.dependsOn !== undefined) {
    tasks.lint = {
      ...lintTask,
      dependsOn: lintTask.dependsOn.filter((task) => task !== "^lint"),
    };
  }
  const formatWrite = tasks["format:write"] as {
    readonly dependsOn: readonly string[];
  };
  tasks["format:write"] = {
    ...formatWrite,
    dependsOn: formatWrite.dependsOn.filter((task) => task !== "lint:fix"),
  };
  return tasks;
}
