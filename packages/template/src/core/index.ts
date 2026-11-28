import { writeProjectProjection } from "./materialize.ts";
import { writeTemplateSnapshot, type TemplateSnapshot } from "./snapshot.ts";
import { buildProjectProjection } from "./synthesize.ts";
import type {
  MaterializeResult,
  PlanProjectRequest,
  PlanProjectResult,
  PresetDefinition,
  PresetSummary,
  ProjectBlueprint,
  ProjectProjection,
  TemplateCatalog,
} from "./types.ts";
import { planProject } from "./validation.ts";

export {
  mergeWorkspaceEnvironment,
  type DependabotIgnoreRule,
  type DependabotNpmGroup,
  type DependabotUpdateRule,
  type DevcontainerLayerHandle,
  type DevcontainerMount,
  type MergedDevcontainerLayer,
  type MergedWorkspaceEnvironment,
  type WorkspaceEnvironment,
  type WorkspaceEnvironmentContext,
  type WorkspaceEnvironmentContributor,
} from "./environment.ts";
export { writeProjectProjection } from "./materialize.ts";
export { writeTemplateSnapshot, type TemplateSnapshot } from "./snapshot.ts";
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
  type TemplateCatalog,
  type WorkspaceRoot,
} from "./types.ts";
export {
  canLinkRoles,
  isValidPackageLeafName,
  isValidPackageScope,
  planProject,
  validatePackagePath,
} from "./validation.ts";

/** Type-preserving helper to declare a `PresetDefinition`. */
export function definePreset(preset: PresetDefinition): PresetDefinition {
  return preset;
}

/** Returns metadata summaries for a list of preset definitions, deduplicating roles in appearance order. */
export function summarizePresets(
  presets: readonly PresetDefinition[],
): readonly PresetSummary[] {
  return presets.map((preset) => ({
    name: preset.alias,
    title: preset.title,
    description: preset.description,
    topology: preset.topology,
    roles: [...new Set(preset.nodes.map((node) => node.referencePackage.role))],
  }));
}

/** Bound operations returned by `bindTemplateCatalog`. */
export type BoundTemplateCatalog = {
  readonly catalog: TemplateCatalog;
  summarizePresets(): readonly PresetSummary[];
  planProject(
    request: Omit<
      PlanProjectRequest,
      | "source"
      | "workspaceRoot"
      | "singletonPackages"
      | "presets"
      | "workspacePolicy"
    >,
  ): PlanProjectResult;
  buildProjectProjection(blueprint: ProjectBlueprint): ProjectProjection;
  writeProjectProjection(projection: ProjectProjection): MaterializeResult;
  writeTemplateSnapshot(targetDir: string): TemplateSnapshot;
};

/**
 * Convenience wrapper that binds a `TemplateCatalog` to the core summary,
 * planning, synthesis, materialization, and snapshot primitives.
 */
export function bindTemplateCatalog(
  catalog: TemplateCatalog,
): BoundTemplateCatalog {
  return {
    catalog,
    summarizePresets: () => summarizePresets(catalog.presets),
    planProject: (request) =>
      planProject({
        ...request,
        source: catalog.source,
        workspaceRoot: catalog.workspaceRoot,
        ...(catalog.singletonPackages === undefined
          ? {}
          : { singletonPackages: catalog.singletonPackages }),
        presets: catalog.presets,
        workspacePolicy: catalog.workspacePolicy,
      }),
    buildProjectProjection: (blueprint) =>
      buildProjectProjection(blueprint, {
        source: catalog.source,
        workspacePolicy: catalog.workspacePolicy,
      }),
    writeProjectProjection: (projection) => writeProjectProjection(projection),
    writeTemplateSnapshot: (targetDir) =>
      writeTemplateSnapshot(targetDir, catalog),
  };
}
