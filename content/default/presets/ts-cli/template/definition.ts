import { referencePackage } from "@ykdz/reference-ts-cli/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

export const preset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "ts-cli",
      title: "TypeScript CLI",
      description:
        "TypeScript command-line package using pnpm catalog tooling configuration.",
    },
    operations: ["init", "add"],
    owner: presetOwnerFromManifest(presetPackage, "./template"),
    nodes: {
      cli: {
        reference: referencePackage,
      },
    },
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    executionDependencies: ["@ykdz/template-workspace-authoring"],
  },
);
