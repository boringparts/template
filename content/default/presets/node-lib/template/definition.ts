import { referencePackage } from "@boringparts/reference-node-lib/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@boringparts/template-core/preset-definition";
import { defineNativeContentArtifact } from "@boringparts/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "node-lib",
      title: "Node.js Library",
      description:
        "Node.js library package targeting Node 24+ with pnpm catalog tooling configuration.",
    },
    operations: ["init", "add"],
    owner: presetOwnerFromManifest(presetPackage, "./template"),
    nodes: {
      library: { reference: referencePackage },
    },
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    executionDependencies: ["@boringparts/template-workspace-authoring"],
  },
);
