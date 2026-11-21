import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadEditorCustomizationDeclarations,
  parseWorkspaceTemplateConfiguration,
  prepareWorkspaceDevelopmentContainerResources,
  projectWorkspaceEditorCustomization,
} from "@ykdz/reference-workspace-root/environment";
import { projectDependabotConfig } from "@ykdz/reference-workspace-root/project-github";

void describe("根环境编辑器设置组合", () => {
  void it("拒绝冲突资源中的设置并报告位置及双方来源", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "default-editor-conflict-"),
    );
    const resourcePath = path.join(directory, "capabilities.json");
    try {
      await writeFile(
        resourcePath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            capabilityOrder: ["formatter-a", "formatter-b"],
            capabilities: {
              "formatter-a": {
                extensions: [],
                settings: { "editor.defaultFormatter": "tool-a" },
              },
              "formatter-b": {
                extensions: [],
                settings: { "editor.defaultFormatter": "tool-b" },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
      const declarations = loadEditorCustomizationDeclarations(
        resourcePath,
        resourcePath,
      );

      assert.throws(
        () =>
          projectWorkspaceEditorCustomization(
            ["formatter-a", "formatter-b"],
            declarations,
          ),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("/settings/editor.defaultFormatter") &&
          error.message.includes(
            `${resourcePath}#/capabilities/formatter-a/settings`,
          ) &&
          error.message.includes(
            `${resourcePath}#/capabilities/formatter-b/settings`,
          ),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  void it("validates dependabot template structure before projecting updates", () => {
    const valid = [
      "version: 2",
      "updates:",
      "  - package-ecosystem: npm",
      "    directory: /",
      "    schedule:",
      "      interval: daily",
    ].join("\n");

    const projected = projectDependabotConfig(
      { ecosystems: ["npm"], interval: "weekly" },
      valid,
    );
    assert.match(projected, /interval: weekly/u);

    for (const malformed of [
      "version: 2\n",
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: packages/app\n    schedule:\n      interval: daily\n",
      "version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n",
    ]) {
      assert.throws(() =>
        projectDependabotConfig(
          { ecosystems: ["npm"], interval: "weekly" },
          malformed,
        ),
      );
    }
  });

  void it("validates workspace devcontainer template configuration shape", () => {
    const resources = prepareWorkspaceDevelopmentContainerResources();
    assert.equal(typeof resources.configuration.features, "object");

    const valid = parseWorkspaceTemplateConfiguration({
      features: { "ghcr.io/devcontainers/features/node:1": {} },
    });
    assert.deepEqual(valid.features, {
      "ghcr.io/devcontainers/features/node:1": {},
    });

    for (const invalid of [{}, { features: [] }]) {
      assert.throws(
        () => parseWorkspaceTemplateConfiguration(invalid),
        /@ykdz\/reference-workspace-root#\.\/environment workspace-template\.json must contain a features object/u,
      );
    }

    assert.throws(
      () =>
        parseWorkspaceTemplateConfiguration({
          features: { node: "bad" },
        }),
      /@ykdz\/reference-workspace-root#\.\/environment workspace-template\.json features\.node must be an object/u,
    );
  });
});
