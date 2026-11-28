import type { PresetDefinition } from "@boringparts/template-engine";

import type { WorkspaceEnvironmentMeta } from "./environment-meta.ts";
import { createNodeLibPreset } from "./presets/node-lib.ts";
import { createRustBinPreset } from "./presets/rust-bin.ts";
import { createTsCliPreset } from "./presets/ts-cli.ts";
import { createTsLibPreset } from "./presets/ts-lib.ts";
import { createVikeAppPreset } from "./presets/vike-app.ts";
import { createVueAppPreset } from "./presets/vue-app.ts";
import { createVueHonoAppPreset } from "./presets/vue-hono-app.ts";

export { createBasePackages } from "./base-packages.ts";
export {
  browserTestDevcontainerMeta,
  frontendVscodeMeta,
  mergeWorkspaceEnvironmentMeta,
  type DependabotIgnoreRule,
  type DependabotNpmGroup,
  type DependabotUpdateRule,
  type DevcontainerLayerHandle,
  type DevcontainerMount,
  type MergedWorkspaceEnvironmentMeta,
  type StaticWorkspaceEnvironmentMeta,
  type WorkspaceEnvironmentMeta,
} from "./environment-meta.ts";
export {
  resolvePackageDir,
  resolvePlaywrightVersion,
  resolveRootBaseDir,
  resolveRustToolchainChannel,
  resolveTemplateDistributionSources,
  resolveTemplateWorkspaceRoots,
  type RegisteredReferencePackage,
  type TemplateDistributionSources,
} from "./roots.ts";
export {
  standardPresetVerificationScenarios,
  type PresetVerificationScenario,
} from "./scenarios.ts";

/** Loads all built-in presets in deterministic display order. */
export function loadBuiltInPresets(
  templatesRoot?: string,
): readonly PresetDefinition<WorkspaceEnvironmentMeta>[] {
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
