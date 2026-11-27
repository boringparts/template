import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import {
  deriveInitializationScenarios,
  materializeGeneratedScenario,
} from "../src/generated-content.ts";
import { validateGeneratedScenarioReceipt } from "../src/registry-checks.ts";
import { sourceGeneratedScenarioRuntime } from "../src/source-generated-runtime.ts";

void describe("real generator receipt checks", () => {
  void it("rejects generated output that diverges from default owner Dockerfile facts", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-owner-facts-"),
    );
    try {
      const scenario = deriveInitializationScenarios(
        sourceGeneratedScenarioRuntime,
      ).find(
        (candidate) => candidate.base.definition.metadata.alias === "ts-lib",
      );
      assert.ok(scenario);
      const receipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario,
        workspace,
      });
      if (receipt.status !== "generated") {
        throw new Error("ts-lib initialization must be applicable");
      }
      const dockerfile = path.join(
        receipt.projectDir,
        ".devcontainer/Dockerfile",
      );
      const original = await readFile(dockerfile, "utf8");
      await writeFile(dockerfile, `${original}\n# changed owner fact\n`);
      await assert.rejects(
        validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        }),
        /does not match the default workspace owner facts/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("validates filtered minimumReleaseAgeExclude alignment in generated pnpm-workspace.yaml", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-release-age-exclude-"),
    );
    try {
      const scenarios = deriveInitializationScenarios(
        sourceGeneratedScenarioRuntime,
      );
      const tsCliScenario = scenarios.find(
        (candidate) => candidate.base.definition.metadata.alias === "ts-cli",
      );
      const tsLibScenario = scenarios.find(
        (candidate) => candidate.base.definition.metadata.alias === "ts-lib",
      );
      assert.ok(tsCliScenario);
      assert.ok(tsLibScenario);

      const cliReceipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario: tsCliScenario,
        workspace,
      });
      if (cliReceipt.status !== "generated") {
        throw new Error("ts-cli initialization must be applicable");
      }
      await validateGeneratedScenarioReceipt({
        receipt: cliReceipt,
        runtime: sourceGeneratedScenarioRuntime,
      });
      const cliWorkspacePath = path.join(
        cliReceipt.projectDir,
        "pnpm-workspace.yaml",
      );
      const cliWorkspace = parseYaml(
        await readFile(cliWorkspacePath, "utf8"),
      ) as Record<string, unknown>;
      delete cliWorkspace.minimumReleaseAgeExclude;
      await writeFile(cliWorkspacePath, stringifyYaml(cliWorkspace));
      await assert.rejects(
        validateGeneratedScenarioReceipt({
          receipt: cliReceipt,
          runtime: sourceGeneratedScenarioRuntime,
        }),
        /minimumReleaseAgeExclude/u,
      );

      const libReceipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario: tsLibScenario,
        workspace,
      });
      if (libReceipt.status !== "generated") {
        throw new Error("ts-lib initialization must be applicable");
      }
      await validateGeneratedScenarioReceipt({
        receipt: libReceipt,
        runtime: sourceGeneratedScenarioRuntime,
      });
      const libWorkspacePath = path.join(
        libReceipt.projectDir,
        "pnpm-workspace.yaml",
      );
      const libWorkspace = parseYaml(
        await readFile(libWorkspacePath, "utf8"),
      ) as Record<string, unknown>;
      libWorkspace.minimumReleaseAgeExclude = ["@boringparts/cli-contract"];
      await writeFile(libWorkspacePath, stringifyYaml(libWorkspace));
      await assert.rejects(
        validateGeneratedScenarioReceipt({
          receipt: libReceipt,
          runtime: sourceGeneratedScenarioRuntime,
        }),
        /minimumReleaseAgeExclude/u,
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  void it("rejects unreferenced named catalogs and validates referenced named catalogs in generated pnpm-workspace.yaml", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "template-generated-named-catalogs-"),
    );
    try {
      const tsLibScenario = deriveInitializationScenarios(
        sourceGeneratedScenarioRuntime,
      ).find(
        (candidate) => candidate.base.definition.metadata.alias === "ts-lib",
      );
      assert.ok(tsLibScenario);
      const receipt = await materializeGeneratedScenario({
        runtime: sourceGeneratedScenarioRuntime,
        scenario: tsLibScenario,
        workspace,
      });
      if (receipt.status !== "generated") {
        throw new Error("ts-lib initialization must be applicable");
      }

      const workspacePath = path.join(
        receipt.projectDir,
        "pnpm-workspace.yaml",
      );
      const originalWorkspace = await readFile(workspacePath, "utf8");
      const parsedWorkspace = parseYaml(originalWorkspace) as Record<
        string,
        unknown
      >;
      assert.strictEqual("catalogs" in parsedWorkspace, false);

      await writeFile(
        workspacePath,
        stringifyYaml({
          ...parsedWorkspace,
          catalogs: { "node-24": { "@types/node": "~24.0.0" } },
        }),
      );
      await assert.rejects(
        validateGeneratedScenarioReceipt({
          receipt,
          runtime: sourceGeneratedScenarioRuntime,
        }),
        /named dependency catalogs/u,
      );

      const libManifestPath = path.join(
        receipt.projectDir,
        "packages/lib/package.json",
      );
      const libManifest = JSON.parse(
        await readFile(libManifestPath, "utf8"),
      ) as {
        devDependencies: Record<string, string>;
      };
      libManifest.devDependencies["@types/node"] = "catalog:node-24";
      await writeFile(
        libManifestPath,
        `${JSON.stringify(libManifest, null, 2)}\n`,
      );
      await validateGeneratedScenarioReceipt({
        receipt,
        runtime: sourceGeneratedScenarioRuntime,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
