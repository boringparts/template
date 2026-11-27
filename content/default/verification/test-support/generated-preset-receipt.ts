import type { assertWorkflowContract } from "@boringparts/default-content-verification/workflow-contract";
import { templateContent } from "@boringparts/template-content";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

export type GeneratedPresetReceipt = Parameters<
  typeof assertWorkflowContract
>[0];
export type GeneratedPreset = Extract<
  (typeof templateContent)[number],
  { readonly kind: "preset" }
>;
/** Initializes a preset and wraps the returned result as a receipt for validating the projection. */
export async function initializePreset(options: {
  readonly preset: GeneratedPreset;
  readonly targetRoot: string;
  readonly repositoryName: string;
  readonly defaultPackageScope?: string;
}): Promise<GeneratedPresetReceipt> {
  const generator = createDefaultGenerator({ content: templateContent });
  const result = await generator.init({
    targetRoot: options.targetRoot,
    selection: {
      presets: [{ contentIdentity: options.preset.identity }],
    },
    conventions: {
      repositoryName: options.repositoryName,
      defaultPackageScope: options.defaultPackageScope ?? "demo",
    },
  });
  if (result.status !== "success") {
    throw new Error(
      `${options.preset.definition.metadata.alias}: public generator did not return a successful receipt: ${JSON.stringify(result)}`,
    );
  }
  const receiptResult: GeneratedPresetReceipt["result"] = result;
  return {
    status: "generated",
    scenario: {
      id: options.preset.definition.metadata.alias,
      label: `initialize ${options.preset.definition.metadata.alias}`,
      base: options.preset,
    },
    projectDir: options.targetRoot,
    initialization: receiptResult,
    result: receiptResult,
    linkFrom: [],
  };
}
