import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { preset as presetDefinition } from "@boringparts/preset-ts-lib/template";
import { referencePackage as libraryDefinition } from "@boringparts/reference-ts-lib/template";
import {
  contentIdentityKey,
  type ContentIdentity,
} from "@boringparts/template-core/content-identity";
import { definePreset } from "@boringparts/template-core/preset-definition";
import { loadContentSource } from "@boringparts/template-generator/content-source";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@boringparts/reference-workspace-root/template",
      load: () => import("@boringparts/reference-workspace-root/template"),
    },
    {
      specifier: "@boringparts/reference-ts-lib/template",
      load: () => import("@boringparts/reference-ts-lib/template"),
    },
    {
      specifier: "@boringparts/reference-tooling-config/template",
      load: () => import("@boringparts/reference-tooling-config/template"),
    },
    {
      specifier: "@boringparts/reference-npm-publication/template",
      load: () => import("@boringparts/reference-npm-publication/template"),
    },
    {
      specifier: "@boringparts/preset-ts-lib/template",
      load: () => import("@boringparts/preset-ts-lib/template"),
    },
  ],
});
const root = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-workspace-root",
);
const library = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-ts-lib",
);
const configuration = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-tooling-config",
);
const publication = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-npm-publication",
);
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-ts-lib",
);
assert.ok(root);
assert.ok(library);
assert.ok(configuration);
assert.ok(publication);
assert.ok(preset);

