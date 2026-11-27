import type { PresetDefinition, PresetSummary } from "./types.ts";

export { writeProjectProjection } from "./materialize.ts";
export { buildProjectProjection } from "./synthesize.ts";
export type {
  DevcontainerLayer,
  EditorCapability,
  GeneratedInstance,
  InvalidRequestIssue,
  InvalidRequestIssueCode,
  MaterializeResult,
  PackageRole,
  PlanProjectRequest,
  PlanProjectResult,
  PresetDefinition,
  PresetNode,
  PresetSummary,
  PresetTopology,
  PresetWorkspaceCapabilities,
  ProjectBlueprint,
  ProjectLink,
  ProjectProjection,
  ProjectProjectionEntry,
  ReferenceFileHandle,
  ReferencePackage,
  RootStaticFileHandle,
  WorkspaceCollection,
  WorkspaceTemplateRoots,
} from "./types.ts";
export {
  canLinkRoles,
  isValidPackageLeafName,
  isValidPackageScope,
  planProject,
  validatePackagePath,
} from "./validation.ts";

/** Returns CLI-ready metadata summaries for a list of preset definitions. */
export function summarizePresets(
  presets: readonly PresetDefinition[],
): readonly PresetSummary[] {
  return presets.map((preset) => ({
    name: preset.alias,
    title: preset.title,
    description: preset.description,
    topology: preset.topology,
    roles: preset.nodes.map((node) => node.reference.role),
  }));
}
