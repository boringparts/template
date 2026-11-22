import { sql } from "drizzle-orm";

import type { Database } from "#db/db";
import { todos } from "#db/schema";

/**
 * Verifies that the todos table is queryable before serving or seeding data.
 *
 * Throws a `DATABASE_NOT_READY` error with profile-specific preparation instructions when the
 * database has not been initialized.
 */
export function assertDatabaseReady(db: Database) {
  try {
    db.select({ ready: sql`1` })
      .from(todos)
      .limit(1)
      .all();
  } catch (cause) {
    const profile = process.env.DATABASE_PROFILE;
    const preparation =
      profile === "dev" || profile === "test" || profile === "e2e"
        ? `Run \`pnpm run database:prepare:${profile}\` from the repository root`
        : "Apply the accompanying migration artifact to the deployment database";
    throw new Error(
      `DATABASE_NOT_READY: Database is not ready. ${preparation}, then retry.`,
      { cause },
    );
  }
}
