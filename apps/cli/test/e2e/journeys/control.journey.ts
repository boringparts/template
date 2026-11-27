import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney, CliJourneyResult } from "../journey.ts";

const initExampleArgvs = [
  ["init", "--preset=ts-lib", "--dry-run", "--", "my-app"],
  ["init", "--output=text", "--preset=ts-lib", "--dry-run", "--", "my-app"],
] as const;

const presetsExampleArgvs = [
  ["presets"],
  ["presets", "--output=text"],
] as const;

const addPackageExampleArgvs = [
  [
    "add",
    "package",
    "--preset=ts-lib",
    "--name=shared-utils",
    "--path=packages/shared-utils",
    "--dry-run",
  ],
  [
    "add",
    "package",
    "--output=text",
    "--preset=ts-lib",
    "--name=shared-utils",
    "--path=packages/shared-utils",
    "--dry-run",
  ],
] as const;

const validateBlueprintExampleArgvs = [
  ["blueprint", "validate", "--", ".template/blueprint.json"],
  ["blueprint", "validate", "--output=text", "--", ".template/blueprint.json"],
] as const;

type SummaryDocument = {
  readonly kind: string;
  readonly schemaVersion: string;
  readonly command: string;
  readonly outputs: { readonly default: string };
  readonly examples: readonly { readonly argv: readonly string[] }[];
};

function requireResult(
  resultsByName: ReadonlyMap<string, CliJourneyResult>,
  name: string,
): CliJourneyResult {
  const result = resultsByName.get(name);
  if (result === undefined)
    throw new Error(`Missing journey result for command "${name}".`);
  return result;
}

