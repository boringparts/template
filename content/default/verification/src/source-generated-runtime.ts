import { templateContent } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

import type { GeneratedScenarioRuntime } from "./generated-content.ts";

/** Source author gates run against the canonical content collection and default SDK. */
export const sourceGeneratedScenarioRuntime: GeneratedScenarioRuntime = {
  content: templateContent,
  createDefaultGenerator,
};
