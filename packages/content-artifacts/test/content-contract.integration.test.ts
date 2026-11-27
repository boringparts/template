import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execa } from "execa";

import { unprivilegedProcessOptions } from "../test-support/unprivileged-process.ts";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const nodeTypesRoot = path.dirname(
  fileURLToPath(import.meta.resolve("@types/node/package.json")),
);
const tscExecutable = fileURLToPath(
  new URL("../node_modules/.bin/tsc", import.meta.url),
);
const fixtureRoot = fileURLToPath(
  new URL("../test-support/content-contract/", import.meta.url),
);
const collectionName = "@fixture/content-contract";

async function packWorkspacePackage(
  packageRoot: string,
  destination: string,
): Promise<string> {
  await mkdir(destination, { recursive: true });
  await execa("pnpm", ["pack", "--pack-destination", destination], {
    cwd: packageRoot,
  });
  const archives = (await readdir(destination)).filter((name) =>
    name.endsWith(".tgz"),
  );
  assert.equal(
    archives.length,
    1,
    `Archive directory should contain exactly one tarball: ${destination}`,
  );
  return path.join(destination, archives[0] ?? "");
}

async function installContentArtifactBuilder(
  root: string,
): Promise<typeof import("@boringparts/template-content-artifacts")> {
  const builderRoot = fileURLToPath(new URL("../", import.meta.url));
  const builderInstallRoot = path.join(root, "builder-install");
  const builderArchive = await packWorkspacePackage(
    builderRoot,
    path.join(root, "builder-archive"),
  );
  const coreArchive = await packWorkspacePackage(
    path.join(workspaceRoot, "packages/core"),
    path.join(root, "core-archive"),
  );
  const authoringArchive = await packWorkspacePackage(
    path.join(workspaceRoot, "packages/workspace-authoring"),
    path.join(root, "authoring-archive"),
  );
  await mkdir(builderInstallRoot, { recursive: true });
  await writeFile(
    path.join(builderInstallRoot, "package.json"),
    `${JSON.stringify({ name: "installed-content-artifact-builder", private: true, type: "module", dependencies: { "@boringparts/template-content-artifacts": `file:${builderArchive}` } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(builderInstallRoot, "pnpm-workspace.yaml"),
    [
      "packages:",
      '  - "."',
      "overrides:",
      `  ${JSON.stringify("@boringparts/template-core")}: ${JSON.stringify(`file:${coreArchive}`)}`,
      `  ${JSON.stringify("@boringparts/template-workspace-authoring")}: ${JSON.stringify(`file:${authoringArchive}`)}`,
      "",
    ].join("\n"),
  );
  await execa("pnpm", ["install", "--prefer-offline"], {
    cwd: builderInstallRoot,
  });
  const packageURL = pathToFileURL(
    path.join(builderInstallRoot, "package.json"),
  ).href;
  const installedEntry = createRequire(packageURL).resolve(
    "@boringparts/template-content-artifacts",
  );
  const installedModulesRoot = path.resolve(builderInstallRoot, "node_modules");
  assert.ok(
    installedEntry.startsWith(`${installedModulesRoot}${path.sep}`),
    `Installed builder entry should reside inside consumer node_modules, got ${installedEntry}`,
  );
  return (await import(
    pathToFileURL(installedEntry).href
  )) as typeof import("@boringparts/template-content-artifacts");
}

async function linkPackage(
  nodeModulesRoot: string,
  packageName: string,
  packageRoot: string,
): Promise<void> {
  const linkPath = path.join(nodeModulesRoot, ...packageName.split("/"));
  await mkdir(path.dirname(linkPath), { recursive: true });
  await symlink(packageRoot, linkPath, "dir");
}

async function prepareOwnerPackage(
  fixtureName: "reference" | "preset",
  ownerRoot: string,
  workspaceRoot: string,
  revision?: "v1" | "v2",
): Promise<void> {
  await cp(path.join(fixtureRoot, fixtureName), ownerRoot, { recursive: true });
  if (fixtureName === "reference" && revision === "v2") {
    const manifestPath = path.join(ownerRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      version: string;
    };
    manifest.version = "2.0.0";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(
      path.join(ownerRoot, "template/revision.ts"),
      [
        "export const referenceRevision = {",
        '  extension: "reference-extension-v2",',
        '  prepared: "reference-prepared-v2",',
        '  format: "reference-format-v2",',
        "} as const;",
        "",
      ].join("\n"),
    );
  }
  const nodeModulesRoot = path.join(ownerRoot, "node_modules");
  await mkdir(path.join(nodeModulesRoot, ".bin"), { recursive: true });
  await symlink(tscExecutable, path.join(nodeModulesRoot, ".bin/tsc"), "file");
  await linkPackage(nodeModulesRoot, "@types/node", nodeTypesRoot);
  await linkPackage(
    nodeModulesRoot,
    "@boringparts/template-core",
    path.join(workspaceRoot, "packages/core"),
  );
  await linkPackage(
    nodeModulesRoot,
    "@boringparts/template-workspace-authoring",
    path.join(workspaceRoot, "packages/workspace-authoring"),
  );
}

async function prepareSourceCollection(
  sourceRoot: string,
  providers: readonly {
    readonly name: string;
    readonly namespace: string;
    readonly ownerRoots: ReadonlyMap<string, string>;
  }[],
  workspaceRoot: string,
): Promise<void> {
  const providerRoots = new Map<string, string>();
  for (const provider of providers) {
    const providerRoot = path.join(sourceRoot, "providers", provider.namespace);
    const providerSourceRoot = path.join(providerRoot, "src");
    await mkdir(providerSourceRoot, { recursive: true });
    const dependencies = Object.fromEntries([
      ...[...provider.ownerRoots.keys()].map((name) => [name, "workspace:*"]),
      ["@boringparts/template-core", "workspace:*"],
      ["@boringparts/template-generator", "workspace:*"],
    ]);
    await writeFile(
      path.join(providerRoot, "package.json"),
      `${JSON.stringify(
        {
          name: provider.name,
          version: "1.0.0",
          type: "module",
          exports: {
            ".": {
              source: "./src/index.ts",
              types: "./dist/index.d.ts",
              default: "./dist/index.js",
            },
            "./source": "./src/index.ts",
          },
          dependencies,
        },
        null,
        2,
      )}\n`,
    );
    const members = [...provider.ownerRoots.keys()];
    await writeFile(
      path.join(providerSourceRoot, "index.ts"),
      [
        'import { loadContentSource } from "@boringparts/template-generator/content-source";',
        "",
        "export const templateContent = await loadContentSource({",
        `  namespace: ${JSON.stringify(provider.namespace)},`,
        "  resolve: (specifier) => import.meta.resolve(specifier),",
        "  members: [",
        ...members.map(
          (packageName) =>
            `    { specifier: ${JSON.stringify(`${packageName}/template`)}, load: () => import(${JSON.stringify(`${packageName}/template`)}) },`,
        ),
        "  ] as const,",
        "});",
        "",
      ].join("\n"),
    );
    const providerNodeModulesRoot = path.join(providerRoot, "node_modules");
    for (const [packageName, packageRoot] of provider.ownerRoots) {
      await linkPackage(providerNodeModulesRoot, packageName, packageRoot);
    }
    for (const packageName of [
      "@types/node",
      "@boringparts/template-core",
      "@boringparts/template-generator",
    ]) {
      const packageRoot =
        packageName === "@types/node"
          ? nodeTypesRoot
          : path.join(
              workspaceRoot,
              "packages",
              packageName === "@boringparts/template-core"
                ? "core"
                : "generator",
            );
      await linkPackage(providerNodeModulesRoot, packageName, packageRoot);
    }
    providerRoots.set(provider.name, providerRoot);
  }

  await mkdir(path.join(sourceRoot, "src"), { recursive: true });
  const providerImports = providers.map(
    (provider, index) =>
      `import { templateContent as provider${index} } from ${JSON.stringify(`${provider.name}/source`)};`,
  );
  await writeFile(
    path.join(sourceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: collectionName,
        version: "1.0.0",
        type: "module",
        exports: {
          ".": {
            source: "./src/index.ts",
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
        },
        dependencies: {
          ...Object.fromEntries(
            providers.map((provider) => [provider.name, "workspace:*"]),
          ),
          "@boringparts/template-core": "workspace:*",
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(sourceRoot, "src/index.ts"),
    [
      ...providerImports,
      'export { deriveContentMembers as deriveTemplateMembers } from "@boringparts/template-core/content-identity";',
      "",
      "export const templateContent = Object.freeze([",
      ...providers.map((_, index) => `  ...provider${index},`),
      "]);",
      "export type TemplateContentMember = (typeof templateContent)[number];",
      'export type TemplatePreset = Extract<TemplateContentMember, { readonly kind: "preset" }>;',
      'export type TemplateReferencePackage = Extract<TemplateContentMember, { readonly kind: "reference" }>;',
      'export const templatePresets: readonly TemplatePreset[] = templateContent.filter((member): member is TemplatePreset => member.kind === "preset");',
      'export const templateReferencePackages: readonly TemplateReferencePackage[] = templateContent.filter((member): member is TemplateReferencePackage => member.kind === "reference");',
      "",
    ].join("\n"),
  );
  const nodeModulesRoot = path.join(sourceRoot, "node_modules");
  for (const [packageName, packageRoot] of providerRoots) {
    await linkPackage(nodeModulesRoot, packageName, packageRoot);
  }
  await linkPackage(nodeModulesRoot, "@types/node", nodeTypesRoot);
  await linkPackage(
    nodeModulesRoot,
    "@boringparts/template-core",
    path.join(workspaceRoot, "packages/core"),
  );
}

async function prepareConsumer(
  consumerRoot: string,
  fixtureBytes: Uint8Array,
  options: {
    readonly sourceRoot?: string;
    readonly sdkRoots: ReadonlyMap<string, string>;
    readonly workspaceRoot: string;
    readonly sourceConditions: boolean;
  },
): Promise<void> {
  await mkdir(consumerRoot, { recursive: true });
  if (options.sourceRoot !== undefined) {
    await writeFile(
      path.join(consumerRoot, "package.json"),
      JSON.stringify({
        name: "content-contract-consumer",
        version: "1.0.0",
        private: true,
        type: "module",
      }),
    );
  }
  await writeFile(
    path.join(consumerRoot, "content-public-contract.mts"),
    fixtureBytes,
  );
  await writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          lib: ["ES2023", "DOM"],
          customConditions: options.sourceConditions ? ["source"] : [],
          resolveJsonModule: true,
          allowImportingTsExtensions: true,
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          types: ["node"],
        },
        include: ["content-public-contract.mts"],
      },
      null,
      2,
    )}\n`,
  );
  const nodeModulesRoot = path.join(consumerRoot, "node_modules");
  if (options.sourceRoot !== undefined) {
    await linkPackage(
      nodeModulesRoot,
      "@fixture/content-contract",
      options.sourceRoot,
    );
  }
  for (const [packageName, packageRoot] of options.sdkRoots) {
    await linkPackage(nodeModulesRoot, packageName, packageRoot);
  }
  await linkPackage(nodeModulesRoot, "@types/node", nodeTypesRoot);
}

