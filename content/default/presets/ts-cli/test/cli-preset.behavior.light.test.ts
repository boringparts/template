import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";
import type { LoadedContentMember } from "@boringparts/template-core/content-identity";
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
      specifier: "@boringparts/reference-ts-cli/template",
      load: () => import("@boringparts/reference-ts-cli/template"),
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
      specifier: "@boringparts/preset-ts-cli/template",
      load: () => import("@boringparts/preset-ts-cli/template"),
    },
    {
      specifier: "@boringparts/preset-ts-lib/template",
      load: () => import("@boringparts/preset-ts-lib/template"),
    },
  ],
});

const cli = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-ts-cli",
);
const root = content.find(
  (member) =>
    member.kind === "reference" &&
    member.identity.packageName === "@boringparts/reference-workspace-root",
);
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-ts-cli",
);
const libraryPreset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-ts-lib",
);
assert.ok(cli);
assert.ok(root);
assert.ok(preset);
assert.ok(libraryPreset);

const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

async function readManifest(
  targetRoot: string,
  packagePath: string,
): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(path.join(targetRoot, packagePath, "package.json"), "utf8"),
  ) as Record<string, any>;
}

async function snapshotTree(root: string): Promise<string> {
  const entries: {
    path: string;
    kind: "directory" | "file";
    mode: number;
    bytes: string;
  }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        entries.push({
          path: file,
          kind: "directory",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: "",
        });
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          kind: "file",
          mode: (await stat(filePath)).mode & 0o777,
          bytes: (await readFile(filePath)).toString("base64"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify({
    rootMode: (await stat(root)).mode & 0o777,
    entries,
  });
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("TypeScript CLI public preset", () => {
  void it("shares native bin entry and Node engine transformation between direct reference and single-node preset", async () => {
    const targets = await Promise.all([
      createTargetRoot("template-ts-cli-direct-"),
      createTargetRoot("template-ts-cli-preset-"),
    ]);
    const conventions = {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    };
    const presetResult = await createDefaultGenerator({ content }).init({
      targetRoot: targets[0],
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    const referenceResult = await createDefaultGenerator({ content }).init({
      targetRoot: targets[1],
      selection: {
        roots: [{ nodeIdentity: "cli", contentIdentity: cli.identity }],
      },
      conventions,
    });

    assert.strictEqual(
      presetResult.status,
      "success",
      JSON.stringify(presetResult),
    );
    assert.strictEqual(
      referenceResult.status,
      "success",
      JSON.stringify(referenceResult),
    );
    const presetManifest = await readManifest(targets[0], "packages/cli");
    const referenceManifest = await readManifest(targets[1], "packages/cli");
    for (const manifest of [presetManifest, referenceManifest]) {
      assert.strictEqual(manifest.private, true);
      assert.deepStrictEqual(manifest.bin, { cli: "./dist/cli.js" });
      assert.strictEqual(manifest.engines.node, "^26.13.1");
      assert.deepStrictEqual(manifest.devDependencies, {
        "@demo/tooling-config": "link:../tooling-config",
        "@types/node": "catalog:",
        oxfmt: "catalog:",
        oxlint: "catalog:",
        tsrs: "catalog:",
        "typescript-7": "catalog:",
      });
    }
    assert.deepStrictEqual(presetManifest, referenceManifest);
    const generatedTurbo = JSON.parse(
      await readFile(path.join(targets[0], "packages/cli/turbo.json"), "utf8"),
    ) as {
      readonly tasks: { readonly build: { readonly dependsOn: string[] } };
    };
    assert.deepStrictEqual(generatedTurbo.tasks.build.dependsOn, ["^build"]);
    for (const targetRoot of targets) {
      const rootManifest = await readManifest(targetRoot, ".");
      assert.strictEqual(
        rootManifest.devDependencies["@changesets/cli"],
        "catalog:",
      );
      assert.match(
        rootManifest.scripts["publication:pack"],
        /turbo run build/u,
      );
    }
  });

  void it("links both direct reference and preset CLIs to an existing library only by explicit node identity", async () => {
    for (const usePreset of [false, true]) {
      const targetRoot = await createTargetRoot(
        usePreset ? "template-ts-cli-preset-link-" : "template-ts-cli-link-",
      );
      const generator = createDefaultGenerator({ content });
      const initialized = await generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
        conventions: {
          repositoryName: "demo",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );
      const rootManifest = await readManifest(targetRoot, ".");
      rootManifest.scripts["user:note"] = "node --version";
      await writeFile(
        path.join(targetRoot, "package.json"),
        `${JSON.stringify(rootManifest, null, 2)}\n`,
      );
      const releaseWorkflowPath = path.join(
        targetRoot,
        ".github/workflows/release.yml",
      );
      await writeFile(
        releaseWorkflowPath,
        `${await readFile(releaseWorkflowPath, "utf8")}\n# User-retained release workflow customization\n`,
      );

      const planned = await generator.planAdd({
        repositoryRoot: targetRoot,
        ...(usePreset
          ? { preset: preset.identity }
          : { contentIdentity: cli.identity, nodeIdentity: "cli" }),
        creationInput: { linkTo: { nodeIdentity: "library" } },
      });
      assert.strictEqual(planned.status, "planned", JSON.stringify(planned));
      if (planned.status !== "planned") {
        throw new Error("Explicit CLI library link should be plannable");
      }
      assert.strictEqual(planned.blueprint.packageLinkIntents.length, 1);
      const committed = await generator.commitPlan(planned.plan);
      assert.strictEqual(
        committed.status,
        "success",
        JSON.stringify(committed),
      );

      const manifest = await readManifest(targetRoot, "packages/cli");
      assert.strictEqual(manifest.dependencies["@demo/lib"], "workspace:*");
      assert.strictEqual(
        (await readManifest(targetRoot, ".")).scripts["user:note"],
        "node --version",
      );
      assert.match(
        await readFile(releaseWorkflowPath, "utf8"),
        /# User-retained release workflow customization/u,
      );

      manifest.dependencies["@demo/custom"] = "workspace:*";
      await writeFile(
        path.join(targetRoot, "packages/cli/package.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      const addedAgain = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: {
          leafName: "cli-extra",
          linkTo: { nodeIdentity: "library" },
        },
      });
      assert.strictEqual(
        addedAgain.status,
        "success",
        JSON.stringify(addedAgain),
      );
      const customizedManifest = await readManifest(targetRoot, "packages/cli");
      assert.strictEqual(
        customizedManifest.dependencies["@demo/lib"],
        "workspace:*",
      );
      assert.strictEqual(
        customizedManifest.dependencies["@demo/custom"],
        "workspace:*",
      );
      const blueprint = JSON.parse(
        await readFile(
          path.join(targetRoot, ".template/blueprint.json"),
          "utf8",
        ),
      ) as { readonly packageLinkIntents: readonly unknown[] };
      assert.strictEqual(blueprint.packageLinkIntents.length, 2);
    }
  });

  void it("selects a library with a shared node name by instance ID and preserves the link across subsequent adds", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-instance-link-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        presets: [
          {
            contentIdentity: libraryPreset.identity,
            creationInput: { leafName: "lib-one" },
          },
          {
            contentIdentity: libraryPreset.identity,
            creationInput: { leafName: "lib-two" },
          },
        ],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") {
      throw new Error(
        "Two nodes with the same name should initialize as distinct package instances",
      );
    }
    const selectedLibrary = initialized.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "packages/lib-two",
    );
    assert.ok(selectedLibrary);

    const linked = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      nodeIdentity: "cli",
      creationInput: {
        linkTo: { packageDefinitionId: selectedLibrary.packageDefinitionId },
      },
    });
    assert.strictEqual(linked.status, "success", JSON.stringify(linked));
    if (linked.status !== "success") {
      throw new Error(
        "CLI should link to the specified library by instance ID",
      );
    }
    const cliPackage = linked.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "packages/cli",
    );
    assert.ok(cliPackage);
    assert.deepStrictEqual(linked.blueprint.packageLinkIntents, [
      {
        consumerId: cliPackage.packageDefinitionId,
        providerId: selectedLibrary.packageDefinitionId,
      },
    ]);
    const linkedManifest = await readManifest(targetRoot, "packages/cli");
    assert.strictEqual(
      linkedManifest.dependencies["@demo/lib-two"],
      "workspace:*",
    );
    assert.strictEqual(linkedManifest.dependencies["@demo/lib"], undefined);

    const addedSameName = await generator.add({
      repositoryRoot: targetRoot,
      preset: libraryPreset.identity,
      creationInput: { leafName: "lib-three" },
    });
    assert.strictEqual(
      addedSameName.status,
      "success",
      JSON.stringify(addedSameName),
    );
    if (addedSameName.status !== "success") {
      throw new Error(
        "Subsequent same-named nodes must not alter an existing CLI link",
      );
    }
    assert.deepStrictEqual(
      addedSameName.blueprint.packageLinkIntents,
      linked.blueprint.packageLinkIntents,
    );
    assert.strictEqual(
      (await readManifest(targetRoot, "packages/cli")).dependencies[
        "@demo/lib-two"
      ],
      "workspace:*",
    );
  });

  void it("reads the current provider for preset node default links and rejects broken exports", async () => {
    const presetNodes = (
      preset.definition as unknown as {
        readonly nodes: Readonly<
          Record<string, Readonly<Record<string, unknown>>>
        >;
      }
    ).nodes;
    const linkedPreset = {
      ...preset,
      definition: {
        ...preset.definition,
        nodes: {
          ...presetNodes,
          cli: {
            ...presetNodes.cli!,
            creationInput: {
              add: { linkTo: { nodeIdentity: "library" } },
            },
          },
        },
      },
    } as unknown as typeof preset;
    const linkedContent = content.map((member) =>
      member === preset ? linkedPreset : member,
    );
    const targetRoot = await createTargetRoot(
      "template-ts-cli-preset-default-link-",
    );
    const generator = createDefaultGenerator({ content: linkedContent });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const valid = await generator.planAdd({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });
    assert.strictEqual(valid.status, "planned");
    if (valid.status !== "planned") {
      throw new Error(
        "Preset default link should resolve to the existing library node",
      );
    }
    assert.strictEqual(valid.blueprint.packageLinkIntents.length, 1);
    const manifestPath = path.join(targetRoot, "packages/lib/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      any
    >;
    delete manifest.exports["."].default;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.match(
      result.status === "operation-failure" ? result.error.message : "",
      /Package link provider does not expose an importable package root/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("uses customized command names retained by existing CLIs during uniqueness checks", async () => {
    const targetRoot = await createTargetRoot(
      "template-ts-cli-custom-command-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const existingManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const existingManifest = JSON.parse(
      await readFile(existingManifestPath, "utf8"),
    ) as Record<string, any>;
    existingManifest.bin = { second: "./dist/cli.js" };
    await writeFile(
      existingManifestPath,
      `${JSON.stringify(existingManifest, null, 2)}\n`,
    );
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "second" },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.match(
      result.status === "operation-failure" ? result.error.message : "",
      /Duplicate CLI command name "second"/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("conflicts when existing CLI command facts go stale without restoring an unlinked library manifest", async () => {
    const targetRoot = await createTargetRoot(
      "template-ts-cli-command-read-fact-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const existingCliManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const planned = await generator.planAdd({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "next" },
    });
    assert.strictEqual(planned.status, "planned");
    if (planned.status !== "planned") {
      throw new Error(
        "Add should be plannable when the current command name does not conflict",
      );
    }
    const existingCliManifest = JSON.parse(
      await readFile(existingCliManifestPath, "utf8"),
    ) as Record<string, any>;
    existingCliManifest.bin = { next: "./dist/cli.js" };
    await writeFile(
      existingCliManifestPath,
      `${JSON.stringify(existingCliManifest, null, 2)}\n`,
    );
    const staleCommit = await generator.commitPlan(planned.plan);
    assert.strictEqual(staleCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/next")));

    const libraryRoot = await createTargetRoot(
      "template-ts-cli-unlinked-library-",
    );
    const libraryInitialized = await generator.init({
      targetRoot: libraryRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      libraryInitialized.status,
      "success",
      JSON.stringify(libraryInitialized),
    );
    await rm(path.join(libraryRoot, "packages/lib/package.json"));
    const unlinkedAddition = await generator.add({
      repositoryRoot: libraryRoot,
      preset: preset.identity,
      creationInput: { leafName: "standalone" },
    });
    assert.strictEqual(unlinkedAddition.status, "success");
  });

  void it("rejects unknown node identities and incompatible native providers before writing", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-invalid-link-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const beforeUnknown = await snapshotTree(targetRoot);
    const unknown = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "not-selected" } },
    });
    assert.strictEqual(unknown.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeUnknown);

    const missingId = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        linkTo: { packageDefinitionId: "package-not-restored" },
      },
    });
    assert.strictEqual(missingId.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), beforeUnknown);

    const nativeTarget = await createTargetRoot("template-ts-cli-native-link-");
    const nativeGenerator = createDefaultGenerator({ content });
    const nativeInitialized = await nativeGenerator.init({
      targetRoot: nativeTarget,
      selection: {
        roots: [{ nodeIdentity: "workspace", contentIdentity: root.identity }],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      nativeInitialized.status,
      "success",
      JSON.stringify(nativeInitialized),
    );
    const beforeNative = await snapshotTree(nativeTarget);
    const native = await nativeGenerator.add({
      repositoryRoot: nativeTarget,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "workspace" } },
    });
    assert.strictEqual(native.status, "operation-failure");
    assert.strictEqual(await snapshotTree(nativeTarget), beforeNative);
  });

  void it("invalidates plans on read provider manifest and string export target edits while allowing unrelated edits", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-read-facts-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const providerManifestPath = path.join(
      targetRoot,
      "packages/lib/package.json",
    );
    const providerManifest = JSON.parse(
      await readFile(providerManifestPath, "utf8"),
    ) as Record<string, any>;
    providerManifest.exports["."] = "./src/index.ts";
    await writeFile(
      providerManifestPath,
      `${JSON.stringify(providerManifest, null, 2)}\n`,
    );
    const providerSourcePath = path.join(
      targetRoot,
      "packages/lib/src/index.ts",
    );

    const staleTargetPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(staleTargetPlan.status, "planned");
    if (staleTargetPlan.status !== "planned") {
      throw new Error("Valid explicit CLI link should be plannable");
    }
    const originalSource = await readFile(providerSourcePath, "utf8");
    await writeFile(providerSourcePath, `${originalSource}\n// Local edit\n`);
    const staleTargetCommit = await generator.commitPlan(staleTargetPlan.plan);
    assert.strictEqual(staleTargetCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/cli")));

    const staleManifestPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(staleManifestPlan.status, "planned");
    if (staleManifestPlan.status !== "planned") {
      throw new Error("Current explicit CLI link should be plannable");
    }
    const changedManifest = JSON.parse(
      await readFile(providerManifestPath, "utf8"),
    ) as Record<string, any>;
    changedManifest.description = "user edit";
    await writeFile(
      providerManifestPath,
      `${JSON.stringify(changedManifest, null, 2)}\n`,
    );
    const staleManifestCommit = await generator.commitPlan(
      staleManifestPlan.plan,
    );
    assert.strictEqual(staleManifestCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/cli")));

    const unrelatedPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });
    assert.strictEqual(unrelatedPlan.status, "planned");
    if (unrelatedPlan.status !== "planned") {
      throw new Error("Current explicit CLI link should be plannable");
    }
    await writeFile(path.join(targetRoot, "notes.txt"), "user file\n");
    const unrelatedCommit = await generator.commitPlan(unrelatedPlan.plan);
    assert.strictEqual(
      unrelatedCommit.status,
      "success",
      JSON.stringify(unrelatedCommit),
    );
    assert.strictEqual(
      await readFile(path.join(targetRoot, "notes.txt"), "utf8"),
      "user file\n",
    );

    const linkedConsumerManifestPath = path.join(
      targetRoot,
      "packages/cli/package.json",
    );
    const staleConsumerPlan = await generator.planAdd({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: {
        leafName: "next-cli",
        linkTo: { nodeIdentity: "library" },
      },
    });
    assert.strictEqual(staleConsumerPlan.status, "planned");
    if (staleConsumerPlan.status !== "planned") {
      throw new Error(
        "Existing CLI link should replay cleanly for subsequent adds",
      );
    }
    const customizedConsumer = JSON.parse(
      await readFile(linkedConsumerManifestPath, "utf8"),
    ) as Record<string, any>;
    customizedConsumer.scripts["user:note"] = "node custom";
    await writeFile(
      linkedConsumerManifestPath,
      `${JSON.stringify(customizedConsumer, null, 2)}\n`,
    );
    const staleConsumerCommit = await generator.commitPlan(
      staleConsumerPlan.plan,
    );
    assert.strictEqual(staleConsumerCommit.status, "conflict");
    await assert.rejects(stat(path.join(targetRoot, "packages/next-cli")));
  });

  void it("fails with zero writes when the current provider removes its importable entry", async () => {
    const targetRoot = await createTargetRoot(
      "template-ts-cli-invalid-export-",
    );
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const manifestPath = path.join(targetRoot, "packages/lib/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      any
    >;
    delete manifest.exports["."].default;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: { linkTo: { nodeIdentity: "library" } },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("preserves user file contents and permissions when a new CLI target directory conflicts", async () => {
    const targetRoot = await createTargetRoot("template-ts-cli-path-conflict-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: libraryPreset.identity }] },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const occupiedDirectory = path.join(targetRoot, "packages/occupied-cli");
    await mkdir(occupiedDirectory, { recursive: true });
    const userManifest = path.join(occupiedDirectory, "package.json");
    await writeFile(userManifest, '{"name":"user-package"}\n');
    await chmod(userManifest, 0o640);
    const before = await snapshotTree(targetRoot);

    const result = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: cli.identity,
      creationInput: {
        leafName: "occupied-cli",
        packagePath: "packages/occupied-cli",
        linkTo: { nodeIdentity: "library" },
      },
    });

    assert.strictEqual(result.status, "conflict");
    assert.strictEqual(await snapshotTree(targetRoot), before);
  });

  void it("requires binary command names to be unique across the workspace", async () => {
    const duplicateDefinition = defineReferencePackage({
      manifest: {
        name: "@fixture/duplicate-command",
        private: true,
        type: "module",
        bin: { cli: "./dist/cli.js" },
        exports: {
          "./reference": "./package.json",
          "./template": {
            source: "./template/definition.ts",
            types: "./template-dist/definition.d.ts",
            default: "./template-dist/definition.js",
          },
        },
      },
      resourceRoot: new URL("../", import.meta.url),
      alias: "duplicate-command",
      instance: "independent",
      defaultLeafName: "duplicate-tool",
      role: "shared-library",
      resources: [],
      templateExports: ["./template"],
    });
    const duplicateMember: LoadedContentMember<
      typeof duplicateDefinition,
      "reference"
    > = {
      identity: {
        namespace: "fixture",
        packageName: "@fixture/duplicate-command",
        exportPath: "./template",
      },
      kind: "reference",
      alias: duplicateDefinition.alias,
      definition: duplicateDefinition,
      source: {
        specifier: "@fixture/duplicate-command/template",
        moduleURL: import.meta.url,
        manifestURL: import.meta.url,
      },
    };
    const targetRoot = await createTargetRoot(
      "template-ts-cli-duplicate-command-",
    );
    await mkdir(targetRoot);
    const before = await snapshotTree(targetRoot);
    const result = await createDefaultGenerator({
      content: [...content, duplicateMember],
    }).init({
      targetRoot,
      selection: {
        roots: [
          { nodeIdentity: "cli", contentIdentity: cli.identity },
          { nodeIdentity: "tool", contentIdentity: duplicateMember.identity },
        ],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });

    assert.strictEqual(result.status, "operation-failure");
    assert.match(
      result.status === "operation-failure" ? result.error.message : "",
      /Duplicate CLI command name "cli" between @demo\/cli and @demo\/duplicate-tool/u,
    );
    assert.strictEqual(await snapshotTree(targetRoot), before);

    const sharedLibraryRoot = await createTargetRoot(
      "template-ts-cli-shared-command-",
    );
    await mkdir(sharedLibraryRoot);
    const sharedContent = [...content, duplicateMember];
    const sharedGenerator = createDefaultGenerator({ content: sharedContent });
    const sharedInitialized = await sharedGenerator.init({
      targetRoot: sharedLibraryRoot,
      selection: {
        roots: [
          { nodeIdentity: "workspace", contentIdentity: root.identity },
          { nodeIdentity: "tool", contentIdentity: duplicateMember.identity },
        ],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      sharedInitialized.status,
      "success",
      JSON.stringify(sharedInitialized),
    );
    const sharedManifestPath = path.join(
      sharedLibraryRoot,
      "packages/duplicate-tool/package.json",
    );
    const sharedManifest = JSON.parse(
      await readFile(sharedManifestPath, "utf8"),
    ) as Record<string, any>;
    sharedManifest.bin = { second: "./dist/cli.js" };
    await writeFile(
      sharedManifestPath,
      `${JSON.stringify(sharedManifest, null, 2)}\n`,
    );
    const sharedBefore = await snapshotTree(sharedLibraryRoot);

    const sharedDuplicate = await sharedGenerator.add({
      repositoryRoot: sharedLibraryRoot,
      contentIdentity: cli.identity,
      nodeIdentity: "cli",
      creationInput: { leafName: "second" },
    });

    assert.strictEqual(sharedDuplicate.status, "operation-failure");
    assert.match(
      sharedDuplicate.status === "operation-failure"
        ? sharedDuplicate.error.message
        : "",
      /Duplicate CLI command name "second"/u,
    );
    assert.strictEqual(await snapshotTree(sharedLibraryRoot), sharedBefore);

    const staleRoot = await createTargetRoot(
      "template-ts-cli-shared-command-stale-",
    );
    await mkdir(staleRoot);
    const staleGenerator = createDefaultGenerator({ content: sharedContent });
    const staleInitialized = await staleGenerator.init({
      targetRoot: staleRoot,
      selection: {
        roots: [
          { nodeIdentity: "workspace", contentIdentity: root.identity },
          { nodeIdentity: "tool", contentIdentity: duplicateMember.identity },
        ],
      },
      conventions: {
        repositoryName: "demo",
        defaultPackageScope: "demo",
      },
    });
    assert.strictEqual(
      staleInitialized.status,
      "success",
      JSON.stringify(staleInitialized),
    );
    const stalePlan = await staleGenerator.planAdd({
      repositoryRoot: staleRoot,
      contentIdentity: cli.identity,
      nodeIdentity: "cli",
      creationInput: { leafName: "release" },
    });
    assert.strictEqual(stalePlan.status, "planned");
    if (stalePlan.status !== "planned") {
      throw new Error("Non-conflicting new command name should be plannable");
    }
    const staleSharedManifest = JSON.parse(
      await readFile(
        path.join(staleRoot, "packages/duplicate-tool/package.json"),
        "utf8",
      ),
    ) as Record<string, any>;
    staleSharedManifest.bin = { release: "./dist/cli.js" };
    await writeFile(
      path.join(staleRoot, "packages/duplicate-tool/package.json"),
      `${JSON.stringify(staleSharedManifest, null, 2)}\n`,
    );
    const staleCommit = await staleGenerator.commitPlan(stalePlan.plan);
    assert.strictEqual(staleCommit.status, "conflict");
    await assert.rejects(stat(path.join(staleRoot, "packages/release")));
  });
});
