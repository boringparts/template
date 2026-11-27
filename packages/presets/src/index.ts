import type { PresetDefinition } from "@boringparts/template-engine";

import { createTsLibPreset } from "./presets/ts-lib.ts";
import { createVueAppPreset } from "./presets/vue-app.ts";
import { createVueHonoAppPreset } from "./presets/vue-hono-app.ts";

export { resolvePackageDir, resolveTemplateWorkspaceRoots } from "./roots.ts";

/** Loads all built-in presets in deterministic display order. */
export function loadBuiltInPresets(
  templatesRoot?: string,
): readonly PresetDefinition[] {
  return [
    createTsLibPreset(templatesRoot),
    createVueAppPreset(templatesRoot),
    createVueHonoAppPreset(templatesRoot),
  ];
}
