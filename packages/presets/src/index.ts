import type { PresetDefinition } from "@boringparts/template-engine";

import { createNodeLibPreset } from "./presets/node-lib.ts";
import { createRustBinPreset } from "./presets/rust-bin.ts";
import { createTsCliPreset } from "./presets/ts-cli.ts";
import { createTsLibPreset } from "./presets/ts-lib.ts";

export { resolvePackageDir, resolveTemplateWorkspaceRoots } from "./roots.ts";

/** Loads all built-in presets in deterministic display order. */
export function loadBuiltInPresets(
  templatesRoot?: string,
): readonly PresetDefinition[] {
  return [
    createTsLibPreset(templatesRoot),
    createNodeLibPreset(templatesRoot),
    createTsCliPreset(templatesRoot),
    createRustBinPreset(templatesRoot),
  ];
}
