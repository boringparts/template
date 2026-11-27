import { definePreset } from "@boringparts/template-core/preset-definition";
import { defineNativeContentArtifact } from "@boringparts/template-workspace-authoring/content-artifact";

import manifest from "../package.json" with { type: "json" };

const presetDefinition = {
  ...definePreset({
    metadata: {
      alias: "contract-preset",
      title: "Contract Verification Preset",
      description:
        "Neutral test preset for verifying the native content type contract.",
    },
    operations: ["init", "add"],
    nodes: {
      library: {
        reference: {
          alias: "contract-reference",
          instance: "independent",
        },
        creationInput: {
          init: { projectName: "contract-starter" },
          add: { projectName: "contract-added" },
        },
      },
    },
  }),
  authorExtension: {
    channel: "preset-extension-v2" as const,
    describe() {
      return { flavor: "neutral-project-v2" as const, rank: 2 as const };
    },
  },
};

export const preset = defineNativeContentArtifact(presetDefinition, {
  manifest,
  resourceRoot: new URL("../", import.meta.url),
  exportPath: "./template",
  resources: [],
  executionDependencies: ["@boringparts/template-workspace-authoring"],
});
