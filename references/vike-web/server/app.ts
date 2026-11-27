import vike from "@vikejs/hono";
import { Hono } from "hono";
import { Telefunc } from "telefunc/node";

import { api } from "#/server/api";
import { assertDatabaseReady, createDatabase } from "#/server/database";

const telefunc = new Telefunc();

export function createApp() {
  try {
    assertDatabaseReady(createDatabase());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  const app = new Hono();

  // @vikejs/hono registers Vike's non-handler middleware up front and mounts page rendering via
  // app.notFound(), so vike(app) must be called before registering application routes.
  vike(app);

  app.route("/api", api);

  app.all("/_telefunc", async (c) => {
    const response = await telefunc.serve({
      request: c.req.raw,
      context: {
        db: createDatabase(),
      },
    });

    return response ?? c.notFound();
  });

  return app;
}
