import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  renderGeneratedPnpmWorkspaceYaml,
  selectMinimumReleaseAgeExclusions,
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
});
