import type { PresetDefinition, PresetSummary } from "./types.ts";

export {
  mergeWorkspaceEnvironment,
  type DependabotIgnoreRule,
  type DependabotNpmGroup,
  type DependabotUpdateRule,
  type DevcontainerLayerHandle,
  type DevcontainerMount,
  type MergedWorkspaceEnvironment,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentContributor,
} from "./environment.ts";
export { writeProjectProjection } from "./materialize.ts";
export { buildProjectProjection } from "./synthesize.ts";
export { formatJson } from "./transform.ts";
export {
  invalidRequestIssueCodes,
  ProjectValidationError,
  type InvalidRequestIssue,
  type InvalidRequestIssueCode,
  type MaterializeResult,
  type PackageContribution,
  type PackageInstance,
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
  type ReferencePackage,
  type ResourceFileMapping,
  type SingletonPackage,
  type WorkspaceRoot,
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
export function summarizePresets(
  presets: readonly PresetDefinition[],
): readonly PresetSummary[] {
  return presets.map((preset) => ({
    name: preset.alias,
    title: preset.title,
    description: preset.description,
    topology: preset.topology,
    roles: preset.nodes.map((node) => node.referencePackage.role),
  }));
}
