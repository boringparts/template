import { templateContent, templatePresets } from "@ykdz/template-content";
import { createContentIndex } from "@ykdz/template-core/content-identity";

/**
 * Finds the alias of an add-capable preset in the public content collection
 * that owns the given reference package.
 */
export function requireReferencePresetName(
  referencePackageName: string,
): string {
  const contentIndex = createContentIndex(templateContent);
  const preset = templatePresets.find((candidate) => {
    if (!candidate.definition.operations.includes("add")) return false;
    return Object.values(candidate.definition.nodes).some(({ reference }) => {
      const owner = contentIndex.fromDefinition(reference, "reference", {
        namespace: candidate.identity.namespace,
      });
      return owner.identity.packageName === referencePackageName;
    });
  });
  if (preset === undefined) {
    throw new Error(
      `No add-capable preset owns the reference package: ${referencePackageName}`,
    );
  }
  return preset.alias;
}
