import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

import { createTemplateSourceHandle } from "@ykdz/template-core/template-source";
import { defineNativeContentArtifact } from "@ykdz/template-workspace-authoring/content-artifact";

void it("public artifact handle preserves compiled files, resource bytes, and dependency purposes", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "workspace-authoring-artifact-"),
  );
  try {
    const compiledRoot = path.join(root, "template-dist");
    const resourcePath = path.join(root, "resources/guide.md");
    await mkdir(compiledRoot, { recursive: true });
    await mkdir(path.dirname(resourcePath), { recursive: true });
    await writeFile(
      path.join(compiledRoot, "index.js"),
      'export const version = "v1";\n',
    );
    await writeFile(
      path.join(compiledRoot, "index.d.ts"),
      'export declare const version: "v1";\n',
    );
    await writeFile(resourcePath, "author resource\n");

    const artifact = defineNativeContentArtifact(
      { alias: "artifact-fixture" },
      {
        manifest: {
          name: "@fixture/native-content",
          version: "1.2.3",
          exports: {
            "./template": {
              default: "./template-dist/index.js",
              types: "./template-dist/index.d.ts",
            },
          },
          dependencies: { "@fixture/runtime": "^2.0.0" },
          devDependencies: { typescript: "catalog:" },
        },
        resourceRoot: pathToFileURL(`${root}${path.sep}`),
        exportPath: "./template",
        resources: [
          {
            path: "resources/guide.md",
            source: createTemplateSourceHandle(resourcePath),
            mode: 0o640,
          },
        ],
        dependencyPurposes: new Map([
          ["@fixture/runtime", ["target"] as const],
        ]),
        executionDependencies: ["typescript"],
      },
    );
    const prepared = artifact.prepareArtifact();

    assert.deepEqual(prepared.coordinate, {
      name: "@fixture/native-content",
      version: "1.2.3",
    });
    assert.deepEqual(
      prepared.compiled.map(({ path: filePath, data }) => [
        filePath,
        data.toString(),
      ]),
      [
        ["template-dist/index.d.ts", 'export declare const version: "v1";\n'],
        ["template-dist/index.js", 'export const version = "v1";\n'],
      ],
    );
    assert.deepEqual(
      prepared.resources.map(({ path: filePath, data, mode }) => [
        filePath,
        data.toString(),
        mode,
      ]),
      [["resources/guide.md", "author resource\n", 0o640]],
    );
    assert.deepEqual(prepared.dependencies, [
      {
        name: "@fixture/runtime",
        specifier: "^2.0.0",
        purposes: ["target"],
      },
      {
        name: "typescript",
        specifier: "catalog:",
        purposes: ["template-execution"],
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void it("rejects template execution dependencies not declared in the manifest", () => {
  assert.throws(
    () =>
      defineNativeContentArtifact(
        { alias: "artifact-fixture" },
        {
          manifest: {
            name: "@fixture/native-content",
            version: "1.2.3",
            exports: {
              "./template": { default: "./template-dist/index.js" },
            },
          },
          resourceRoot: pathToFileURL(`${tmpdir()}${path.sep}`),
          exportPath: "./template",
          executionDependencies: ["@fixture/undeclared"],
        },
      ),
    /Template execution dependency is not declared in the owning manifest: @fixture\/native-content\/@fixture\/undeclared/,
  );
});