const journey: CliJourney = {
  name: "control",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const exampleWorkspace = path.join(context.workDir, "example-workspace");
    return [
      { name: "version", args: ["--version"] },
      { name: "top help", args: ["--help"] },
      { name: "init help", args: ["init", "--help"] },
      { name: "add help", args: ["add", "package", "--help"] },
      { name: "unknown command", args: ["unknown", "--output", "text"] },
      { name: "root schema directory", args: ["--schema"] },
      { name: "add schema directory", args: ["add", "--schema"] },
      { name: "blueprint schema directory", args: ["blueprint", "--schema"] },
      { name: "init schema summary", args: ["init", "--schema"] },
      { name: "init input schema", args: ["init", "--schema=input"] },
      {
        name: "init success schema",
        args: ["init", "--schema=success:structured"],
      },
      {
        name: "init failures schema",
        args: ["init", "--schema=failures:structured"],
      },
      {
        name: "init wire schema",
        args: ["init", "--schema=wire:structured"],
      },
      { name: "presets schema summary", args: ["presets", "--schema"] },
      {
        name: "add package schema summary",
        args: ["add", "package", "--schema"],
      },
      {
        name: "blueprint validate schema summary",
        args: ["blueprint", "validate", "--schema"],
      },
      { name: "replay init structured example", args: initExampleArgvs[0] },
      { name: "replay init text example", args: initExampleArgvs[1] },
      {
        name: "replay presets structured example",
        args: presetsExampleArgvs[0],
      },
      { name: "replay presets text example", args: presetsExampleArgvs[1] },
      {
        name: "seed workspace for example replay",
        args: ["init", "example-workspace", "--preset", "ts-lib", "--no-todo"],
      },
      {
        name: "replay add package structured example",
        args: addPackageExampleArgvs[0],
        cwd: exampleWorkspace,
      },
      {
        name: "replay add package text example",
        args: addPackageExampleArgvs[1],
        cwd: exampleWorkspace,
      },
      {
        name: "replay blueprint validate structured example",
        args: validateBlueprintExampleArgvs[0],
        cwd: exampleWorkspace,
      },
      {
        name: "replay blueprint validate text example",
        args: validateBlueprintExampleArgvs[1],
        cwd: exampleWorkspace,
      },
    ];
  },
  async assertions({ context, results }) {
    const resultsByName = new Map(
      results.map((result) => [result.commandName, result]),
    );
    const get = (name: string) => requireResult(resultsByName, name);

    const manifest = JSON.parse(
      await readFile(path.join(context.packageRoot, "package.json"), "utf8"),
    ) as { readonly version: string };
    const versionResult = get("version");
    assert.equal(versionResult.exitCode, 0);
    assert.equal(versionResult.stdout, `template ${manifest.version}\n`);
    assert.equal(versionResult.stderr, "");

    const topHelp = get("top help");
    assert.equal(topHelp.exitCode, 0);
    assert.match(topHelp.stdout, /template/u);
    assert.match(topHelp.stdout, /add/u);
    assert.match(topHelp.stdout, /--schema/u);

    const initHelp = get("init help");
    assert.equal(initHelp.exitCode, 0);
    assert.match(initHelp.stdout, /template init/u);
    assert.match(initHelp.stdout, /--no-todo/u);
    assert.match(initHelp.stdout, /--output <mode>/u);
    assert.match(initHelp.stdout, /Examples/u);

    const addHelp = get("add help");
    assert.equal(addHelp.exitCode, 0);
    assert.match(addHelp.stdout, /template add package/u);
    assert.match(addHelp.stdout, /--link-from/u);
    assert.match(addHelp.stdout, /--output <mode>/u);

    const unknownCommand = get("unknown command");
    assert.equal(unknownCommand.exitCode, 2);
    assert.equal(unknownCommand.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(unknownCommand.stderr), {
      schemaVersion: "3",
      kind: "usageFailure",
      helpArgv: ["template", "--help"],
    });

    const schemaCommandNames = [
      "root schema directory",
      "add schema directory",
      "blueprint schema directory",
      "init schema summary",
      "init input schema",
      "init success schema",
      "init failures schema",
      "init wire schema",
      "presets schema summary",
      "add package schema summary",
      "blueprint validate schema summary",
    ];
    for (const name of schemaCommandNames) {
      const result = get(name);
      assert.equal(result.exitCode, 0, name);
      assert.equal(result.stderr, "", name);
    }

    const rootDirectory = JSON.parse(get("root schema directory").stdout) as {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly command: string;
      readonly children: readonly { readonly name: string }[];
    };
    assert.equal(rootDirectory.kind, "directory");
    assert.equal(rootDirectory.schemaVersion, "6");
    assert.equal(rootDirectory.command, "template");
    assert.deepEqual(
      rootDirectory.children.map((child) => child.name).toSorted(),
      ["add", "blueprint", "init", "presets"],
    );

    assert.partialDeepStrictEqual(
      JSON.parse(get("add schema directory").stdout),
      {
        kind: "directory",
        schemaVersion: "6",
        command: "add",
        children: [{ command: "addPackage", name: "package" }],
      },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(get("blueprint schema directory").stdout),
      {
        kind: "directory",
        schemaVersion: "6",
        command: "blueprint",
        children: [{ command: "validateBlueprint", name: "validate" }],
      },
    );

    const initSummary = JSON.parse(
      get("init schema summary").stdout,
    ) as SummaryDocument;
    assert.partialDeepStrictEqual(initSummary, {
      kind: "summary",
      schemaVersion: "6",
      command: "init",
      outputs: { default: "structured" },
    });
    assert.deepEqual(
      initSummary.examples.map((example) => example.argv),
      initExampleArgvs,
    );

    assert.partialDeepStrictEqual(JSON.parse(get("init input schema").stdout), {
      kind: "input",
      schemaVersion: "6",
      command: "init",
    });
    assert.partialDeepStrictEqual(
      JSON.parse(get("init success schema").stdout),
      {
        kind: "success",
        schemaVersion: "6",
        command: "init",
        mode: "structured",
        success: {
          kind: "data",
          variants: { initialized: { exitCode: 0 }, planned: { exitCode: 0 } },
        },
      },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(get("init failures schema").stdout),
      {
        kind: "failures",
        schemaVersion: "6",
        command: "init",
        mode: "structured",
        failures: {
          invalidRequest: { exitCode: 2 },
          operationFailed: { exitCode: 1 },
        },
      },
    );
    assert.partialDeepStrictEqual(JSON.parse(get("init wire schema").stdout), {
      kind: "wire",
      schemaVersion: "6",
      command: "init",
      mode: "structured",
    });

    const presetsSummary = JSON.parse(
      get("presets schema summary").stdout,
    ) as SummaryDocument;
    assert.partialDeepStrictEqual(presetsSummary, {
      kind: "summary",
      schemaVersion: "6",
      command: "presets",
      outputs: { default: "structured" },
    });
    assert.deepEqual(
      presetsSummary.examples.map((example) => example.argv),
      presetsExampleArgvs,
    );

    const addPackageSummary = JSON.parse(
      get("add package schema summary").stdout,
    ) as SummaryDocument;
    assert.partialDeepStrictEqual(addPackageSummary, {
      kind: "summary",
      schemaVersion: "6",
      command: "addPackage",
      outputs: { default: "structured" },
    });
    assert.deepEqual(
      addPackageSummary.examples.map((example) => example.argv),
      addPackageExampleArgvs,
    );

    const validateBlueprintSummary = JSON.parse(
      get("blueprint validate schema summary").stdout,
    ) as SummaryDocument;
    assert.partialDeepStrictEqual(validateBlueprintSummary, {
      kind: "summary",
      schemaVersion: "6",
      command: "validateBlueprint",
      outputs: { default: "structured" },
    });
    assert.deepEqual(
      validateBlueprintSummary.examples.map((example) => example.argv),
      validateBlueprintExampleArgvs,
    );

    const replayCommandNames = [
      "replay init structured example",
      "replay init text example",
      "replay presets structured example",
      "replay presets text example",
      "seed workspace for example replay",
      "replay add package structured example",
      "replay add package text example",
      "replay blueprint validate structured example",
      "replay blueprint validate text example",
    ];
    for (const name of replayCommandNames) {
      const result = get(name);
      assert.equal(result.exitCode, 0, name);
      assert.equal(result.stderr, "", name);
    }

    assert.partialDeepStrictEqual(
      JSON.parse(get("replay init structured example").stdout),
      {
        schemaVersion: "3",
        command: "init",
        outputMode: "structured",
        kind: "data",
        variant: "planned",
      },
    );
    assert.match(
      get("replay init text example").stdout,
      /Project generation preview: my-app/u,
    );

    assert.partialDeepStrictEqual(
      JSON.parse(get("replay presets structured example").stdout),
      {
        schemaVersion: "3",
        command: "presets",
        outputMode: "structured",
        kind: "data",
        variant: "listed",
      },
    );
    assert.match(
      get("replay presets text example").stdout,
      /^Built-in presets/mu,
    );

    assert.partialDeepStrictEqual(
      JSON.parse(get("replay add package structured example").stdout),
      {
        schemaVersion: "3",
        command: "addPackage",
        outputMode: "structured",
        kind: "data",
        variant: "planned",
      },
    );
    assert.match(
      get("replay add package text example").stdout,
      /^Package addition preview/mu,
    );

    assert.partialDeepStrictEqual(
      JSON.parse(get("replay blueprint validate structured example").stdout),
      {
        schemaVersion: "3",
        command: "validateBlueprint",
        outputMode: "structured",
        kind: "data",
        variant: "valid",
        data: {
          path: path.join(
            context.workDir,
            "example-workspace",
            ".template",
            "blueprint.json",
          ),
        },
      },
    );
    assert.match(
      get("replay blueprint validate text example").stdout,
      /Blueprint is valid\./u,
    );
  },
};

export default journey;
