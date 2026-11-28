import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  canLinkRoles,
  createWorkspaceSourceContext,
  definePreset,
  planProject,
  summarizePresets,
  type PackageRole,
  type PresetDefinition,
  type WorkspacePolicy,
  type WorkspaceRoot,
} from "../../src/index.ts";

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createSyntheticWorkspace(baseDir: string): {
  readonly workspaceRoot: WorkspaceRoot;
  readonly presets: readonly PresetDefinition[];
  readonly workspacePolicy: WorkspacePolicy;
} {
  writeJson(path.join(baseDir, "root", "package.json"), {
    name: "@acme/root",
    private: true,
    scripts: { check: "node scripts/check.ts" },
    devDependencies: { turbo: "^2.11.13" },
    devEngines: { runtime: { name: "node", version: "24.0.0" } },
    packageManager: "pnpm@12.21.0",
  });
  writeJson(path.join(baseDir, "root", "turbo.json"), {
    tasks: { lint: { tags: ["quality:light"] } },
  });
  mkdirSync(path.join(baseDir, "root", "resources"), { recursive: true });
  writeFileSync(
    path.join(baseDir, "root", "resources", "gitignore"),
    "node_modules/\ndist/\n.local/\n",
  );
  writeFileSync(
    path.join(baseDir, "root", "resources", "layer-a.Dockerfile"),
    "FROM scratch\nRUN echo same\n",
  );

  // Two CLI tools with single-entry bin
  writeJson(path.join(baseDir, "cli-a", "package.json"), {
    name: "@acme/cli-a",
    bin: { "ref-cli": "./dist/cli.js" },
  });
  writeJson(path.join(baseDir, "cli-b", "package.json"), {
    name: "@acme/cli-b",
    bin: { "other-cli": "./dist/cli.js" },
  });

  // Shared library, node library, browser app, runtime service, native package
  writeJson(path.join(baseDir, "shared", "package.json"), {
    name: "@acme/shared-lib",
  });
  writeJson(path.join(baseDir, "node-lib", "package.json"), {
    name: "@acme/node-lib",
  });
  writeJson(path.join(baseDir, "web", "package.json"), {
    name: "@acme/web",
  });
  mkdirSync(path.join(baseDir, "web", "resources"), { recursive: true });
  writeFileSync(
    path.join(baseDir, "web", "resources", "browser.Dockerfile"),
    "RUN echo browser-layer\n",
  );
  writeJson(path.join(baseDir, "api", "package.json"), {
    name: "@acme/api",
  });
  mkdirSync(path.join(baseDir, "api", "resources"), { recursive: true });
  writeFileSync(
    path.join(baseDir, "api", "resources", "browser-dup.Dockerfile"),
    "RUN echo browser-layer\n",
  );
  writeFileSync(
    path.join(baseDir, "api", "resources", "browser-diff.Dockerfile"),
    "RUN echo different-browser-layer\n",
  );
  writeJson(path.join(baseDir, "native", "package.json"), {
    name: "@acme/native",
  });

  const workspaceRoot: WorkspaceRoot = {
    sourceDir: "root",
    resources: [
      { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
    ],
  };

  const presets: readonly PresetDefinition[] = [
    definePreset({
      alias: "stack",
      title: "Full Stack",
      description: "Service + two node libs + native",
      topology: "fixed",
      nodes: [
        {
          nodeId: "api",
          defaultName: "api",
          defaultPath: "apps/api",
          referencePackage: {
            sourceDir: "api",
            role: "runtime-service",
            publishable: false,
            environment: (ctx) => ({
              devcontainer: {
                layers: [
                  {
                    id: "browser",
                    dockerfileSourcePath: "resources/browser-dup.Dockerfile",
                  },
                ],
                buildArgs: {
                  POLICY_LINKER: ctx.workspacePolicy?.nodeLinker ?? "unset",
                },
              },
            }),
          },
        },
        {
          nodeId: "db",
          defaultName: "db",
          defaultPath: "packages/db",
          referencePackage: {
            sourceDir: "node-lib",
            packageName: "@acme/node-lib",
            role: "node-library",
            publishable: false,
          },
        },
        {
          nodeId: "migrations",
          defaultName: "migrations",
          defaultPath: "packages/migrations",
          referencePackage: {
            sourceDir: "node-lib",
            role: "node-library",
            publishable: false,
          },
        },
        {
          nodeId: "deploy",
          defaultName: "deploy",
          defaultPath: "packages/deploy",
          referencePackage: {
            sourceDir: "native",
            role: "native-package",
            publishable: false,
          },
        },
      ],
    }),
    definePreset({
      alias: "cli",
      title: "CLI",
      description: "CLI tool",
      topology: "configurable-primary-package",
      nodes: [
        {
          nodeId: "cli",
          defaultName: "tool",
          defaultPath: "packages/tool",
          referencePackage: {
            sourceDir: "cli-a",
            role: "cli-tool",
            publishable: true,
          },
        },
      ],
    }),
    definePreset({
      alias: "cli-other",
      title: "Other CLI",
      description: "Other CLI tool",
      topology: "configurable-primary-package",
      nodes: [
        {
          nodeId: "cli",
          defaultName: "tool",
          defaultPath: "packages/other-tool",
          referencePackage: {
            sourceDir: "cli-b",
            role: "cli-tool",
            publishable: true,
          },
        },
      ],
    }),
    definePreset({
      alias: "web",
      title: "Web",
      description: "Browser app",
      topology: "configurable-primary-package",
      nodes: [
        {
          nodeId: "web",
          defaultName: "web",
          defaultPath: "apps/web",
          referencePackage: {
            sourceDir: "web",
            role: "browser-app",
            publishable: false,
            environment: {
              devcontainer: {
                layers: [
                  {
                    id: "browser",
                    dockerfileSourcePath: "resources/browser.Dockerfile",
                  },
                ],
              },
            },
          },
        },
      ],
    }),
    definePreset({
      alias: "shared",
      title: "Shared",
      description: "Shared library",
      topology: "configurable-primary-package",
      nodes: [
        {
          nodeId: "shared",
          defaultName: "shared",
          defaultPath: "packages/shared",
          referencePackage: {
            sourceDir: "shared",
            role: "shared-library",
            publishable: false,
          },
        },
      ],
    }),
  ];

  const workspacePolicy: WorkspacePolicy = {
    catalog: {},
    catalogs: {},
    overrides: {},
    allowBuilds: {},
    minimumReleaseAge: 1440,
    minimumReleaseAgeStrict: true,
    minimumReleaseAgeExclude: [],
    nodeLinker: "isolated",
    preferSymlinkedExecutables: true,
    shellEmulator: true,
    autoInstallPeers: false,
    injectWorkspacePackages: false,
    dedupeInjectedDeps: false,
    syncInjectedDepsAfterScripts: [],
  };

  return { workspaceRoot, presets, workspacePolicy };
}

void describe("summarizePresets and planProject primitives", () => {
  void it("deduplicates roles in appearance order in summarizePresets", () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "template-sum-"));
    try {
      const { presets } = createSyntheticWorkspace(baseDir);
      const summaries = summarizePresets(presets);
      const stackSummary = summaries.find((item) => item.name === "stack");
      assert.ok(stackSummary);
      assert.deepStrictEqual(stackSummary.roles, [
        "runtime-service",
        "node-library",
        "native-package",
      ]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  void it("enforces the 6-role link matrix, reserved paths, bin conflicts, packageName mismatches, and environment deduplication/conflicts", () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "template-plan-"));
    try {
      const { workspaceRoot, presets, workspacePolicy } =
        createSyntheticWorkspace(baseDir);
      const source = createWorkspaceSourceContext(baseDir);

      // 6-role matrix checks
      const roles: readonly PackageRole[] = [
        "cli-tool",
        "runtime-service",
        "browser-app",
        "shared-library",
        "node-library",
        "native-package",
      ];
      for (const consumer of roles) {
        assert.equal(canLinkRoles(consumer, "native-package"), false);
        assert.equal(canLinkRoles("native-package", consumer), false);
      }
      assert.equal(canLinkRoles("browser-app", "shared-library"), true);
      assert.equal(canLinkRoles("browser-app", "node-library"), false);
      assert.equal(canLinkRoles("cli-tool", "node-library"), true);
      assert.equal(canLinkRoles("runtime-service", "node-library"), true);
      assert.equal(canLinkRoles("node-library", "node-library"), true);

      // Valid plan with environment layer deduplication across web + api
      const validPlan = planProject({
        cwd: baseDir,
        dir: "my-workspace",
        presetSpecs: ["stack", "web", "shared", "cli:my-cli"],
        linkSpecs: ["apps/web:packages/shared", "apps/api:packages/db"],
        source,
        workspaceRoot,
        presets,
        workspacePolicy,
      });
      assert.equal(validPlan.ok, true);
      if (validPlan.ok) {
        assert.equal(validPlan.blueprint.scope, "my-workspace");
        assert.equal(validPlan.blueprint.links.length, 2);
        const dbInstance = validPlan.blueprint.instances.find(
          (i) => i.nodeId === "db",
        );
        assert.ok(dbInstance);
        assert.equal(
          dbInstance.dependencyBindings.get("@acme/node-lib"),
          "@my-workspace/db",
        );
      }

      // Single-entry bin collision (two CLIs with same leaf name `tool`)
      const binCollision = planProject({
        cwd: baseDir,
        dir: "bin-conflict-ws",
        presetSpecs: ["cli", "cli-other"],
        source,
        workspaceRoot,
        presets,
      });
      assert.equal(binCollision.ok, false);
      if (!binCollision.ok) {
        assert.ok(
          binCollision.issues.some(
            (i) => i.code === "CONFLICTING_PACKAGE_IDENTITY",
          ),
        );
      }

      // Reserved package path (dist/ is in root gitignore) and dot-prefixed hidden dir
      const reservedPath = planProject({
        cwd: baseDir,
        dir: "reserved-ws",
        presetSpecs: ["shared:helper:dist/helper"],
        source,
        workspaceRoot,
        presets,
      });
      assert.equal(reservedPath.ok, false);
      if (!reservedPath.ok) {
        assert.ok(
          reservedPath.issues.some((i) => i.code === "RESERVED_PACKAGE_PATH"),
        );
      }

      // Unsupported link (browser-app -> node-library)
      const badLink = planProject({
        cwd: baseDir,
        dir: "bad-link-ws",
        presetSpecs: ["stack", "web"],
        linkSpecs: ["apps/web:packages/db"],
        source,
        workspaceRoot,
        presets,
      });
      assert.equal(badLink.ok, false);
      if (!badLink.ok) {
        assert.ok(badLink.issues.some((i) => i.code === "UNSUPPORTED_LINK"));
      }

      // Conflicting environment metadata (different Dockerfile content for same layer id)
      const conflictEnvPresets: readonly PresetDefinition[] = [
        ...presets,
        definePreset({
          alias: "conflict-web",
          title: "Conflict Web",
          description: "Conflicting layer",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "conflict-web",
              defaultName: "cweb",
              defaultPath: "apps/cweb",
              referencePackage: {
                sourceDir: "web",
                role: "browser-app",
                publishable: false,
                environment: {
                  devcontainer: {
                    layers: [
                      {
                        id: "browser",
                        dockerfileSourcePath:
                          "../api/resources/browser-diff.Dockerfile",
                      },
                    ],
                  },
                },
              },
            },
          ],
        }),
      ];
      const traversalLayer = planProject({
        cwd: baseDir,
        dir: "traversal-ws",
        presetSpecs: ["conflict-web"],
        source,
        workspaceRoot,
        presets: conflictEnvPresets,
      });
      assert.equal(traversalLayer.ok, false);
      if (!traversalLayer.ok) {
        assert.ok(
          traversalLayer.issues.some(
            (i) => i.code === "DIRECTORY_OWNERSHIP_VIOLATION",
          ),
        );
      }

      // Conflicting layer content within valid relative paths
      const conflictLayerContentPresets: readonly PresetDefinition[] = [
        presets[0]!, // api has id: "browser" with browser-dup.Dockerfile
        definePreset({
          alias: "diff-browser",
          title: "Diff Browser",
          description: "Different browser layer content",
          topology: "configurable-primary-package",
          nodes: [
            {
              nodeId: "diff",
              defaultName: "diff",
              defaultPath: "apps/diff",
              referencePackage: {
                sourceDir: "api",
                role: "browser-app",
                publishable: false,
                environment: {
                  devcontainer: {
                    layers: [
                      {
                        id: "browser",
                        dockerfileSourcePath:
                          "resources/browser-diff.Dockerfile",
                      },
                    ],
                  },
                },
              },
            },
          ],
        }),
      ];
      const layerConflict = planProject({
        cwd: baseDir,
        dir: "layer-conflict-ws",
        presetSpecs: ["stack", "diff-browser"],
        source,
        workspaceRoot,
        presets: conflictLayerContentPresets,
      });
      assert.equal(layerConflict.ok, false);
      if (!layerConflict.ok) {
        assert.ok(
          layerConflict.issues.some(
            (i) => i.code === "CONFLICTING_ENVIRONMENT_METADATA",
          ),
        );
      }

      // Explicit packageName mismatch against package.json name
      const mismatchPreset = definePreset({
        alias: "mismatch",
        title: "Mismatch",
        description: "Name mismatch",
        topology: "configurable-primary-package",
        nodes: [
          {
            nodeId: "m",
            defaultName: "m",
            defaultPath: "packages/m",
            referencePackage: {
              sourceDir: "shared",
              packageName: "@acme/wrong-name",
              role: "shared-library",
              publishable: false,
            },
          },
        ],
      });
      const mismatchPlan = planProject({
        cwd: baseDir,
        dir: "mismatch-ws",
        presetSpecs: ["mismatch"],
        source,
        workspaceRoot,
        presets: [mismatchPreset],
      });
      assert.equal(mismatchPlan.ok, false);
      if (!mismatchPlan.ok) {
        assert.ok(
          mismatchPlan.issues.some(
            (i) => i.code === "CONFLICTING_PACKAGE_IDENTITY",
          ),
        );
      }

      // Fixed topology nodes must also validate defaultPath against reserved & two-segment rules
      const fixedReservedPreset = definePreset({
        alias: "fixed-reserved",
        title: "Fixed Reserved",
        description: "Fixed preset using reserved defaultPath",
        topology: "fixed",
        nodes: [
          {
            nodeId: "app",
            defaultName: "app",
            defaultPath: "dist/app",
            referencePackage: {
              sourceDir: "web",
              role: "browser-app",
              publishable: false,
            },
          },
        ],
      });
      const fixedReservedPlan = planProject({
        cwd: baseDir,
        dir: "fixed-reserved-ws",
        presetSpecs: ["fixed-reserved"],
        source,
        workspaceRoot,
        presets: [fixedReservedPreset],
      });
      assert.equal(fixedReservedPlan.ok, false);
      if (!fixedReservedPlan.ok) {
        assert.ok(
          fixedReservedPlan.issues.some(
            (i) => i.code === "RESERVED_PACKAGE_PATH",
          ),
        );
      }

      const fixedSingleSegmentPreset = definePreset({
        alias: "fixed-single",
        title: "Fixed Single Segment",
        description: "Fixed preset using single-segment defaultPath",
        topology: "fixed",
        nodes: [
          {
            nodeId: "app",
            defaultName: "app",
            defaultPath: "app",
            referencePackage: {
              sourceDir: "web",
              role: "browser-app",
              publishable: false,
            },
          },
        ],
      });
      const fixedSingleSegmentPlan = planProject({
        cwd: baseDir,
        dir: "fixed-single-ws",
        presetSpecs: ["fixed-single"],
        source,
        workspaceRoot,
        presets: [fixedSingleSegmentPreset],
      });
      assert.equal(fixedSingleSegmentPlan.ok, false);
      if (!fixedSingleSegmentPlan.ok) {
        assert.ok(
          fixedSingleSegmentPlan.issues.some(
            (i) => i.code === "INVALID_PACKAGE_PATH",
          ),
        );
      }

      // Configurable preset with underscore leaf name and derived path must fail consistently at planning time
      const derivedUnderscorePathPlan = planProject({
        cwd: baseDir,
        dir: "underscore-derived-ws",
        presetSpecs: ["cli:my_cli"],
        source,
        workspaceRoot,
        presets,
      });
      assert.equal(derivedUnderscorePathPlan.ok, false);
      if (!derivedUnderscorePathPlan.ok) {
        assert.ok(
          derivedUnderscorePathPlan.issues.some(
            (i) => i.code === "INVALID_PACKAGE_PATH",
          ),
        );
      }

      // Underscore/dot-prefixed invalid package leaf names still report INVALID_PACKAGE_NAME
      for (const badSpec of ["shared:_core", "shared:.core"]) {
        const badLeafPlan = planProject({
          cwd: baseDir,
          dir: "bad-leaf-ws",
          presetSpecs: [badSpec],
          source,
          workspaceRoot,
          presets,
        });
        assert.equal(badLeafPlan.ok, false);
        if (!badLeafPlan.ok) {
          assert.ok(
            badLeafPlan.issues.some((i) => i.code === "INVALID_PACKAGE_NAME"),
          );
        }
      }

      // Underscore package leaf name with an explicit safe two-segment path succeeds for planning and linking
      const explicitSafePathPlan = planProject({
        cwd: baseDir,
        dir: "explicit-safe-path-ws",
        presetSpecs: ["cli:my_cli:packages/my-cli", "shared"],
        linkSpecs: ["packages/my-cli:packages/shared"],
        source,
        workspaceRoot,
        presets,
      });
      assert.equal(explicitSafePathPlan.ok, true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
