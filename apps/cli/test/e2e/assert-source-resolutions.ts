import path from "node:path";
import { fileURLToPath } from "node:url";

const publicSourceResolutions = [
  ["@boringparts/template", "/apps/cli/src/main.ts"],
  ["@boringparts/template-content", "/content/default/collection/src/index.ts"],
  ["@boringparts/template-core/project-blueprint", "/src/project-blueprint.ts"],
  ["@boringparts/template-core/generation-record", "/src/generation-record.ts"],
] as const;

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

for (const [specifier, expectedSuffix] of publicSourceResolutions) {
  const resolved = portablePath(fileURLToPath(import.meta.resolve(specifier)));
  if (resolved.includes("/dist/") || !resolved.endsWith(expectedSuffix)) {
    throw new Error(
      `${specifier} resolved to ${resolved}; expected ${expectedSuffix}`,
    );
  }
}
