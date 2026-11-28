import type { PresetDefinition } from "../core/index.ts";
import { createNodeLibPreset } from "./presets/node-lib.ts";
import { createRustBinPreset } from "./presets/rust-bin.ts";
import { createTsCliPreset } from "./presets/ts-cli.ts";
import { createTsLibPreset } from "./presets/ts-lib.ts";
import { createVikeAppPreset } from "./presets/vike-app.ts";
import { createVueAppPreset } from "./presets/vue-app.ts";
import { createVueHonoAppPreset } from "./presets/vue-hono-app.ts";

/** Loads all built-in presets in deterministic display order. */
export function loadBuiltInPresets(
  templatesRoot?: string,
): readonly PresetDefinition[] {
  return [
    createTsLibPreset(templatesRoot),
    createNodeLibPreset(templatesRoot),
    createTsCliPreset(templatesRoot),
    createRustBinPreset(templatesRoot),
    createVueAppPreset(templatesRoot),
    createVueHonoAppPreset(templatesRoot),
    createVikeAppPreset(templatesRoot),
  ];
}
