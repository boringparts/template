import { referencePackage } from "@ykdz/reference-rust-bin/template";
import {
  definePreset,
  presetOwnerFromManifest,
  type PresetDefinition,
  type PresetReference,
} from "@ykdz/template-core/preset-definition";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };

const rustBinaryPreset: PresetDefinition<PresetReference> = definePreset({
  metadata: {
    alias: "rust-bin",
    title: "Rust Binary",
    description:
      "Native Rust binary workspace with rustfmt, clippy, and cargo tests.",
  },
  operations: ["init", "add"],
  owner: presetOwnerFromManifest(presetPackage, "./template"),
  nodes: {
    binary: { reference: referencePackage },
  },
});

export const preset = defineNativeContentArtifact(rustBinaryPreset, {
  manifest: presetPackage,
  resourceRoot: new URL("../", import.meta.url),
  exportPath: "./template",
  executionDependencies: ["@ykdz/template-workspace-authoring"],
});
