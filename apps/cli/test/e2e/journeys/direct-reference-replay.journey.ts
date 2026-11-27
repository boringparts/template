import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  templateContent,
  templatePresets,
} from "@boringparts/template-content";

import type { CliJourney } from "../journey.ts";
import { summarizeNativeArtifacts } from "../native-artifact-summary.ts";
import { requireReferencePresetName } from "../reference-preset.ts";

const cliPresetName = requireReferencePresetName(
  "@boringparts/reference-ts-cli",
);
const vuePresetName = requireReferencePresetName(
  "@boringparts/reference-vue-app",
);
const vuePresetDefinition = templatePresets.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-vue-app",
);
if (vuePresetDefinition?.kind !== "preset") {
  throw new Error(
    "The content collection is missing the Vue application preset",
  );
}

type GenerationRecord = {
  readonly schemaVersion: 6;
  readonly composition: {
    readonly identity: {
      readonly namespace: string;
      readonly packageName: string;
      readonly exportPath: string;
    };
    readonly conventions: {
      readonly defaultPackageScope: string;
      readonly repositoryName: string;
      readonly todo?: boolean;
    };
  };
  readonly packages: readonly {
    readonly contentIdentity: {
      readonly namespace: string;
      readonly packageName: string;
      readonly exportPath: string;
    };
    readonly createdBy: string;
    readonly packageDefinitionId: string;
    readonly dependencyBindings: Readonly<Record<string, string>>;
  }[];
  readonly selections: readonly {
    readonly selectionId: string;
    readonly presetIdentity: {
      readonly namespace: string;
      readonly packageName: string;
      readonly exportPath: string;
    } | null;
    readonly nodes: Readonly<Record<string, string>>;
  }[];
};

type Blueprint = {
  readonly schemaVersion: number;
  readonly packages: readonly {
    readonly packageDefinitionId: string;
    readonly name: string;
    readonly path: string;
  }[];
};

async function readGenerationRecord(
  project: string,
): Promise<GenerationRecord> {
  return JSON.parse(
    await readFile(path.join(project, ".template/generation.json"), "utf8"),
  ) as GenerationRecord;
}

async function readBlueprint(project: string): Promise<Blueprint> {
  return JSON.parse(
    await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
  ) as Blueprint;
}

function packageRecord(
  record: GenerationRecord,
  packageName: string,
): GenerationRecord["packages"][number] {
  const match = record.packages.find(
    (candidate) => candidate.contentIdentity.packageName === packageName,
  );
  assert.notEqual(
    match,
    undefined,
    `Generation record is missing content ${packageName}`,
  );
  return match!;
}

function presetSelected(
  record: GenerationRecord,
  packageName: string,
): boolean {
  return record.selections.some(
    (selection) => selection.presetIdentity?.packageName === packageName,
  );
}

function selectedPackageId(
  record: GenerationRecord,
  nodeIdentity: string,
): string | undefined {
  return record.selections.find((selection) =>
    Object.hasOwn(selection.nodes, nodeIdentity),
  )?.nodes[nodeIdentity];
}

