import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { templateContent } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";

void describe("generated Oxc cache inputs", () => {
  void it("includes root Oxc configs and default shared tooling-config paths in globalDependencies", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "generated-oxc-cache-inputs-"),
    );
    try {
      const result = await createDefaultGenerator({
        content: templateContent,
      }).init({
        targetRoot: root,
        selection: {
          presets: [
            {
              contentIdentity: templateContent.find(
                (member) =>
                  member.kind === "preset" && member.alias === "ts-lib",
              )!.identity,
            },
          ],
        },
        conventions: {
          repositoryName: "oxc-cache-inputs",
          defaultPackageScope: "demo",
        },
      });
      assert.equal(result.status, "success", JSON.stringify(result));
      if (result.status !== "success") throw new Error(JSON.stringify(result));

      const toolingConfiguration = result.ownerFacts.nativeDocuments.find(
        ({ identity, sourcePath }) =>
          identity.packageName === "@ykdz/reference-tooling-config" &&
          sourcePath === "package.json",
      );
      assert.ok(toolingConfiguration);
      const packageDefinition = result.blueprint.packages.find(
        ({ packageDefinitionId }) =>
          packageDefinitionId === toolingConfiguration.packageDefinitionId,
      );
      assert.ok(packageDefinition);
      const turbo = JSON.parse(
        await readFile(path.join(root, "turbo.json"), "utf8"),
      ) as {
        readonly globalDependencies: readonly string[];
      };
      assert.deepEqual(turbo.globalDependencies, [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        `${packageDefinition.path}/oxfmt.config.ts`,
        `${packageDefinition.path}/oxlint.config.ts`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("includes root Oxc configs and custom shared tooling-config path in globalDependencies", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "generated-oxc-custom-cache-inputs-"),
    );
    try {
      const workspaceRoot = templateContent.find(
        (member) =>
          member.kind === "reference" &&
          member.identity.packageName === "@ykdz/reference-workspace-root",
      );
      const library = templateContent.find(
        (member) =>
          member.kind === "reference" &&
          member.identity.packageName === "@ykdz/reference-ts-lib",
      );
      const configuration = templateContent.find(
        (member) =>
          member.kind === "reference" &&
          member.identity.packageName === "@ykdz/reference-tooling-config",
      );
      assert.ok(workspaceRoot?.kind === "reference");
      assert.ok(library?.kind === "reference");
      assert.ok(configuration?.kind === "reference");

      const customPath = "tooling/shared-config";
      const result = await createDefaultGenerator({
        content: templateContent,
      }).init({
        targetRoot: root,
        selection: {
          roots: [
            {
              nodeIdentity: "tooling-configuration",
              contentIdentity: configuration.identity,
              creationInput: {
                leafName: "shared-config",
                packagePath: customPath,
              },
            },
            {
              nodeIdentity: "workspace-root",
              contentIdentity: workspaceRoot.identity,
              dependencyBindings: { "tooling-config": "tooling-configuration" },
            },
            {
              nodeIdentity: "library",
              contentIdentity: library.identity,
              dependencyBindings: {
                "base-workspace": "workspace-root",
                "tooling-config": "tooling-configuration",
              },
            },
          ],
        },
        conventions: {
          repositoryName: "oxc-custom-cache-inputs",
          defaultPackageScope: "demo",
        },
      });
      assert.equal(result.status, "success", JSON.stringify(result));
      if (result.status !== "success") throw new Error(JSON.stringify(result));

      const toolingConfiguration = result.ownerFacts.nativeDocuments.find(
        ({ identity, sourcePath }) =>
          identity.packageName === "@ykdz/reference-tooling-config" &&
          sourcePath === "package.json",
      );
      assert.ok(toolingConfiguration);
      const packageDefinition = result.blueprint.packages.find(
        ({ packageDefinitionId }) =>
          packageDefinitionId === toolingConfiguration.packageDefinitionId,
      );
      assert.equal(packageDefinition?.path, customPath);

      const turbo = JSON.parse(
        await readFile(path.join(root, "turbo.json"), "utf8"),
      ) as {
        readonly globalDependencies: readonly string[];
      };
      assert.deepEqual(turbo.globalDependencies, [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        `${customPath}/oxfmt.config.ts`,
        `${customPath}/oxlint.config.ts`,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it("includes root Oxc configs and shared tooling-config paths for non-TS presets", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "generated-oxc-rust-cache-inputs-"),
    );
    try {
      const result = await createDefaultGenerator({
        content: templateContent,
      }).init({
        targetRoot: root,
        selection: {
          presets: [
            {
              contentIdentity: templateContent.find(
                (member) =>
                  member.kind === "preset" && member.alias === "rust-bin",
              )!.identity,
            },
          ],
        },
        conventions: {
          repositoryName: "oxc-rust-cache-inputs",
          defaultPackageScope: "demo",
        },
      });
      assert.equal(result.status, "success", JSON.stringify(result));
      if (result.status !== "success") throw new Error(JSON.stringify(result));

      const turbo = JSON.parse(
        await readFile(path.join(root, "turbo.json"), "utf8"),
      ) as {
        readonly globalDependencies: readonly string[];
      };
      assert.deepEqual(turbo.globalDependencies, [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        "packages/tooling-config/oxfmt.config.ts",
        "packages/tooling-config/oxlint.config.ts",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
