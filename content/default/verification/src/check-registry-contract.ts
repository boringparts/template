#!/usr/bin/env node
import {
  deriveFixtureMatrix,
  forEachGeneratedScenario,
} from "./generated-content.ts";
import { validateGeneratedScenarioReceipt } from "./registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "./source-generated-runtime.ts";

/** Validates init and add projections and native workspace constraints for the default content collection. */
export async function checkPresetRegistryContract(): Promise<void> {
  await forEachGeneratedScenario({
    runtime: sourceGeneratedScenarioRuntime,
    scenarios: deriveFixtureMatrix(sourceGeneratedScenarioRuntime),
    inspect: async (receipt) => {
      await validateGeneratedScenarioReceipt({
        receipt,
        runtime: sourceGeneratedScenarioRuntime,
      });
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await checkPresetRegistryContract();
}