async function typecheckConsumer(consumerRoot: string): Promise<void> {
  await execa(
    "pnpm",
    [
      "exec",
      "tsc",
      "-p",
      path.join(consumerRoot, "tsconfig.json"),
      "--pretty",
      "false",
    ],
    { cwd: workspaceRoot },
  );
}

async function writeRuntimeDriver(consumerRoot: string): Promise<string> {
  const driverPath = path.join(consumerRoot, "run-content-contract.mjs");
  await writeFile(
    driverPath,
    [
      'import { runContentContractAddition, runContentContractInitialization } from "./content-public-contract.mts";',
      "const [phase, targetRoot] = process.argv.slice(2);",
      'const result = phase === "init" ? await runContentContractInitialization(targetRoot) : await runContentContractAddition(targetRoot);',
      "process.stdout.write(JSON.stringify(result));",
      "",
    ].join("\n"),
  );
  return driverPath;
}

async function runRuntimeDriver(
  driverPath: string,
  consumerRoot: string,
  phase: "init" | "add",
  targetRoot: string,
  options: {
    readonly sourceConditions?: boolean;
    readonly unprivileged?: boolean;
  } = {},
): Promise<unknown> {
  const result = await execa(
    process.execPath,
    [
      "--no-global-search-paths",
      ...(options.sourceConditions ? ["--conditions=source"] : []),
      driverPath,
      phase,
      targetRoot,
    ],
    {
      cwd: consumerRoot,
      ...(options.unprivileged ? unprivilegedProcessOptions : {}),
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    },
  );
  return JSON.parse(result.stdout);
}

