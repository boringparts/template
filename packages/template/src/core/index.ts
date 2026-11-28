import type { PresetDefinition, PresetSummary } from "./types.ts";

export { writeProjectProjection } from "./materialize.ts";
export { buildProjectProjection } from "./synthesize.ts";
export { formatJson } from "./transform.ts";
export {
  invalidRequestIssueCodes,
  ProjectValidationError,
  type BasePackageNode,
  type GeneratedInstance,
  type InvalidRequestIssue,
  type InvalidRequestIssueCode,
  type MaterializeResult,
  type PackageDefinition,
  type PackageFileContribution,
  type PackageManifestSummary,
  type PackageRole,
  type PackageTransformContext,
  type PlanProjectRequest,
  type PlanProjectResult,
  type PresetDefinition,
  type PresetNode,
  type PresetSummary,
  type PresetTopology,
  type ProjectBlueprint,
  type ProjectLink,
  type ProjectProjection,
  type ProjectProjectionEntry,
  type ResourceFileMapping,
  type WorkspaceCollection,
  type WorkspaceTemplateRoots,
} from "./types.ts";
export {
  canLinkRoles,
  isValidPackageLeafName,
  isValidPackageScope,
  planProject,
  validatePackagePath,
} from "./validation.ts";

/** Returns CLI-ready metadata summaries for a list of preset definitions. */
export function summarizePresets<TMeta>(
  presets: readonly PresetDefinition<TMeta>[],
): readonly PresetSummary[] {
  return presets.map((preset) => ({
    name: preset.alias,
    title: preset.title,
    description: preset.description,
    topology: preset.topology,
    roles: preset.nodes.map((node) => node.definition.role),
  }));
}
