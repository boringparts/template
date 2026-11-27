import type { PresetDefinition } from "@boringparts/template-engine";

import { createTsLibPreset } from "./presets/ts-lib.ts";

export { resolvePackageDir, resolveTemplateWorkspaceRoots } from "./roots.ts";

/** Loads all built-in presets in deterministic display order. */
export function loadBuiltInPresets(
  templatesRoot?: string,
): readonly PresetDefinition[] {
  return [createTsLibPreset(templatesRoot)];
}
