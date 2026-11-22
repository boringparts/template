import { rmSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type DatabaseProfile = "dev" | "test" | "e2e";

function localProfile(): DatabaseProfile {
  const profile = process.env.DATABASE_PROFILE;
  if (process.env.DATABASE_FILE !== undefined) {
    throw new Error(
      "DATABASE_FILE cannot be set together with local DATABASE_PROFILE",
    );
  }
  if (profile === "dev" || profile === "test" || profile === "e2e") {
    return profile;
  }
  throw new Error("DATABASE_PROFILE must be dev, test, or e2e");
}

function localDatabaseStorageTarget(profile: DatabaseProfile): string {
  switch (profile) {
    case "dev":
      return fileURLToPath(new URL("../data/dev.sqlite", import.meta.url));
    case "test":
      return fileURLToPath(new URL("../data/test.sqlite", import.meta.url));
    case "e2e":
      return fileURLToPath(new URL("../data/e2e.sqlite", import.meta.url));
  }
}

/**
 * Resolves the active SQLite file path from either local `DATABASE_PROFILE` or deployment
 * `DATABASE_FILE`.
 *
 * Throws when both variables are set, when `DATABASE_PROFILE` is invalid, or when deployment
 * `DATABASE_FILE` is missing or relative.
 */
export function databaseStorageTarget(): string {
  if (process.env.DATABASE_PROFILE !== undefined) {
    return localDatabaseStorageTarget(localProfile());
  }
  const externalTarget = process.env.DATABASE_FILE;
  if (externalTarget !== undefined && isAbsolute(externalTarget)) {
    return externalTarget;
  }
  throw new Error("Deployment requires an absolute DATABASE_FILE path");
}

/** Removes the local SQLite database file and sidecar WAL/journal files for the active `DATABASE_PROFILE`. */
export function resetDatabaseStorageTarget(): void {
  switch (localProfile()) {
    case "dev":
      rmSync(fileURLToPath(new URL("../data/dev.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/dev.sqlite-shm", import.meta.url)),
        { force: true },
      );
      return;
    case "test":
      rmSync(fileURLToPath(new URL("../data/test.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/test.sqlite-shm", import.meta.url)),
        { force: true },
      );
      return;
    case "e2e":
      rmSync(fileURLToPath(new URL("../data/e2e.sqlite", import.meta.url)), {
        force: true,
      });
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-journal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-wal", import.meta.url)),
        { force: true },
      );
      rmSync(
        fileURLToPath(new URL("../data/e2e.sqlite-shm", import.meta.url)),
        { force: true },
      );
  }
}