async function snapshotTree(root: string): Promise<string> {
  const files: { path: string; mode: number; content: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, relativePath);
      } else {
        files.push({
          path: relativePath,
          mode: (await stat(fullPath)).mode & 0o777,
          content: await readFile(fullPath, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(files);
}

const temporaryRoots = new Set<string>();

async function createTemporaryRoot(prefix: string, name = "demo") {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, name);
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("TypeScript library public preset", () => {
  void it("initializes, adds packages repeatedly, and reuses shared configuration via public declarations", async () => {
    const targetRoot = await createTemporaryRoot("template-ts-lib-preset-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const rootConfig = JSON.parse(
      await readFile(path.join(targetRoot, "tsconfig.config.json"), "utf8"),
    ) as { readonly extends: string };
    const libraryConfig = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/lib/tsconfig.node.json"),
        "utf8",
      ),
    ) as { readonly extends: string };
    const generatedToolingManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/tooling-config/package.json"),
        "utf8",
      ),
    ) as {
      readonly exports: Readonly<Record<string, unknown>>;
      readonly devDependencies: Readonly<Record<string, string>>;
    };
    const generatedRootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { readonly devDependencies: Readonly<Record<string, string>> };
    assert.equal(rootConfig.extends, "@demo/tooling-config/node.json");
    assert.equal(libraryConfig.extends, "@demo/tooling-config/node.json");
    assert.deepEqual(Object.keys(generatedToolingManifest.exports).toSorted(), [
      "./base.json",
      "./node.json",
      "./oxfmt",
      "./oxlint",
    ]);
    assert.equal(
      generatedToolingManifest.devDependencies["@boringparts/tooling-config"],
      undefined,
    );
    assert.equal(
      generatedRootManifest.devDependencies["@boringparts/tooling-config"],
      undefined,
    );
    assert.match(
      await readFile(path.join(targetRoot, "oxlint.config.ts"), "utf8"),
      /@demo\/tooling-config\/oxlint/u,
    );
    assert.match(
      await readFile(path.join(targetRoot, "oxfmt.config.ts"), "utf8"),
      /@demo\/tooling-config\/oxfmt/u,
    );
    const initialRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: { nodes: Record<string, string> }[];
    };
    assert.partialDeepStrictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/lib/package.json"),
          "utf8",
        ),
      ),
      { name: "@demo/lib" },
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "packages/lib/src/index.ts"))).mode &
        0o777,
      0o644,
    );
    assert.strictEqual(
      (await stat(path.join(targetRoot, "package.json"))).mode & 0o777,
      0o644,
    );

    const sourcePath = path.join(targetRoot, "packages/lib/src/index.ts");
    const rootManifestPath = path.join(targetRoot, "package.json");
    await writeFile(sourcePath, "export const localChange = true;\n");
    const rootManifest = JSON.parse(
      await readFile(rootManifestPath, "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    rootManifest.scripts.custom = "echo retained";
    await writeFile(
      rootManifestPath,
      JSON.stringify(rootManifest, null, 2) + "\n",
    );

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const beforePreview = await readFile(generationPath, "utf8");
    const preview = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
      dryRun: true,
    });
    assert.strictEqual(preview.status, "success", JSON.stringify(preview));
    assert.strictEqual(await readFile(generationPath, "utf8"), beforePreview);
    await assert.rejects(stat(path.join(targetRoot, "packages/shared")));

    const first = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
    });
    assert.strictEqual(first.status, "success", JSON.stringify(first));
    const repeated = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "shared" },
    });
    assert.strictEqual(repeated.status, "success", JSON.stringify(repeated));
    if (repeated.status === "success")
      assert.deepStrictEqual(repeated.actions, []);

    const second = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "another" },
    });
    assert.strictEqual(second.status, "success", JSON.stringify(second));
    const updatedRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: { nodes: Record<string, string> }[];
    };
    assert.strictEqual(
      updatedRecord.selections[0]?.nodes.library,
      initialRecord.selections[0]?.nodes.library,
    );
    for (const identity of [library.identity, configuration.identity]) {
      assert.strictEqual(
        updatedRecord.packages.find(
          (item) =>
            contentIdentityKey(item.contentIdentity) ===
            contentIdentityKey(identity),
        )?.packageDefinitionId,
        initialRecord.packages.find(
          (item) =>
            contentIdentityKey(item.contentIdentity) ===
            contentIdentityKey(identity),
        )?.packageDefinitionId,
      );
    }
    assert.strictEqual(
      await readFile(sourcePath, "utf8"),
      "export const localChange = true;\n",
    );
    assert.strictEqual(
      (await readFile(rootManifestPath, "utf8")).includes(
        '"custom": "echo retained"',
      ),
      true,
    );

    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.strictEqual(
      blueprint.packages.filter(
        (item) => item.path === "packages/tooling-config",
      ).length,
      1,
    );
    assert.strictEqual(
      blueprint.packages.some((item) => item.path === "packages/another"),
      true,
    );
  });

  void it("produces the same initialization graph for direct reference and preset selections", async () => {
    const roots = await Promise.all([
      mkdtemp(path.join(tmpdir(), "template-ts-lib-preset-graph-")),
      mkdtemp(path.join(tmpdir(), "template-ts-lib-reference-graph-")),
    ]);
    for (const temporaryRoot of roots) temporaryRoots.add(temporaryRoot);
    const presetGenerator = createDefaultGenerator({ content });
    const referenceGenerator = createDefaultGenerator({
      content,
    });
    const presetResult = await presetGenerator.init({
      targetRoot: path.join(roots[0]!, "demo"),
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    const referenceResult = await referenceGenerator.init({
      targetRoot: path.join(roots[1]!, "demo"),
      selection: {
        roots: [
          { nodeIdentity: "root", contentIdentity: root.identity },
          { nodeIdentity: "library", contentIdentity: library.identity },
        ],
      },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(presetResult.status, "success");
    assert.strictEqual(referenceResult.status, "success");
    if (
      presetResult.status !== "success" ||
      referenceResult.status !== "success"
    ) {
      throw new Error(
        "Successful initialization should return a generation result",
      );
    }
    const comparableBlueprint = (blueprint: typeof presetResult.blueprint) => ({
      ...blueprint,
      packages: blueprint.packages
        .map(({ name, path, role }) => ({ name, path, role }))
        .toSorted((left, right) => left.path.localeCompare(right.path)),
    });
    assert.deepStrictEqual(
      comparableBlueprint(presetResult.blueprint),
      comparableBlueprint(referenceResult.blueprint),
    );
    assert.deepStrictEqual(
      presetResult.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [preset.identity],
    );
    assert.deepStrictEqual(
      referenceResult.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [null],
    );
    const presetFiles = JSON.parse(
      await snapshotTree(path.join(roots[0]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    const referenceFiles = JSON.parse(
      await snapshotTree(path.join(roots[1]!, "demo")),
    ) as { path: string; mode: number; content: string }[];
    assert.deepStrictEqual(
      presetFiles.filter(
        (entry) =>
          entry.path !== ".template/generation.json" &&
          entry.path !== ".template/blueprint.json",
      ),
      referenceFiles.filter(
        (entry) =>
          entry.path !== ".template/generation.json" &&
          entry.path !== ".template/blueprint.json",
      ),
    );
  });

  void it("propagates node layout and operation inputs across init, repeated adds, and replay", async () => {
    const layoutPreset = definePreset({
      metadata: presetDefinition.metadata,
      operations: presetDefinition.operations,
      nodes: {
        library: {
          reference: libraryDefinition,
          layout: { packageDirectory: "modules" },
          creationInput: {
            init: { leafName: "archive" },
            add: { leafName: "fallback" },
          },
        },
      },
    });
    const layoutPresetMember = Object.freeze({
      ...preset,
      alias: layoutPreset.metadata.alias,
      definition: layoutPreset,
    });
    const targetRoot = await createTemporaryRoot("template-ts-lib-layout-");
    const generator = createDefaultGenerator({
      content: [root, library, configuration, publication, layoutPresetMember],
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        presets: [{ contentIdentity: layoutPresetMember.identity }],
      },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "modules/archive/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/archive",
    );
    const fallback = await generator.add({
      repositoryRoot: targetRoot,
      preset: layoutPresetMember.identity,
    });
    assert.strictEqual(fallback.status, "success", JSON.stringify(fallback));
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "modules/fallback/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/fallback",
    );

    for (const [index, leafName] of ["second", "second", "third"].entries()) {
      const result = await generator.add({
        repositoryRoot: targetRoot,
        preset: layoutPresetMember.identity,
        creationInput: { leafName },
      });
      assert.strictEqual(result.status, "success", JSON.stringify(result));
      if (index === 1 && result.status === "success") {
        assert.deepStrictEqual(result.actions, []);
      }
      assert.strictEqual(
        JSON.parse(
          await readFile(
            path.join(targetRoot, `modules/${leafName}/package.json`),
            "utf8",
          ),
        ).name,
        `@demo/${leafName}`,
      );
    }
    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as { packages: { path: string }[] };
    assert.deepStrictEqual(
      blueprint.packages.map((item) => item.path).toSorted(),
      [
        ".",
        "modules/archive",
        "modules/fallback",
        "modules/second",
        "modules/third",
        "packages/tooling-config",
      ].toSorted(),
    );
    await assert.rejects(stat(path.join(targetRoot, "packages/lib")));
  });

  void it("leaves target unchanged when a native shared dependency is missing or an added path conflicts", async () => {
    const missingTarget = await createTemporaryRoot("template-ts-lib-missing-");
    const missingGenerator = createDefaultGenerator({
      content: [root, library, publication, preset],
    });
    const missing = await missingGenerator.init({
      targetRoot: missingTarget,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(missing.status, "operation-failure");
    await assert.rejects(readFile(path.join(missingTarget, "package.json")));

    const targetRoot = await createTemporaryRoot("template-ts-lib-conflict-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");
    const occupiedDirectory = path.join(targetRoot, "packages/occupied");
    await mkdir(occupiedDirectory, { recursive: true });
    const userFile = path.join(occupiedDirectory, "keep.txt");
    await writeFile(userFile, "user data\n");
    const before = await readFile(
      path.join(targetRoot, ".template/generation.json"),
      "utf8",
    );

    const conflict = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "occupied" },
    });

    assert.strictEqual(conflict.status, "conflict");
    assert.strictEqual(await readFile(userFile, "utf8"), "user data\n");
    assert.strictEqual(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
      before,
    );
  });

  void it("does not restore a missing manifest of an unlinked existing library during add", async () => {
    const targetRoot = await createTemporaryRoot(
      "template-ts-lib-missing-manifest-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const existingManifest = path.join(targetRoot, "packages/lib/package.json");
    await unlink(existingManifest);

    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "utilities" },
    });

    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") {
      throw new Error("Package addition should succeed");
    }
    assert.ok(
      !added.actions.some(
        (action) => action.path === "packages/lib/package.json",
      ),
    );
    await assert.rejects(stat(existingManifest), { code: "ENOENT" });
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, "packages/utilities/package.json"),
          "utf8",
        ),
      ).name,
      "@demo/utilities",
    );
  });

  void it("fails without committing when the generation record is missing a required binding", async () => {
    const targetRoot = await createTemporaryRoot("template-ts-lib-binding-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });
    assert.strictEqual(initialized.status, "success");

    const generationPath = path.join(targetRoot, ".template/generation.json");
    const record = JSON.parse(await readFile(generationPath, "utf8")) as {
      packages: {
        contentIdentity: ContentIdentity;
        dependencyBindings: Record<string, string>;
      }[];
    };
    const libraryRecord = record.packages.find(
      (item) =>
        contentIdentityKey(item.contentIdentity) ===
        contentIdentityKey(library.identity),
    );
    assert.ok(libraryRecord);
    libraryRecord.dependencyBindings["tooling-config"] =
      "missing-package-instance";
    const corruptedRecord = JSON.stringify(record, null, 2) + "\n";
    await writeFile(generationPath, corruptedRecord);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "rejected" },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.strictEqual(await readFile(generationPath, "utf8"), corruptedRecord);
    await assert.rejects(stat(path.join(targetRoot, "packages/rejected")));
  });

  void it("generates a platform-neutral library package with relative source imports and self-referencing tests", async () => {
    const targetRoot = await createTemporaryRoot("template-ts-lib-neutral-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const packageRoot = path.join(targetRoot, "packages/lib");
    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly imports?: unknown;
      readonly engines?: unknown;
      readonly devEngines?: unknown;
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.strictEqual("imports" in manifest, false);
    assert.strictEqual("engines" in manifest, false);
    assert.strictEqual("devEngines" in manifest, false);
    assert.match(manifest.scripts.test ?? "", /--conditions=source/u);
    assert.strictEqual(
      manifest.scripts["test:dist"],
      "node --test --test-reporter=spec 'test/**/*.test.ts'",
    );

    const turboConfig = JSON.parse(
      await readFile(path.join(packageRoot, "turbo.json"), "utf8"),
    ) as {
      readonly tasks: Readonly<
        Record<
          string,
          {
            readonly dependsOn?: readonly string[];
            readonly outputs?: readonly string[];
            readonly tags?: readonly string[];
          }
        >
      >;
    };
    assert.deepStrictEqual(turboConfig.tasks.test?.tags, ["quality:light"]);
    assert.deepStrictEqual(turboConfig.tasks["test:dist"], {
      dependsOn: ["build"],
      inputs: [],
      outputs: [],
      tags: ["quality:heavy"],
    });

    const buildTsconfig = JSON.parse(
      await readFile(path.join(packageRoot, "tsconfig.build.json"), "utf8"),
    ) as {
      readonly compilerOptions: {
        readonly customConditions?: readonly string[];
        readonly lib?: readonly string[];
        readonly skipLibCheck?: boolean;
        readonly types?: readonly string[];
      };
    };
    assert.deepStrictEqual(buildTsconfig.compilerOptions.customConditions, []);
    assert.deepStrictEqual(buildTsconfig.compilerOptions.lib, ["es2024"]);
    // Required because zod's .d.cts references global URL under pure es2024 + types: [].
    assert.strictEqual(buildTsconfig.compilerOptions.skipLibCheck, true);
    assert.deepStrictEqual(buildTsconfig.compilerOptions.types, []);

    const nodeTsconfig = JSON.parse(
      await readFile(path.join(packageRoot, "tsconfig.node.json"), "utf8"),
    ) as {
      readonly compilerOptions: {
        readonly types?: readonly string[];
      };
    };
    assert.deepStrictEqual(nodeTsconfig.compilerOptions.types, ["node"]);

    const entrySource = await readFile(
      path.join(packageRoot, "src/index.ts"),
      "utf8",
    );
    assert.match(entrySource, /from "\.\/name-schema\.ts"/u);
    assert.doesNotMatch(entrySource, /#\/name-schema/u);

    const greetTestSource = await readFile(
      path.join(packageRoot, "test/greet.test.ts"),
      "utf8",
    );
    assert.match(greetTestSource, /from "@demo\/lib"/u);
    assert.doesNotMatch(greetTestSource, /\.\.\/src\/index\.ts/u);
  });
});
