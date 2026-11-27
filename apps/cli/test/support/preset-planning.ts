import { tmpdir } from "node:os";
import path from "node:path";

import {
  templateContent,
  type TemplatePreset,
} from "@boringparts/template-content";
import type { PackageDefinition } from "@boringparts/template-core/project-blueprint";
import type { ProjectProjection } from "@boringparts/template-core/project-projection";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

const generator = createDefaultGenerator({ content: templateContent });

/**
 * Runs production init planning for a preset so tests inspect its resolved
 * packages and projection instead of assuming author default paths.
 */
export async function planPreset(member: TemplatePreset): Promise<{
  readonly packages: readonly PackageDefinition[];
  readonly projection: ProjectProjection;
}> {
  const result = await generator.planInit({
    targetRoot: path.join(
      tmpdir(),
      "template-cli-preset-planning",
      member.identity.packageName.replaceAll("/", "-"),
    ),
    selection: { presets: [{ contentIdentity: member.identity }] },
    conventions: {
      repositoryName: "fixture",
      defaultPackageScope: "acme",
    },
  });
  if (result.status !== "planned") {
    throw new Error(
      `Preset ${member.definition.metadata.alias} failed production planning: ${result.status}`,
    );
  }
  const selection = result.generationRecord.selections.find(
    ({ presetIdentity }) =>
      presetIdentity?.packageName === member.identity.packageName &&
      presetIdentity.exportPath === member.identity.exportPath &&
      presetIdentity.namespace === member.identity.namespace,
  );
  if (selection === undefined) {
    throw new Error(
      `Production planning did not record preset ${member.definition.metadata.alias}`,
    );
  }
  const selectedPackageIds = new Set(Object.values(selection.nodes));
  return {
    packages: result.blueprint.packages.filter(({ packageDefinitionId }) =>
      selectedPackageIds.has(packageDefinitionId),
    ),
    projection: result.projection,
  };
}
