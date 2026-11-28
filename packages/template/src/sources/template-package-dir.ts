import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walks up from this module's directory (up to 4 levels) to locate the
 * `@boringparts/template` package root containing `package.json`.
 */
export function resolveTemplatePackageDir(): string | undefined {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth++) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}
