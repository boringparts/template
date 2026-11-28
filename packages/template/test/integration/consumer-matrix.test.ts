import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { parse as parseYaml } from "yaml";

import {
  bindTemplateCatalog,
  buildProjectProjection,
  createPackagedSourceContext,
  createWorkspaceSourceContext,
  definePreset,
  planProject,
  ProjectValidationError,
  readPnpmWorkspaceCatalog,
  validateWorkspacePolicy,
  writeProjectProjection,
  writeTemplateSnapshot,
  type PackageContribution,
  type PackageTransformContext,
  type PresetDefinition,
  type SingletonPackage,
  type TemplateCatalog,
  type WorkspacePolicy,
  type WorkspaceRoot,
} from "../../src/index.ts";

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createBaseWorkspaceAssets(
  hostDir: string,
  options: { readonly useCatalogVersions: boolean },
): {
  readonly workspaceRoot: WorkspaceRoot;
  readonly singletons: readonly SingletonPackage[];
} {
  const rootDir = path.join(hostDir, "templates", "root");
  mkdirSync(path.join(rootDir, "resources", "devcontainer"), {
    recursive: true,
  });
  writeJson(path.join(rootDir, "package.json"), {
    name: "custom-root-template",
    private: true,
    scripts: {
      check: "node scripts/task-gates.ts check",
      "check:heavy": "node scripts/task-gates.ts check:heavy",
      "check:full": "node scripts/task-gates.ts check:full",
      fix: "node scripts/task-gates.ts fix",
    },
    devDependencies: {
      "custom-tooling-pkg": "workspace:*",
      turbo: options.useCatalogVersions ? "catalog:" : "^2.11.13",
    },
    devEngines: {
      runtime: { name: "node", version: "24.0.0", onFail: "download" },
    },
    packageManager: "pnpm@12.21.0",
  });
  writeJson(path.join(rootDir, "turbo.json"), {
    extends: ["//"],
    tags: ["library"],
    tasks: {
      build: { dependsOn: ["^build"], tags: [] },
      check: { tags: ["quality:conditional"] },
      "check:heavy": { tags: ["quality:conditional"] },
      "check:full": { tags: ["quality:conditional"] },
      fix: { tags: ["work:repair"] },
      lint: { dependsOn: ["^lint"], tags: ["quality:light"] },
      test: { dependsOn: ["build"], tags: ["quality:heavy"] },
    },
  });
  writeFileSync(
    path.join(rootDir, "resources", "gitignore"),
    "node_modules/\ndist/\n.local/\n",
  );
  writeFileSync(
    path.join(rootDir, "resources", "devcontainer", "base.Dockerfile"),
    "FROM node:24.0.0-bookworm-slim\n",
  );
  writeJson(path.join(rootDir, "resources", "devcontainer", "template.json"), {
    name: "placeholder",
    build: { dockerfile: "Dockerfile" },
    mounts: [],
  });
  writeFileSync(
    path.join(rootDir, "resources", "devcontainer", "gh.Dockerfile"),
    "RUN echo install-gh\n",
  );

  const toolingDir = path.join(hostDir, "templates", "tooling");
  mkdirSync(toolingDir, { recursive: true });
  writeJson(path.join(toolingDir, "package.json"), {
    name: "custom-tooling-pkg",
    private: true,
    exports: { "./base.json": "./base.json" },
  });
  writeJson(path.join(toolingDir, "base.json"), {
    compilerOptions: { strict: true },
  });
  writeFileSync(
    path.join(toolingDir, "oxlint.config.ts"),
    "export default {};\n",
  );

  const workspaceRoot: WorkspaceRoot = {
    sourceDir: "templates/root",
    resources: [
      { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
    ],
    publicationResources: [
      { sourcePath: "resources/gitignore", targetPath: ".changeset/README.md" },
    ],
    devcontainerBase: {
      dockerfileSourcePath: "resources/devcontainer/base.Dockerfile",
      templateSourcePath: "resources/devcontainer/template.json",
    },
    environment: {
      devcontainer: {
        layers: [
          {
            id: "gh",
            dockerfileSourcePath: "resources/devcontainer/gh.Dockerfile",
          },
        ],
      },
      vscode: { extensions: ["oxc.oxc-vscode"] },
      dependabot: {
        updates: [
          { packageEcosystem: "npm", directory: "/", interval: "weekly" },
        ],
      },
    },
  };

  const singletons: readonly SingletonPackage[] = [
    {
      nodeId: "tooling",
      defaultName: "tooling",
      defaultPath: "packages/tooling",
      singleton: true,
      referencePackage: {
        sourceDir: "templates/tooling",
        role: "shared-library",
        publishable: false,
      },
    },
  ];

  return { workspaceRoot, singletons };
}

void describe("Synthetic consumer matrix", () => {
  void it("supports a plain single-package consumer without pnpm-workspace.yaml or Git, omitting empty catalog fields", () => {
    const hostDir = mkdtempSync(path.join(tmpdir(), "template-single-host-"));
    try {
      const { workspaceRoot, singletons } = createBaseWorkspaceAssets(hostDir, {
        useCatalogVersions: false,
      });

      const libDir = path.join(hostDir, "templates", "plain-lib");
      mkdirSync(path.join(libDir, "src"), { recursive: true });
      writeJson(path.join(libDir, "package.json"), {
        name: "plain-lib-template",
        version: "0.0.0",
        private: true,
        exports: {
          ".": "./dist/index.js",
          "./reference": "./package.json",
        },
        dependencies: { yaml: "^2.9.0" },
        devDependencies: { "custom-tooling-pkg": "workspace:*" },
      });
      writeFileSync(
        path.join(libDir, "src", "index.ts"),
        "export const ok = true;\n",
      );

      const presets: readonly PresetDefinition[] = [
        definePreset({
          alias: "plain-lib",
          title: "Plain Library",
          description: "Single-package consumer preset with literal versions",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "lib",
              defaultName: "core",
              defaultPath: "packages/core",
              referencePackage: {
                sourceDir: "templates/plain-lib",
                role: "shared-library",
                publishable: false,
              },
            },
          ],
        }),
      ];

      const workspacePolicy: WorkspacePolicy = validateWorkspacePolicy({
        nodeLinker: "isolated",
        preferSymlinkedExecutables: true,
        shellEmulator: true,
        autoInstallPeers: false,
        injectWorkspacePackages: false,
        dedupeInjectedDeps: false,
        minimumReleaseAge: 1440,
        minimumReleaseAgeStrict: true,
      });

      const catalog: TemplateCatalog = {
        source: createWorkspaceSourceContext(hostDir),
        workspaceRoot,
        singletonPackages: singletons,
        presets,
        workspacePolicy,
      };
      const bound = bindTemplateCatalog(catalog);

      const targetDir = path.join(hostDir, "out-repo");
      const planned = bound.planProject({
        cwd: hostDir,
        dir: "out-repo",
        presetSpecs: ["plain-lib:alpha"],
      });
      assert.equal(planned.ok, true);
      if (!planned.ok) {
        return;
      }

      const projection = bound.buildProjectProjection(planned.blueprint);
      const workspaceEntry = projection.entries.find(
        (entry) => entry.path === "pnpm-workspace.yaml",
      );
      assert.ok(workspaceEntry);
      const workspaceYaml = parseYaml(
        new TextDecoder().decode(workspaceEntry.content),
      ) as Record<string, unknown>;
      assert.equal(Object.hasOwn(workspaceYaml, "catalog"), false);
      assert.equal(Object.hasOwn(workspaceYaml, "catalogs"), false);
      assert.deepStrictEqual(workspaceYaml.packages, ["packages/*"]);

      // Verify rewriteSubpackageManifest no longer strips ./reference
      const alphaPkgEntry = projection.entries.find(
        (entry) => entry.path === "packages/alpha/package.json",
      );
      assert.ok(alphaPkgEntry);
      const alphaPkg = JSON.parse(
        new TextDecoder().decode(alphaPkgEntry.content),
      ) as {
        readonly name: string;
        readonly exports: Record<string, unknown>;
        readonly devDependencies: Record<string, string>;
      };
      assert.equal(alphaPkg.name, "@out-repo/alpha");
      assert.equal(alphaPkg.exports["./reference"], "./package.json");
      assert.equal(
        alphaPkg.devDependencies["@out-repo/tooling"],
        "workspace:*",
      );

      // Materialize to empty dir succeeds, non-empty fails cleanly
      const written = bound.writeProjectProjection(projection);
      assert.deepStrictEqual(written, { ok: true });
      assert.equal(existsSync(path.join(targetDir, "package.json")), true);

      const secondWrite = writeProjectProjection(projection);
      assert.equal(secondWrite.ok, false);
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
    }
  });

  void it("supports a Git-managed monorepo consumer, snapshot export, offline packaged context, pruning, transform bounds, and rootification", () => {
    const hostDir = mkdtempSync(path.join(tmpdir(), "template-mono-host-"));
    const snapshotDir = mkdtempSync(path.join(tmpdir(), "template-snapshot-"));
    const outDir = mkdtempSync(path.join(tmpdir(), "template-mono-out-"));
    try {
      runGit(hostDir, ["init"]);
      runGit(hostDir, ["config", "user.name", "Test"]);
      runGit(hostDir, ["config", "user.email", "test@example.com"]);
      writeFileSync(path.join(hostDir, ".gitignore"), "dist/\n*.dirty\n");

      const { workspaceRoot, singletons } = createBaseWorkspaceAssets(hostDir, {
        useCatalogVersions: true,
      });

      // Host pnpm-workspace.yaml with extra unused entries + host overrides that must be pruned
      writeFileSync(
        path.join(hostDir, "pnpm-workspace.yaml"),
        [
          "packages:",
          "  - packages/*",
          "catalog:",
          "  turbo: ^2.11.13",
          "  yaml: ^2.9.0",
          "  unused-dep: ^9.9.9",
          "  host-exempt: ^0.1.0",
          "catalogs:",
          "  node-24:",
          '    "@types/node": ~24.0.0',
          "  unused-named:",
          "    foo: ^1.0.0",
          "overrides:",
          '  "yaml>sub": "^1.2.3"',
          '  "unused-dep>bar": "^2.0.0"',
          "",
        ].join("\n"),
      );

      // Executable CLI template + library template + transformable native template
      const cliDir = path.join(hostDir, "templates", "cli");
      mkdirSync(path.join(cliDir, "scripts"), { recursive: true });
      mkdirSync(path.join(cliDir, "dist"), { recursive: true });
      writeJson(path.join(cliDir, "package.json"), {
        name: "acme-cli-ref",
        bin: { "acme-ref": "./scripts/run.sh" },
        dependencies: { yaml: "catalog:" },
        devDependencies: {
          "@types/node": "catalog:node-24",
          "custom-tooling-pkg": "workspace:*",
        },
      });
      writeJson(path.join(cliDir, "turbo.json"), {
        extends: ["//"],
        tasks: {
          build: { dependsOn: ["custom-tooling-pkg#build"] },
        },
      });
      const runShPath = path.join(cliDir, "scripts", "run.sh");
      writeFileSync(runShPath, "#!/bin/sh\necho acme-cli-ref\n");
      chmodSync(runShPath, 0o755);
      // Dirty build file that must be excluded by Git source context
      writeFileSync(path.join(cliDir, "dist", "stale.js"), "dirty\n");
      writeFileSync(path.join(cliDir, "temp.dirty"), "dirty\n");

      const libDir = path.join(hostDir, "templates", "lib");
      mkdirSync(path.join(libDir, "src"), { recursive: true });
      writeJson(path.join(libDir, "package.json"), {
        name: "acme-lib-ref",
        exports: { ".": "./src/index.ts" },
      });
      writeFileSync(
        path.join(libDir, "src", "index.ts"),
        "export const v = 1;\n",
      );

      const nativeDir = path.join(hostDir, "templates", "native");
      mkdirSync(path.join(nativeDir, "resources"), { recursive: true });
      writeJson(path.join(nativeDir, "package.json"), {
        name: "acme-native-ref",
      });
      writeFileSync(path.join(nativeDir, "config.txt"), "name=app\n");
      writeFileSync(
        path.join(nativeDir, "resources", "tool.Dockerfile"),
        "RUN echo native-tool\n",
      );

      runGit(hostDir, ["add", "."]);
      runGit(hostDir, ["commit", "-m", "fixture"]);

      const hostCatalog = readPnpmWorkspaceCatalog(
        path.join(hostDir, "pnpm-workspace.yaml"),
      );
      const workspacePolicy = validateWorkspacePolicy({
        ...hostCatalog,
        allowBuilds: { esbuild: true },
        minimumReleaseAge: 1440,
        minimumReleaseAgeStrict: true,
        minimumReleaseAgeExclude: [
          "@types/*",
          "@unused/*",
          "yaml",
          "host-exempt",
        ],
        nodeLinker: "isolated",
        preferSymlinkedExecutables: true,
        shellEmulator: true,
        autoInstallPeers: false,
        injectWorkspacePackages: false,
        dedupeInjectedDeps: false,
        syncInjectedDepsAfterScripts: ["build"],
      });

      const presets: readonly PresetDefinition[] = [
        definePreset({
          alias: "cli",
          title: "CLI",
          description: "CLI preset",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "cli",
              defaultName: "cli",
              defaultPath: "packages/cli",
              referencePackage: {
                sourceDir: "templates/cli",
                role: "cli-tool",
                publishable: false,
              },
            },
          ],
        }),
        definePreset({
          alias: "lib",
          title: "Lib",
          description: "Node library",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "lib",
              defaultName: "lib",
              defaultPath: "packages/lib",
              referencePackage: {
                sourceDir: "templates/lib",
                role: "node-library",
                publishable: false,
              },
            },
          ],
        }),
        definePreset({
          alias: "native",
          title: "Native",
          description: "Native package",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "native",
              defaultName: "worker",
              defaultPath: "crates/worker",
              referencePackage: {
                sourceDir: "templates/native",
                role: "native-package",
                publishable: false,
                environment: {
                  devcontainer: {
                    layers: [
                      {
                        id: "native-tool",
                        dockerfileSourcePath: "resources/tool.Dockerfile",
                      },
                    ],
                  },
                },
                transformFiles: (
                  files: ReadonlyMap<string, PackageContribution>,
                  ctx: PackageTransformContext,
                ) => {
                  const next = new Map(files);
                  const cfg = files.get("config.txt");
                  if (cfg !== undefined) {
                    next.set("config.txt", {
                      ...cfg,
                      content: new TextEncoder().encode(
                        `name=${ctx.instance.leafName}\n`,
                      ),
                    });
                  }
                  return next;
                },
              },
            },
          ],
        }),
      ];

      // Export snapshot and then delete original hostDir completely
      const snapshot = writeTemplateSnapshot(snapshotDir, {
        source: createWorkspaceSourceContext(hostDir),
        workspaceRoot,
        singletonPackages: singletons,
        presets,
        workspacePolicy,
      });
      assert.deepStrictEqual(snapshot.sourceDirs, [
        "templates/cli",
        "templates/lib",
        "templates/native",
        "templates/root",
        "templates/tooling",
      ]);
      assert.equal(existsSync(snapshot.workspacePolicyPath), true);

      rmSync(hostDir, { recursive: true, force: true });

      // Operate purely from packaged source context after hostDir deletion
      const packagedSource = createPackagedSourceContext(snapshotDir);
      const packagedPolicy = packagedSource.readWorkspacePolicy();

      const planned = planProject({
        cwd: outDir,
        dir: "my-app",
        presetSpecs: ["cli:myctl", "lib:helpers", "native:runner"],
        linkSpecs: ["packages/myctl:packages/helpers"],
        source: packagedSource,
        workspaceRoot,
        singletonPackages: singletons,
        presets,
        workspacePolicy: packagedPolicy,
      });
      assert.equal(planned.ok, true);
      if (!planned.ok) {
        return;
      }

      const projection = buildProjectProjection(planned.blueprint, {
        source: packagedSource,
        workspacePolicy: packagedPolicy,
      });
      const paths = projection.entries.map((e) => e.path);

      // Dirty files excluded
      assert.equal(paths.includes("packages/myctl/dist/stale.js"), false);
      assert.equal(paths.includes("packages/myctl/temp.dirty"), false);

      // Single-entry bin renamed, link injected, turbo.json rewritten
      const cliPkg = JSON.parse(
        new TextDecoder().decode(
          projection.entries.find(
            (e) => e.path === "packages/myctl/package.json",
          )!.content,
        ),
      ) as {
        readonly bin: Record<string, string>;
        readonly dependencies: Record<string, string>;
      };
      assert.deepStrictEqual(cliPkg.bin, { myctl: "./scripts/run.sh" });
      assert.equal(cliPkg.dependencies["@my-app/helpers"], "workspace:*");

      const cliTurbo = JSON.parse(
        new TextDecoder().decode(
          projection.entries.find(
            (e) => e.path === "packages/myctl/turbo.json",
          )!.content,
        ),
      ) as {
        readonly tasks: { readonly build: { readonly dependsOn: string[] } };
      };
      assert.deepStrictEqual(cliTurbo.tasks.build.dependsOn, [
        "@my-app/tooling#build",
      ]);

      // Root turbo.json rootified deterministically
      const rootTurbo = JSON.parse(
        new TextDecoder().decode(
          projection.entries.find((e) => e.path === "turbo.json")!.content,
        ),
      ) as {
        readonly globalDependencies: readonly string[];
        readonly tasks: Record<string, { readonly tags?: readonly string[] }>;
        readonly boundaries: { readonly tags: Record<string, unknown> };
      };
      assert.deepStrictEqual(rootTurbo.globalDependencies, [
        "oxfmt.config.ts",
        "oxlint.config.ts",
        "packages/tooling/oxlint.config.ts",
      ]);
      assert.deepStrictEqual(rootTurbo.tasks["//#check"]?.tags, [
        "quality:entry",
      ]);
      assert.equal(Object.hasOwn(rootTurbo.tasks, "//#build"), false);
      assert.deepStrictEqual(
        Object.keys(rootTurbo.boundaries.tags).toSorted(),
        ["app", "library", "native"],
      );

      // Pruned pnpm-workspace.yaml excludes unused-dep, unused-named, host-exempt, @unused/*, and separates top-level keys with blank lines
      const rawGeneratedWorkspace = new TextDecoder().decode(
        projection.entries.find((e) => e.path === "pnpm-workspace.yaml")!
          .content,
      );
      assert.ok(
        rawGeneratedWorkspace.includes(
          "nodeLinker: isolated\n\npreferSymlinkedExecutables: true",
        ),
      );
      assert.ok(rawGeneratedWorkspace.includes("\n\npackages:\n"));
      assert.ok(rawGeneratedWorkspace.includes("\n\ncatalog:\n"));
      assert.ok(rawGeneratedWorkspace.includes("\n\ncatalogs:\n"));
      const generatedWorkspace = parseYaml(rawGeneratedWorkspace) as {
        readonly catalog: Record<string, string>;
        readonly catalogs: Record<string, Record<string, string>>;
        readonly overrides: Record<string, string>;
        readonly minimumReleaseAgeExclude: readonly string[];
      };
      assert.deepStrictEqual(generatedWorkspace.catalog, {
        turbo: "^2.11.13",
        yaml: "^2.9.0",
      });
      assert.deepStrictEqual(generatedWorkspace.catalogs, {
        "node-24": { "@types/node": "~24.0.0" },
      });
      assert.deepStrictEqual(generatedWorkspace.overrides, {
        "yaml>sub": "^1.2.3",
      });
      assert.deepStrictEqual(generatedWorkspace.minimumReleaseAgeExclude, [
        "@types/*",
        "yaml",
      ]);

      // Materialize and verify executable bit + transformed native file + devcontainer layers
      const written = writeProjectProjection(projection);
      assert.deepStrictEqual(written, { ok: true });
      const runShMode = statSync(
        path.join(outDir, "my-app", "packages/myctl/scripts/run.sh"),
      ).mode;
      assert.notEqual(runShMode & 0o111, 0);
      assert.equal(
        readFileSync(
          path.join(outDir, "my-app", "crates/runner/config.txt"),
          "utf8",
        ),
        "name=runner\n",
      );
      const dockerfile = readFileSync(
        path.join(outDir, "my-app", ".devcontainer/Dockerfile"),
        "utf8",
      );
      assert.match(dockerfile, /install-gh/u);
      assert.match(dockerfile, /native-tool/u);

      // Verify transformFiles boundary violation rejects unbacked files
      const badTransformPresets: readonly PresetDefinition[] = [
        definePreset({
          alias: "bad-transform",
          title: "Bad Transform",
          description: "Tries to add unbacked file",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "bad",
              defaultName: "bad",
              defaultPath: "packages/bad",
              referencePackage: {
                sourceDir: "templates/lib",
                role: "shared-library",
                publishable: false,
                transformFiles: (files) => {
                  const next = new Map(files);
                  next.set("injected.txt", {
                    targetPath: "injected.txt",
                    content: new TextEncoder().encode("nope"),
                    executable: false,
                  });
                  return next;
                },
              },
            },
          ],
        }),
      ];
      const badPlan = planProject({
        cwd: outDir,
        dir: "bad-app",
        presetSpecs: ["bad-transform"],
        source: packagedSource,
        workspaceRoot,
        presets: badTransformPresets,
      });
      assert.equal(badPlan.ok, true);
      if (badPlan.ok) {
        assert.throws(
          () =>
            buildProjectProjection(badPlan.blueprint, {
              source: packagedSource,
              workspacePolicy: packagedPolicy,
            }),
          (error: unknown) =>
            error instanceof ProjectValidationError &&
            error.issues.some(
              (issue) => issue.code === "DIRECTORY_OWNERSHIP_VIOLATION",
            ),
        );
      }
    } finally {
      rmSync(hostDir, { recursive: true, force: true });
      rmSync(snapshotDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