void it("same strict TypeScript consumer passes against both source and installed artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "content-contract-"));
  const preparedRoots: string[] = [];
  const ownersRoot = path.join(root, "authors");
  const referenceRoot = path.join(ownersRoot, "reference");
  const referenceV2Root = path.join(ownersRoot, "reference-v2");
  const presetRoot = path.join(ownersRoot, "preset");
  const sourceCollectionRoot = path.join(root, "source-collection");
  const sourceConsumerRoot = path.join(root, "source-consumer");
  const installedConsumerRoot = path.join(root, "installed-consumer");
  const sourceTargetRoot = path.join(root, "source-target");
  const installedTargetRoot = path.join(root, "installed-target");
  const installedConflictTargetRoot = path.join(
    root,
    "installed-conflict-target",
  );
  const installedOldFormatTargetRoot = path.join(
    root,
    "installed-old-format-target",
  );
  try {
    await mkdir(ownersRoot, { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "content-contract-workspace",
        private: true,
        type: "module",
      }),
    );
    await writeFile(
      path.join(root, "pnpm-workspace.yaml"),
      'packages:\n  - "authors/*"\n',
    );
    await writeFile(path.join(root, ".npmrc"), "verifyDepsBeforeRun=false\n");
    await Promise.all([
      prepareOwnerPackage("reference", referenceRoot, workspaceRoot),
      prepareOwnerPackage("reference", referenceV2Root, workspaceRoot, "v2"),
      prepareOwnerPackage("preset", presetRoot, workspaceRoot),
    ]);
    await linkPackage(
      path.join(presetRoot, "node_modules"),
      "@fixture/content-contract-reference",
      referenceRoot,
    );
    for (const ownerRoot of [referenceRoot, referenceV2Root, presetRoot]) {
      await execa("pnpm", ["--dir", ownerRoot, "run", "build:template"], {
        cwd: workspaceRoot,
      });
    }

    const alphaOwnerRoots = new Map([
      ["@fixture/content-contract-reference", referenceRoot],
      ["@fixture/content-contract-preset", presetRoot],
    ]);
    const betaOwnerRoots = new Map([
      ["@fixture/content-contract-reference", referenceV2Root],
    ]);
    await prepareSourceCollection(
      sourceCollectionRoot,
      [
        {
          name: "@fixture/content-contract-alpha",
          namespace: "alpha",
          ownerRoots: alphaOwnerRoots,
        },
        {
          name: "@fixture/content-contract-beta",
          namespace: "beta",
          ownerRoots: betaOwnerRoots,
        },
      ],
      workspaceRoot,
    );
    const fixtureBytes = await readFile(
      path.join(fixtureRoot, "content-public-contract.mts"),
    );
    const sourceSdkRoots = new Map([
      ["@boringparts/template-core", path.join(workspaceRoot, "packages/core")],
      [
        "@boringparts/template-generator",
        path.join(workspaceRoot, "packages/generator"),
      ],
    ]);
    await prepareConsumer(sourceConsumerRoot, fixtureBytes, {
      sourceRoot: sourceCollectionRoot,
      sdkRoots: sourceSdkRoots,
      workspaceRoot,
      sourceConditions: true,
    });
    const copiedSourceBytes = await readFile(
      path.join(sourceConsumerRoot, "content-public-contract.mts"),
    );
    assert.deepEqual(copiedSourceBytes, fixtureBytes);
    await typecheckConsumer(sourceConsumerRoot);

    const sourceDriverPath = await writeRuntimeDriver(sourceConsumerRoot);
    const sourceRun = await runRuntimeDriver(
      sourceDriverPath,
      sourceConsumerRoot,
      "init",
      sourceTargetRoot,
      { sourceConditions: true },
    );
    assert.deepEqual(sourceRun, {
      packagePaths: ["packages/contract-starter"],
      ownerPackageCount: 1,
      plannedOwnerCount: 1,
      preparedResources: [
        {
          path: "resources/README.md",
          content: "Resource bytes owned by the neutral reference package.\n",
        },
        {
          path: "resources/latent.txt",
          content:
            "Complete resource declared by the reference package and not directly read by the current evaluation.\n",
        },
      ],
      references: [
        {
          namespace: "alpha",
          packageName: "@fixture/content-contract-reference",
          revision: "reference-extension-v1",
        },
        {
          namespace: "beta",
          packageName: "@fixture/content-contract-reference",
          revision: "reference-extension-v2",
        },
      ],
    });

    const sourceCollection = await import(
      pathToFileURL(path.join(sourceCollectionRoot, "src/index.ts")).href
    );
    const preset = sourceCollection.templatePresets[0];
    assert.ok(preset);
    const betaReference = sourceCollection.templateReferencePackages.find(
      (member: { readonly identity: { readonly namespace: string } }) =>
        member.identity.namespace === "beta",
    );
    assert.ok(betaReference);
    assert.equal(
      betaReference.identity.packageName,
      "@fixture/content-contract-reference",
    );
    assert.equal(
      betaReference.definition.authorExtension.marker,
      "reference-extension-v2",
    );
    const installedBuilder = await installContentArtifactBuilder(root);
    const prepared = await installedBuilder.prepareContentCollection({
      content: sourceCollection.templateContent,
      roots: [preset, betaReference],
      workspaceRoot,
      packageName: collectionName,
      collectionVersion: "1.0.0",
      root: path.join(root, "prepared-artifacts"),
    });
    preparedRoots.push(prepared.root);
    assert.deepEqual(
      prepared.owners
        .filter(({ member }) => member.kind === "reference")
        .map(({ member, artifact }) => ({
          namespace: member.identity.namespace,
          packageName: member.identity.packageName,
          version: artifact.coordinate.version,
        })),
      [
        {
          namespace: "alpha",
          packageName: "@fixture/content-contract-reference",
          version: "1.0.0",
        },
        {
          namespace: "beta",
          packageName: "@fixture/content-contract-reference",
          version: "2.0.0",
        },
      ],
    );
    const referenceArchives = prepared.owners.filter(
      ({ member }) => member.kind === "reference",
    );
    assert.equal(referenceArchives.length, 2);
    const alphaReferenceArchive = referenceArchives.find(
      ({ member }) => member.identity.namespace === "alpha",
    );
    assert.ok(alphaReferenceArchive);
    const alphaDependencyPurposes = new Map(
      alphaReferenceArchive.artifact.dependencies.map(({ name, purposes }) => [
        name,
        purposes,
      ]),
    );
    assert.deepEqual(
      alphaDependencyPurposes.get("@boringparts/template-workspace-authoring"),
      ["template-execution"],
    );
    assert.deepEqual(
      alphaDependencyPurposes.get("never-install-target-application"),
      ["target"],
    );
    const alphaInstalledManifest = JSON.parse(
      await readFile(
        path.join(alphaReferenceArchive.installRoot, "package.json"),
        "utf8",
      ),
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    assert.equal(
      alphaInstalledManifest.dependencies[
        "@boringparts/template-workspace-authoring"
      ],
      "0.0.0",
    );
    assert.equal(
      alphaInstalledManifest.dependencies["never-install-target-application"],
      undefined,
    );
    const sdkPackageNames = prepared.sdkPackages.map(({ name }) => name);
    assert.ok(sdkPackageNames.includes("@boringparts/template-core"));
    assert.ok(sdkPackageNames.includes("@boringparts/template-generator"));
    assert.ok(
      sdkPackageNames.includes("@boringparts/template-workspace-authoring"),
    );
    assert.ok(
      !sdkPackageNames.some(
        (name) =>
          name === "@boringparts/template-workspace" ||
          name.startsWith("@boringparts/reference-") ||
          name.startsWith("@boringparts/preset-") ||
          name === "never-install-target-application",
      ),
    );
    const archiveEvidence = referenceArchives.map(({ member, packed }) => {
      assert.match(packed.sha256, /^[0-9a-f]{64}$/u);
      assert.equal(
        packed.provider?.identity.namespace,
        member.identity.namespace,
      );
      return {
        namespace: member.identity.namespace,
        name: packed.name,
        version: packed.version,
        sha256: packed.sha256,
      };
    });
    assert.deepEqual(
      archiveEvidence.map(({ namespace, name, version }) => ({
        namespace,
        name,
        version,
      })),
      [
        {
          namespace: "alpha",
          name: "@fixture/content-contract-reference",
          version: "1.0.0",
        },
        {
          namespace: "beta",
          name: "@fixture/content-contract-reference",
          version: "2.0.0",
        },
      ],
    );
    assert.notEqual(archiveEvidence[0]?.sha256, archiveEvidence[1]?.sha256);
    assert.equal(prepared.providers.length, 2);
    assert.equal(new Set(prepared.providers.map(({ name }) => name)).size, 2);
    assert.equal(prepared.collection.name, collectionName);
    assert.match(prepared.collection.sha256, /^[0-9a-f]{64}$/u);
    await installedBuilder.installContentCollection(
      prepared,
      installedConsumerRoot,
    );

    const requiredSdkArchives = [
      "@boringparts/template-core",
      "@boringparts/template-generator",
    ].map((packageName) => {
      const archive = prepared.sdkPackages.find(
        (candidate) => candidate.name === packageName,
      );
      assert.ok(archive, `Missing packed SDK archive: ${packageName}`);
      return archive.tarball;
    });
    await execa(
      "pnpm",
      ["--dir", installedConsumerRoot, "add", ...requiredSdkArchives],
      { cwd: installedConsumerRoot },
    );
    const installedFixtureBytes = await readFile(
      path.join(fixtureRoot, "content-public-contract.mts"),
    );
    await prepareConsumer(installedConsumerRoot, installedFixtureBytes, {
      sdkRoots: new Map(),
      workspaceRoot,
      sourceConditions: false,
    });
    assert.deepEqual(installedFixtureBytes, fixtureBytes);
    await typecheckConsumer(installedConsumerRoot);

    const installedDriverPath = await writeRuntimeDriver(installedConsumerRoot);
    await chmod(root, 0o777);
    await chmod(ownersRoot, 0);
    try {
      const runInstalled = (
        phase: "init" | "add",
        targetRoot: string,
      ): Promise<unknown> =>
        runRuntimeDriver(
          installedDriverPath,
          installedConsumerRoot,
          phase,
          targetRoot,
          { unprivileged: true },
        );
      const installedRun = await runInstalled("init", installedTargetRoot);
      assert.deepEqual(installedRun, {
        packagePaths: ["packages/contract-starter"],
        ownerPackageCount: 1,
        plannedOwnerCount: 1,
        preparedResources: [
          {
            path: "resources/README.md",
            content: "Resource bytes owned by the neutral reference package.\n",
          },
          {
            path: "resources/latent.txt",
            content:
              "Complete resource declared by the reference package and not directly read by the current evaluation.\n",
          },
        ],
        references: [
          {
            namespace: "alpha",
            packageName: "@fixture/content-contract-reference",
            revision: "reference-extension-v1",
          },
          {
            namespace: "beta",
            packageName: "@fixture/content-contract-reference",
            revision: "reference-extension-v2",
          },
        ],
      });

      const installedAddition = await runInstalled("add", installedTargetRoot);
      assert.deepEqual(installedAddition, {
        status: "success",
        packagePaths: ["packages/contract-starter", "packages/contract-added"],
        packageCount: 2,
        ownerPackageCount: 2,
        additions: [
          {
            path: "packages/contract-added",
            namespace: "alpha",
            packageName: "@fixture/content-contract-reference",
            creationInput: { projectName: "contract-added" },
          },
        ],
        references: [
          {
            namespace: "alpha",
            packageName: "@fixture/content-contract-reference",
            revision: "reference-extension-v1",
          },
          {
            namespace: "beta",
            packageName: "@fixture/content-contract-reference",
            revision: "reference-extension-v2",
          },
        ],
      });
      const installedRecord = JSON.parse(
        await readFile(
          path.join(installedTargetRoot, ".template/generation.json"),
          "utf8",
        ),
      ) as {
        readonly schemaVersion: number;
        readonly packages: readonly {
          readonly createdBy: string;
          readonly contentIdentity: {
            readonly namespace: string;
            readonly packageName: string;
          };
          readonly creationInput: unknown;
        }[];
      };
      assert.equal(installedRecord.schemaVersion, 6);
      assert.deepEqual(
        installedRecord.packages.map(
          ({ createdBy, contentIdentity, creationInput }) => ({
            createdBy,
            namespace: contentIdentity.namespace,
            packageName: contentIdentity.packageName,
            creationInput,
          }),
        ),
        [
          {
            createdBy: "initialization",
            namespace: "alpha",
            packageName: "@fixture/content-contract-reference",
            creationInput: { projectName: "contract-starter" },
          },
          {
            createdBy: "addition",
            namespace: "alpha",
            packageName: "@fixture/content-contract-reference",
            creationInput: { projectName: "contract-added" },
          },
        ],
      );
      assert.equal(
        await readFile(
          path.join(installedTargetRoot, "packages/contract-added/README.md"),
          "utf8",
        ),
        "Resource bytes owned by the neutral reference package.\n\nneutral\nprovider-v3\ncontract-added\npackages/contract-added",
      );

      await runInstalled("init", installedConflictTargetRoot);
      const conflictingPath = path.join(
        installedConflictTargetRoot,
        "packages/contract-added",
      );
      await mkdir(conflictingPath, { recursive: true });
      await writeFile(path.join(conflictingPath, "keep.txt"), "user file\n");
      const conflictRecordPath = path.join(
        installedConflictTargetRoot,
        ".template/generation.json",
      );
      const conflictRecordBefore = await readFile(conflictRecordPath);
      const conflictRun = await runInstalled(
        "add",
        installedConflictTargetRoot,
      );
      assert.deepEqual(conflictRun, {
        status: "conflict",
        conflictCount: 1,
        actions: [],
      });
      assert.deepEqual(
        await readFile(conflictRecordPath),
        conflictRecordBefore,
      );
      assert.equal(
        await readFile(path.join(conflictingPath, "keep.txt"), "utf8"),
        "user file\n",
      );
      await assert.rejects(readFile(path.join(conflictingPath, "README.md")), {
        code: "ENOENT",
      });

      await runInstalled("init", installedOldFormatTargetRoot);
      const oldFormatRecordPath = path.join(
        installedOldFormatTargetRoot,
        ".template/generation.json",
      );
      const oldRecord = JSON.parse(
        await readFile(oldFormatRecordPath, "utf8"),
      ) as { schemaVersion: number };
      oldRecord.schemaVersion = 5;
      await writeFile(oldFormatRecordPath, JSON.stringify(oldRecord));
      const oldRecordBefore = await readFile(oldFormatRecordPath);
      const oldIndexBefore = await readFile(
        path.join(
          installedOldFormatTargetRoot,
          "packages/contract-starter/README.md",
        ),
      );
      const oldFormatRun = await runInstalled(
        "add",
        installedOldFormatTargetRoot,
      );
      assert.deepEqual(oldFormatRun, {
        status: "operation-failure",
        phase: "metadata",
        error:
          "Unsupported generation record schema 5; only schema6 is supported",
      });
      assert.deepEqual(await readFile(oldFormatRecordPath), oldRecordBefore);
      assert.deepEqual(
        await readFile(
          path.join(
            installedOldFormatTargetRoot,
            "packages/contract-starter/README.md",
          ),
        ),
        oldIndexBefore,
      );
    } finally {
      await chmod(ownersRoot, 0o755);
      await chmod(root, 0o755);
    }
  } finally {
    await chmod(ownersRoot, 0o755).catch(() => undefined);
    await chmod(root, 0o755).catch(() => undefined);
    await Promise.all(
      preparedRoots.map((preparedRoot) =>
        rm(preparedRoot, { recursive: true, force: true }),
      ),
    );
    await rm(root, { recursive: true, force: true });
  }
});
