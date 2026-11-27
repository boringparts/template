import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CliJourney } from "../journey.ts";
import { requireReferencePresetName } from "../reference-preset.ts";

const libraryPresetName = requireReferencePresetName(
  "@boringparts/reference-ts-lib",
);
const cliPresetName = requireReferencePresetName(
  "@boringparts/reference-ts-cli",
);

const consumerPath = "services/domain";
const providerPath = "libraries/utilities";
const internalPath = "libraries/internal";
const cliPath = "packages/commands";
const cliPackageName = "@acme/public-commands";
const customizedPublicationPackScript =
  "turbo run build && changeset pack --out-dir .changeset/packed && node --eval \"console.log('publication pack customization retained')\"";
const customScript = "node --eval \"console.log('user custom command')\"";

type PackageManifest = {
  name: string;
  version: string;
  private: boolean;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  bin?: Record<string, string>;
};

type RootManifest = {
  scripts: Record<string, string>;
  readonly devDependencies?: Readonly<Record<string, string>>;
};

async function readManifest(project: string, packagePath: string) {
  return JSON.parse(
    await readFile(path.join(project, packagePath, "package.json"), "utf8"),
  ) as PackageManifest;
}

async function readRootManifest(project: string) {
  return JSON.parse(
    await readFile(path.join(project, "package.json"), "utf8"),
  ) as RootManifest;
}

