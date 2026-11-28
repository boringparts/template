import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createDatabase } from "#db/db";
import { createTodo, listTodos } from "#db/queries/todos";
import { assertDatabaseReady } from "#db/readiness";
import { databaseStorageTarget, resetDatabaseStorageTarget } from "#db/storage";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

void describe("todo queries", () => {
  void it("resolves and resets local SQLite storage files under .local/", () => {
    const previousProfile = process.env.DATABASE_PROFILE;
    const previousFile = process.env.DATABASE_FILE;
    try {
      delete process.env.DATABASE_FILE;
      for (const profile of ["dev", "test", "e2e"] as const) {
        process.env.DATABASE_PROFILE = profile;
        assert.equal(
          databaseStorageTarget(),
          path.join(packageRoot, ".local", `${profile}.sqlite`),
        );
      }

      process.env.DATABASE_PROFILE = "test";
      const testTarget = databaseStorageTarget();
      const sidecarPaths = [
        testTarget,
        `${testTarget}-journal`,
        `${testTarget}-wal`,
        `${testTarget}-shm`,
      ] as const;
      const backups = new Map<string, Buffer>();
      for (const filePath of sidecarPaths) {
        if (existsSync(filePath)) {
          backups.set(filePath, readFileSync(filePath));
        }
      }
      try {
        mkdirSync(path.dirname(testTarget), { recursive: true });
        writeFileSync(testTarget, "placeholder");
        writeFileSync(`${testTarget}-wal`, "placeholder");
        resetDatabaseStorageTarget();
        assert.equal(existsSync(testTarget), false);
        assert.equal(existsSync(`${testTarget}-wal`), false);
      } finally {
        for (const [filePath, content] of backups) {
          writeFileSync(filePath, content);
        }
      }
    } finally {
      if (previousProfile === undefined) {
        delete process.env.DATABASE_PROFILE;
      } else {
        process.env.DATABASE_PROFILE = previousProfile;
      }
      if (previousFile === undefined) {
        delete process.env.DATABASE_FILE;
      } else {
        process.env.DATABASE_FILE = previousFile;
      }
    }
  });

  void it("creates and lists todos through Drizzle SQLite", async () => {
    const db = createDatabase();
    assertDatabaseReady(db);
    const title = `Publish template ${Date.now()}`;

    assert.equal((await createTodo(db, { title })).title, title);
    assert.ok((await listTodos(db)).some((todo) => todo.title === title));
    assert.ok(
      (await db.query.todos.findMany()).some((todo) => todo.title === title),
    );
  });
});
