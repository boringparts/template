import { templateContent } from "@boringparts/template-content";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

import type { GeneratedScenarioRuntime } from "./generated-content.ts";

/** Source author gates run against the canonical content collection and default SDK. */
export const sourceGeneratedScenarioRuntime: GeneratedScenarioRuntime = {
  content: templateContent,
  createDefaultGenerator,
};