const journey: CliJourney = {
  name: "reference-library",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    const sourcePath = path.join(project, consumerPath, "src/index.ts");
    const manifestPath = path.join(project, consumerPath, "package.json");
    const installedRoot = path.join(context.workDir, "installed-consumer");
    const addArgs = [
      "add",
      "package",
      "--preset",
      libraryPresetName,
      "--name",
      "utilities",
      "--path",
      providerPath,
      "--link-from",
      consumerPath,
    ];
    const addInternalArgs = [
      "add",
      "package",
      "--preset",
      libraryPresetName,
      "--name",
      "internal",
      "--path",
      internalPath,
    ];
    const addCliArgs = [
      "add",
      "package",
      "--preset",
      cliPresetName,
      "--name",
      "commands",
      "--path",
      cliPath,
    ];
    return [
      {
        name: "initialize library with custom identity",
        args: [
          "init",
          "project",
          "--preset",
          libraryPresetName,
          "--name",
          "domain",
          "--scope",
          "acme",
          "--path",
          consumerPath,
        ],
      },
      {
        name: "preserve user edits and preview second library",
        cwd: project,
        args: [...addArgs, "--dry-run"],
        async prepare() {
          const manifest = await readManifest(project, consumerPath);
          assert.equal(manifest.name, "@acme/domain");
          assert.equal(manifest.private, true);
          const rootManifest = await readRootManifest(project);
          assert.equal(
            rootManifest.devDependencies?.["@changesets/cli"],
            "catalog:",
          );
          assert.equal(
            rootManifest.scripts["publication:pack"],
            "turbo run build && changeset pack --out-dir .changeset/packed",
          );
          rootManifest.scripts["publication:pack"] =
            customizedPublicationPackScript;
          const releaseWorkflow = path.join(
            project,
            ".github/workflows/release.yml",
          );
          const releaseWorkflowText = await readFile(releaseWorkflow, "utf8");
          await writeFile(
            releaseWorkflow,
            `${releaseWorkflowText}\n# User-retained release workflow customization\n`,
          );
          rootManifest.scripts["user:note"] = "node --version";
          await writeFile(
            path.join(project, "package.json"),
            `${JSON.stringify(rootManifest, null, 2)}\n`,
          );
          manifest.private = false;
          manifest.scripts["user:note"] = customScript;
          manifest.version = "8.7.6";
          const customizedManifest = `${JSON.stringify(manifest, null, 2)}\n`;
          const customizedSource = `${await readFile(sourcePath, "utf8")}\nexport const userMessage = "User-retained business logic";\n`;
          await writeFile(manifestPath, customizedManifest);
          await writeFile(sourcePath, customizedSource);
          await writeFile(
            path.join(context.workDir, "customized-manifest.json"),
            customizedManifest,
          );
          await writeFile(
            path.join(context.workDir, "customized-index.ts"),
            customizedSource,
          );
        },
      },
      {
        name: "add second library and link dependency",
        cwd: project,
        args: addArgs,
        async prepare() {
          await assert.rejects(stat(path.join(project, providerPath)), {
            code: "ENOENT",
          });
          assert.equal(
            await readFile(manifestPath, "utf8"),
            await readFile(
              path.join(context.workDir, "customized-manifest.json"),
              "utf8",
            ),
            "dry-run must not modify user manifest",
          );
          assert.equal(
            await readFile(sourcePath, "utf8"),
            await readFile(
              path.join(context.workDir, "customized-index.ts"),
              "utf8",
            ),
            "dry-run must not modify user source",
          );
        },
      },
      {
        name: "add default private internal library",
        cwd: project,
        args: addInternalArgs,
      },
      {
        name: "add default private CLI package",
        cwd: project,
        args: addCliArgs,
      },
      {
        name: "install generated project dependencies",
        executable: "pnpm",
        cwd: project,
        args: ["install"],
        async prepare() {
          const consumer = await readManifest(project, consumerPath);
          const provider = await readManifest(project, providerPath);
          const internal = await readManifest(project, internalPath);
          const command = await readManifest(project, cliPath);
          assert.equal(consumer.private, false);
          assert.equal(internal.private, true);
          assert.equal(provider.private, true);
          assert.equal(command.private, true);
          const rootManifest = await readRootManifest(project);
          assert.equal(
            rootManifest.scripts["publication:pack"],
            customizedPublicationPackScript,
          );
          assert.match(
            await readFile(
              path.join(project, ".github/workflows/release.yml"),
              "utf8",
            ),
            /# User-retained release workflow customization/u,
          );
          provider.name = "@acme/public-utilities";
          provider.version = "1.4.0";
          provider.private = false;
          command.name = cliPackageName;
          command.version = "2.3.4";
          command.private = false;
          const commandBin = command.bin?.commands;
          assert.ok(
            commandBin,
            "CLI package should declare a command binary entry",
          );
          command.bin = { "public-commands": commandBin };
          delete consumer.dependencies["@acme/utilities"];
          consumer.dependencies[provider.name] = "workspace:*";
          await writeFile(
            path.join(project, consumerPath, "package.json"),
            `${JSON.stringify(consumer, null, 2)}\n`,
          );
          await writeFile(
            path.join(project, providerPath, "package.json"),
            `${JSON.stringify(provider, null, 2)}\n`,
          );
          await writeFile(
            path.join(project, cliPath, "package.json"),
            `${JSON.stringify(command, null, 2)}\n`,
          );
          assert.equal(rootManifest.scripts["user:note"], "node --version");
        },
      },
      {
        name: "build and pack libraries through the official publication entry point",
        executable: "pnpm",
        cwd: project,
        args: ["run", "publication:pack"],
      },
      {
        name: "install packed library archives in isolation",
        executable: "npm",
        cwd: installedRoot,
        args: ["install", "--no-audit", "--no-fund"],
        async prepare() {
          const packedRoot = path.join(project, ".changeset/packed");
          const plan = JSON.parse(
            await readFile(path.join(packedRoot, "publish-plan.json"), "utf8"),
          ) as {
            plan: readonly (readonly {
              name: string;
              tarball: { path: string };
            }[])[];
          };
          const provider = plan.plan
            .flat()
            .find(({ name }) => name === "@acme/public-utilities");
          const command = plan.plan
            .flat()
            .find(({ name }) => name === cliPackageName);
          assert.ok(
            provider,
            "Publish plan should include the provider library",
          );
          assert.ok(command, "Publish plan should include the CLI package");
          assert.equal(
            plan.plan.flat().some(({ name }) => name === "@acme/internal"),
            false,
            "private packages must not enter the publish plan",
          );
          await mkdir(installedRoot);
          await writeFile(
            path.join(installedRoot, "package.json"),
            JSON.stringify({
              private: true,
              type: "module",
              dependencies: {
                [provider.name]: `file:${path.join(packedRoot, provider.tarball.path)}`,
                [command.name]: `file:${path.join(packedRoot, command.tarball.path)}`,
              },
            }),
          );
          await writeFile(
            path.join(installedRoot, "public-types.ts"),
            [
              'import { greet } from "@acme/public-utilities";',
              'const greeting: { message: string } = greet("Ada");',
              "void greeting;",
              "// @ts-expect-error greet requires a string name argument.",
              "greet(42);",
              "",
            ].join("\n"),
          );
          await writeFile(
            path.join(installedRoot, "tsconfig.json"),
            JSON.stringify({
              compilerOptions: {
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                noEmit: true,
              },
              files: ["public-types.ts"],
            }),
          );
        },
      },
      {
        name: "check public types of the isolated installed library (positive and negative)",
        executable: "pnpm",
        cwd: project,
        args: [
          "exec",
          "tsc",
          "--project",
          path.join(installedRoot, "tsconfig.json"),
        ],
      },
      {
        name: "run public exports and input validation of the installed library",
        executable: process.execPath,
        cwd: installedRoot,
        args: [
          "--input-type=module",
          "--eval",
          [
            'import assert from "node:assert/strict";',
            'import { greet } from "@acme/public-utilities";',
            'assert.deepEqual(greet("Ada"), { message: "Hello, Ada" });',
            'assert.throws(() => greet(""));',
          ].join("\n"),
        ],
      },
      {
        name: "run version command of the isolated installed CLI",
        executable: path.join(
          installedRoot,
          "node_modules/.bin/public-commands",
        ),
        cwd: installedRoot,
        args: ["--version"],
      },
      {
        name: "run successful lookup command of the isolated installed CLI",
        executable: path.join(
          installedRoot,
          "node_modules/.bin/public-commands",
        ),
        cwd: installedRoot,
        args: ["lookup", "ada"],
      },
      {
        name: "run not-found lookup command of the isolated installed CLI",
        executable: path.join(
          installedRoot,
          "node_modules/.bin/public-commands",
        ),
        cwd: installedRoot,
        args: ["lookup", "missing"],
      },
      {
        name: "run invalid lookup command of the isolated installed CLI",
        executable: path.join(
          installedRoot,
          "node_modules/.bin/public-commands",
        ),
        cwd: installedRoot,
        args: ["lookup"],
      },
    ];
  },
  async assertions({ context, results }) {
    for (const [index, result] of results.entries()) {
      assert.equal(
        result.exitCode,
        index === 12 ? 1 : index === 13 ? 2 : 0,
        result.commandName,
      );
    }
    const initialized = JSON.parse(results[0]!.stdout);
    assert.equal(initialized.variant, "initialized");
    assert.deepEqual(initialized.data.resolved.packages, [
      { name: "@acme/domain", path: consumerPath },
    ]);
    const preview = JSON.parse(results[1]!.stdout);
    assert.equal(preview.variant, "planned");
    assert.equal(preview.data.dryRun, true);
    assert.ok(
      preview.data.actions.some(
        (action: { path: string }) =>
          action.path === `${providerPath}/package.json`,
      ),
    );

    const project = path.join(context.workDir, "project");
    const consumer = await readManifest(project, consumerPath);
    const provider = await readManifest(project, providerPath);
    const internal = await readManifest(project, internalPath);
    const command = await readManifest(project, cliPath);
    assert.equal(consumer.name, "@acme/domain");
    assert.equal(consumer.version, "8.7.6");
    assert.equal(consumer.private, false);
    assert.equal(provider.name, "@acme/public-utilities");
    assert.equal(provider.private, false);
    assert.equal(internal.private, true);
    assert.equal(command.name, cliPackageName);
    assert.equal(command.version, "2.3.4");
    assert.equal(command.private, false);
    assert.equal(command.bin?.["public-commands"], "./dist/cli.js");
    assert.equal(consumer.dependencies?.[provider.name], "workspace:*");
    assert.equal(consumer.scripts["user:note"], customScript);
    const rootManifest = await readRootManifest(project);
    assert.equal(rootManifest.scripts["user:note"], "node --version");
    assert.equal(
      rootManifest.scripts["publication:pack"],
      customizedPublicationPackScript,
    );
    assert.match(
      await readFile(
        path.join(project, ".github/workflows/release.yml"),
        "utf8",
      ),
      /# User-retained release workflow customization/u,
    );
    assert.equal(
      await readFile(path.join(project, consumerPath, "src/index.ts"), "utf8"),
      await readFile(path.join(context.workDir, "customized-index.ts"), "utf8"),
      "User source should be preserved byte-for-byte after linking dependencies",
    );
    assert.match(
      results[6]!.stdout,
      /publication pack customization retained/u,
    );
    assert.equal(results[10]!.stdout, "public-commands 2.3.4\n");
    assert.deepEqual(JSON.parse(results[11]!.stdout), {
      schemaVersion: "3",
      command: "lookup",
      outputMode: "structured",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });
    assert.partialDeepStrictEqual(JSON.parse(results[12]!.stderr), {
      schemaVersion: "3",
      outputMode: "structured",
      kind: "failure",
      variant: "notFound",
      data: { name: "missing" },
    });
    assert.partialDeepStrictEqual(JSON.parse(results[13]!.stderr), {
      schemaVersion: "3",
      kind: "usageFailure",
    });
  },
};

export default journey;
