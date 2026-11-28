import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { MaterializeResult, ProjectProjection } from "./types.ts";

/**
 * Writes a `ProjectProjection` to disk if the target directory is absent or empty.
 * Leaves existing non-empty directories untouched and returns a structured operation failure.
 */
export function writeProjectProjection<TMeta>(
  projection: ProjectProjection<TMeta>,
): MaterializeResult {
  const { targetDir } = projection.blueprint;

  try {
    if (existsSync(targetDir)) {
      const stats = statSync(targetDir);
      if (!stats.isDirectory()) {
        return {
          ok: false,
          targetDir,
          error: {
            message: `Target path exists and is not a directory: ${targetDir}`,
            suggestion:
              "Choose a new directory path or an empty directory for initialization.",
          },
        };
      }
      if (readdirSync(targetDir).length > 0) {
        return {
          ok: false,
          targetDir,
          error: {
            message: `Target directory is not empty: ${targetDir}`,
            suggestion:
              "Initialize into a new or empty directory, or remove existing files first.",
          },
        };
      }
    }

    mkdirSync(targetDir, { recursive: true });
    for (const entry of projection.entries) {
      const outputPath = path.join(targetDir, entry.path);
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, entry.content);
      if (entry.executable && process.platform !== "win32") {
        chmodSync(outputPath, 0o755);
      }
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      targetDir,
      error: {
        message: `Failed to write initialized repository: ${error instanceof Error ? error.message : String(error)}`,
        suggestion:
          "Check filesystem permissions and target directory path, then try again.",
      },
    };
  }
}
