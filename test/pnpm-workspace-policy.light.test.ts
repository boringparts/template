import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectGeneratedManifestCatalogSelections,
  loadTemplateNamedDependencyCatalogs,
  renderGeneratedPnpmWorkspaceYaml,
  selectMinimumReleaseAgeExclusions,
  selectTemplateNamedDependencyCatalogEntries,
} from "@boringparts/template-workspace/dependency-catalog";

void describe("pnpm Workspace Policy", () => {
  void it("renders only explicitly requested dependency overrides", () => {
    const workspace = renderGeneratedPnpmWorkspaceYaml({
      dependencies: [],
      overrides: { "example>peer": "-" },
    });

    assert.ok(workspace.includes('"example>peer": "-"'));
    assert.ok(workspace.includes("injectWorkspacePackages: false"));
    assert.ok(!workspace.includes("pnpmfile"));
  });

  void it("projects only selected exact package names for minimumReleaseAgeExclude", () => {
    assert.deepStrictEqual(
      selectMinimumReleaseAgeExclusions(
        ["@boringparts/cli-contract", "zod"],
        new Set(["@boringparts/cli-contract", "oxlint"]),
      ),
      ["@boringparts/cli-contract"],
    );
    assert.deepStrictEqual(
      selectMinimumReleaseAgeExclusions(
        ["@boringparts/cli-contract"],
        new Set(["zod", "oxlint"]),
      ),
      [],
    );
    for (const invalid of [
      ["@boringparts/*"],
      ["@boringparts/cli-contract@0.7.0"],
      [""],
      ["zod", "zod"],
    ]) {
      assert.throws(() =>
        selectMinimumReleaseAgeExclusions(
          invalid,
          new Set(["@boringparts/cli-contract", "zod"]),
        ),
      );
    }
  });

  void it("separates default catalog references from named catalog references and projects named catalogs on demand", () => {
    const manifests = [
      {
        dependencies: {
          zod: "catalog:",
          "@boringparts/cli-contract": "catalog:default",
        },
        devDependencies: {
          "@types/node": "catalog:node-24",
        },
      },
    ];
    const selections = collectGeneratedManifestCatalogSelections(manifests);
    assert.deepStrictEqual(selections, {
      defaultDependencies: ["@boringparts/cli-contract", "zod"],
      namedDependencies: {
        "node-24": ["@types/node"],
      },
    });
    assert.deepStrictEqual(
      selectTemplateNamedDependencyCatalogEntries(selections.namedDependencies),
      {
        "node-24": {
          "@types/node": "~24.0.0",
        },
      },
    );
    assert.deepStrictEqual(loadTemplateNamedDependencyCatalogs()["node-24"], {
      "@types/node": "~24.0.0",
    });
    assert.throws(() =>
      selectTemplateNamedDependencyCatalogEntries({
        "missing-catalog": ["@types/node"],
      }),
    );
  });
});
