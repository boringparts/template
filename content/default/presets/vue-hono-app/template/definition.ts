import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { DefaultPresetRootContributionOwner } from "@boringparts/default-content-authoring/preset-root-contribution";
import { referencePackage as api } from "@boringparts/reference-hono-api/template";
import {
  honoApiDependencyKey,
  referencePackage as web,
} from "@boringparts/reference-vue-hono-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@boringparts/template-core/preset-definition";
import {
  createTemplateSourceHandle,
  resolveTemplateSource,
} from "@boringparts/template-core/template-source";
import { defineNativeContentArtifact } from "@boringparts/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };
import {
  composeVueHonoJointE2e,
  vueHonoJointE2eResourcePaths,
  type VueHonoJointE2eOwnerFacts,
} from "./joint-e2e.ts";

const resourceRoot = new URL("../", import.meta.url);
const resourceSource = createTemplateSourceHandle(fileURLToPath(resourceRoot));
const jointE2eResources = Object.values(vueHonoJointE2eResourcePaths);

function prepareJointE2eAttachment(): {
  readonly ownerFacts: VueHonoJointE2eOwnerFacts;
} {
  return Object.freeze({
    ownerFacts: Object.freeze({
      resources: Object.freeze(
        jointE2eResources.map((path) =>
          Object.freeze({
            path,
            content: new Uint8Array(
              readFileSync(resolveTemplateSource(resourceSource, path)),
            ),
            mode: 0,
          }),
        ),
      ),
    }),
  });
}

const nativePreset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vue-hono-app",
      title: "Vue-Hono Full-Stack App",
      description:
        "Combines a Vue web app, a Hono API, and shared capabilities from reference packages.",
    },
    operations: ["init"],
    nodes: {
      web: {
        reference: web,
        dependencyBindings: { [honoApiDependencyKey]: "api" },
      },
      api: { reference: api },
    },
    owner: presetOwnerFromManifest(presetPackage, "./template"),
  }),
  {
    manifest: presetPackage,
    resourceRoot,
    exportPath: "./template",
    resources: jointE2eResources.map((path) => ({
      path,
      source: createTemplateSourceHandle(
        resolveTemplateSource(resourceSource, path),
      ),
      mode: 0o644,
    })),
    executionDependencies: ["@boringparts/template-workspace-authoring"],
  },
);

const rootContribution: DefaultPresetRootContributionOwner<VueHonoJointE2eOwnerFacts> =
  Object.freeze({
    prepare: prepareJointE2eAttachment,
    compose: composeVueHonoJointE2e,
  });

/** Root contribution prepared by the default outer layer for the full preset identity and consumed by the pure composer. */
export const preset = Object.freeze({
  ...nativePreset,
  rootContribution,
});

export type { VueHonoJointE2eOwnerFacts } from "./joint-e2e.ts";
