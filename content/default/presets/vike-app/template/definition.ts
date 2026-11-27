import type { DefaultPresetRootContributionOwner } from "@boringparts/default-content-authoring/preset-root-contribution";
import { referencePackage as database } from "@boringparts/reference-vike-db/template";
import {
  databaseDependencyKey as migrationsDatabaseDependencyKey,
  referencePackage as migrations,
} from "@boringparts/reference-vike-migrations/template";
import {
  databaseDependencyKey as webDatabaseDependencyKey,
  referencePackage as web,
} from "@boringparts/reference-vike-web/template";
import {
  definePreset,
  presetOwnerFromManifest,
} from "@boringparts/template-core/preset-definition";
import { defineNativeContentArtifact } from "@boringparts/template-workspace-authoring/content-artifact";

import presetPackage from "../package.json" with { type: "json" };
import {
  vikeDeploymentResources,
  vikeRootContribution,
  type VikeDeploymentOwnerFacts,
} from "./deployment.ts";

const owner = presetOwnerFromManifest(presetPackage, "./template");

const nodes = {
  web: {
    reference: web,
    dependencyBindings: { [webDatabaseDependencyKey]: "database" },
  },
  database: { reference: database },
  migrations: {
    reference: migrations,
    dependencyBindings: { [migrationsDatabaseDependencyKey]: "database" },
  },
};

const nativePreset = defineNativeContentArtifact(
  definePreset({
    metadata: {
      alias: "vike-app",
      title: "Vike App",
      description:
        "Combines Vike Web, database, and migrations packages with database preparation and deployment support.",
    },
    operations: ["init"],
    nodes,
    owner,
  }),
  {
    manifest: presetPackage,
    resourceRoot: new URL("../", import.meta.url),
    exportPath: "./template",
    resources: vikeDeploymentResources,
    executionDependencies: [
      "@boringparts/default-content-authoring",
      "@boringparts/template-workspace-authoring",
      "yaml",
    ],
  },
);

/** Outer layer prepares resources by full preset identity; pure composition consumes the same evaluation result. */
export const preset = Object.freeze({
  ...nativePreset,
  rootContribution:
    vikeRootContribution satisfies DefaultPresetRootContributionOwner<VikeDeploymentOwnerFacts>,
});
