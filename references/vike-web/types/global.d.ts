import type { Database } from "@boringparts/reference-vike-db";

declare global {
  namespace Telefunc {
    interface Context {
      db: Database;
    }
  }
}