const journey: CliJourney = {
  name: "direct-reference-replay",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "direct-references");
    const initialRecordPath = path.join(
      context.workDir,
      "generation-before-add.json",
    );
    const initialBlueprintPath = path.join(
      context.workDir,
      "blueprint-before-add.json",
    );
    const customizedSourcePath = path.join(
      context.workDir,
      "customized-library.ts",
    );
    const customizedRootPath = path.join(
      context.workDir,
      "customized-root.json",
    );
    return [
      {
        name: "initialize reference composition directly through the public generator process",
        executable: process.execPath,
        cwd: context.packageRoot,
        args: [
          ...(context.mode === "source" ? ["--conditions=source"] : []),
          path.join(
            context.packageRoot,
            "test/e2e/journeys/direct-reference-init.ts",
          ),
          project,
          context.mode,
          ...(context.mode === "packed"
            ? [
                process.env.TEMPLATE_CLI_PACKED_BIN ??
                  (() => {
                    throw new Error(
                      "Packed direct reference initialization is missing the CLI binary entry point",
                    );
                  })(),
              ]
            : []),
        ],
      },
      {
        name: "add TypeScript CLI preset to direct-reference repository via CLI",
        cwd: project,
        async prepare() {
          const record = await readGenerationRecord(project);
          const blueprint = await readBlueprint(project);
          await writeFile(initialRecordPath, JSON.stringify(record));
          await writeFile(initialBlueprintPath, JSON.stringify(blueprint));
          const library = packageRecord(
            record,
            "@boringparts/reference-ts-lib",
          );
          const definition = blueprint.packages.find(
            (candidate) =>
              candidate.packageDefinitionId === library.packageDefinitionId,
          );
          assert.notEqual(definition, undefined);
          const sourcePath = path.join(
            project,
            definition!.path,
            "src/index.ts",
          );
          const customizedSource = `${await readFile(sourcePath, "utf8")}\n// User-retained source customization\n`;
          await writeFile(sourcePath, customizedSource);
          await writeFile(customizedSourcePath, customizedSource);

          const rootManifestPath = path.join(project, "package.json");
          const rootManifest = JSON.parse(
            await readFile(rootManifestPath, "utf8"),
          ) as {
            scripts?: Record<string, string>;
          };
          rootManifest.scripts = {
            ...rootManifest.scripts,
            "user:note": "node --version",
          };
          const customizedRoot = `${JSON.stringify(rootManifest, null, 2)}\n`;
          await writeFile(rootManifestPath, customizedRoot);
          await writeFile(customizedRootPath, customizedRoot);
        },
        args: [
          "add",
          "package",
          "--preset",
          cliPresetName,
          "--name",
          "cli",
          "--path",
          "packages/cli",
        ],
      },
      {
        name: "replay direct reference and CLI bindings in a new CLI process when adding Vue app",
        cwd: project,
        async prepare() {
          const rootManifest = JSON.parse(
            await readFile(path.join(project, "package.json"), "utf8"),
          ) as { readonly scripts?: Readonly<Record<string, string>> };
          const customizedRoot = JSON.parse(
            await readFile(customizedRootPath, "utf8"),
          ) as { readonly scripts?: Readonly<Record<string, string>> };
          assert.equal(
            rootManifest.scripts?.["user:note"],
            customizedRoot.scripts?.["user:note"],
          );
          assert.equal(
            await readFile(await librarySourcePath(project), "utf8"),
            await readFile(customizedSourcePath, "utf8"),
          );
        },
        args: [
          "add",
          "package",
          "--preset",
          vuePresetName,
          "--name",
          "web",
          "--path",
          "apps/web",
        ],
      },
    ];
  },
  async assertions({ context, results }) {
    assert.equal(results[0]?.exitCode, 0, results[0]?.stderr ?? "");
    assert.equal(results[1]?.exitCode, 0, results[1]?.stderr ?? "");
    assert.equal(JSON.parse(results[1]?.stdout ?? "").variant, "added");
    assert.equal(results[2]?.exitCode, 0, results[2]?.stderr ?? "");
    assert.equal(JSON.parse(results[2]?.stdout ?? "").variant, "added");

    const project = path.join(context.workDir, "direct-references");
    const directInit = JSON.parse(results[0]?.stdout ?? "{}") as {
      readonly mode: string;
      readonly modules: Readonly<Record<string, string>>;
      readonly preparedArtifacts: readonly {
        readonly identity: {
          readonly namespace: string;
          readonly packageName: string;
          readonly exportPath: string;
        };
        readonly compiledCount: number;
        readonly resourceCount: number;
        readonly byteCount: number;
        readonly sha256: string;
      }[];
    };
    assert.equal(directInit.mode, context.mode);
    assert.deepEqual(
      directInit.preparedArtifacts,
      summarizeNativeArtifacts(templateContent),
    );
    for (const artifact of directInit.preparedArtifacts) {
      assert.ok(artifact.compiledCount > 0);
      assert.ok(artifact.byteCount > 0);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    }
    assert.deepEqual(Object.keys(directInit.modules), [
      "content",
      "defaultGeneration",
    ]);
    if (context.mode === "packed") {
      for (const entry of Object.values(directInit.modules)) {
        assert.ok(entry.includes("node_modules"));
        assert.ok(entry.endsWith(".js"));
        assert.ok(!entry.startsWith(context.packageRoot));
      }
    } else if (context.mode === "distribution") {
      for (const entry of Object.values(directInit.modules)) {
        assert.ok(entry.endsWith(".js"));
      }
    } else {
      for (const entry of Object.values(directInit.modules)) {
        assert.ok(entry.endsWith(".ts"));
      }
    }

    const initialRecord = JSON.parse(
      await readFile(
        path.join(context.workDir, "generation-before-add.json"),
        "utf8",
      ),
    ) as GenerationRecord;
    const finalRecord = await readGenerationRecord(project);
    const initialBlueprint = JSON.parse(
      await readFile(
        path.join(context.workDir, "blueprint-before-add.json"),
        "utf8",
      ),
    ) as Blueprint;
    const finalBlueprint = await readBlueprint(project);
    const library = packageRecord(finalRecord, "@boringparts/reference-ts-lib");
    const configuration = packageRecord(
      finalRecord,
      "@boringparts/reference-tooling-config",
    );
    const initialLibrary = packageRecord(
      initialRecord,
      "@boringparts/reference-ts-lib",
    );
    const initialConfiguration = packageRecord(
      initialRecord,
      "@boringparts/reference-tooling-config",
    );
    const cli = packageRecord(finalRecord, "@boringparts/reference-ts-cli");
    assert.equal(initialRecord.schemaVersion, 6);
    assert.equal(finalRecord.schemaVersion, 6);
    assert.deepEqual(finalRecord.composition, initialRecord.composition);
    assert.deepEqual(finalRecord.composition.conventions, {
      repositoryName: "direct-references",
      defaultPackageScope: "acme",
      todo: false,
    });
    assert.equal(initialRecord.selections.length, 1);
    assert.equal(initialRecord.selections[0]?.presetIdentity, null);
    assert.deepEqual(library, initialLibrary);
    assert.deepEqual(configuration, initialConfiguration);
    assert.equal(
      library.dependencyBindings["tooling-config"],
      configuration.packageDefinitionId,
    );
    assert.equal(cli.createdBy, "addition");
    assert.equal(
      cli.dependencyBindings["tooling-config"],
      configuration.packageDefinitionId,
    );
    assert.ok(presetSelected(finalRecord, "@boringparts/preset-ts-cli"));
    assert.ok(presetSelected(finalRecord, "@boringparts/preset-vue-app"));
    assert.equal(
      selectedPackageId(finalRecord, "library"),
      library.packageDefinitionId,
    );
    assert.equal(
      selectedPackageId(finalRecord, "tooling-configuration"),
      configuration.packageDefinitionId,
    );
    assert.equal(
      initialBlueprint.packages.some(
        (definition) => definition.name === "@acme/cli",
      ),
      false,
    );

    assert.ok(
      !initialBlueprint.packages.some(
        (definition) => definition.path === "packages/cli",
      ),
    );
    assert.ok(
      finalBlueprint.packages.some(
        (definition) =>
          definition.packageDefinitionId === cli.packageDefinitionId &&
          definition.name === "@acme/cli" &&
          definition.path === "packages/cli",
      ),
    );
    const vueApplication = packageRecord(
      finalRecord,
      "@boringparts/reference-vue-app",
    );
    assert.equal(vueApplication.createdBy, "addition");
    assert.ok(
      finalBlueprint.packages.some(
        (definition) =>
          definition.packageDefinitionId === vueApplication.packageDefinitionId,
      ),
      "Adding the Vue preset should record the Vue app content in the blueprint",
    );
    assert.ok(
      finalBlueprint.packages.some(
        (definition) =>
          definition.name === "@acme/web" && definition.path === "apps/web",
      ),
    );
    const rootManifest = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    const customizedRoot = JSON.parse(
      await readFile(
        path.join(context.workDir, "customized-root.json"),
        "utf8",
      ),
    ) as { readonly scripts?: Readonly<Record<string, string>> };
    assert.equal(
      rootManifest.scripts?.["user:note"],
      customizedRoot.scripts?.["user:note"],
    );
    assert.equal(
      await readFile(await librarySourcePath(project), "utf8"),
      await readFile(
        path.join(context.workDir, "customized-library.ts"),
        "utf8",
      ),
    );
  },
};

async function librarySourcePath(project: string): Promise<string> {
  const record = await readGenerationRecord(project);
  const blueprint = await readBlueprint(project);
  const library = packageRecord(record, "@boringparts/reference-ts-lib");
  const definition = blueprint.packages.find(
    (candidate) =>
      candidate.packageDefinitionId === library.packageDefinitionId,
  );
  assert.notEqual(definition, undefined);
  return path.join(project, definition!.path, "src/index.ts");
}

export default journey;
