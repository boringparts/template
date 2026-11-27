import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  templateContent,
  templatePresets,
} from "@boringparts/template-content";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

async function initialize(
  targetRoot: string,
  preset: (typeof templatePresets)[number],
): Promise<void> {
  const result = await createDefaultGenerator({
    content: templateContent,
  }).init({
    targetRoot,
    selection: {
      presets: [{ contentIdentity: preset.identity }],
    },
    conventions: {
      repositoryName: "generated-repository",
      defaultPackageScope: "generated",
    },
  });
  assert.strictEqual(result.status, "success", JSON.stringify(result));
}

void describe("generated task public entrypoints", () => {
  void it("projects native Turbo boundary commands for every public initialization preset", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "template-gates-"));

    try {
      for (const preset of templatePresets) {
        const targetRoot = path.join(workspace, preset.identity.packageName);
        await initialize(targetRoot, preset);

        const rootManifest = JSON.parse(
          await readFile(path.join(targetRoot, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const turbo = JSON.parse(
          await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
        ) as {
          readonly tasks: Readonly<
            Record<string, { readonly tags?: readonly string[] }>
          >;
        };

        assert.deepStrictEqual(
          {
            check: rootManifest.scripts.check,
            "check:heavy": rootManifest.scripts["check:heavy"],
            "check:full": rootManifest.scripts["check:full"],
            fix: rootManifest.scripts.fix,
            boundaries: rootManifest.scripts.boundaries,
          },
          {
            check: "node --conditions=source scripts/task-gates.ts check",
            "check:heavy":
              "node --conditions=source scripts/task-gates.ts check:heavy",
            "check:full":
              "node --conditions=source scripts/task-gates.ts check:full",
            fix: "node --conditions=source scripts/task-gates.ts fix",
            boundaries: "turbo boundaries",
          },
        );

        for (const gate of ["check", "check:heavy", "check:full"]) {
          assert.deepStrictEqual(turbo.tasks[`//#${gate}`]?.tags, [
            "quality:entry",
          ]);
        }
        assert.deepStrictEqual(turbo.tasks["//#fix"]?.tags, ["work:repair"]);

        const toolingConfigManifestPath = path.join(
          targetRoot,
          "packages/tooling-config/package.json",
        );
        const toolingConfigManifest = JSON.parse(
          await readFile(toolingConfigManifestPath, "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        assert.match(toolingConfigManifest.scripts.lint ?? "", /--type-aware/u);
        assert.match(
          toolingConfigManifest.scripts["lint:fix"] ?? "",
          /--type-aware/u,
        );
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
