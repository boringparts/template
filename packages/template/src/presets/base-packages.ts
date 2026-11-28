import { readFileSync } from "node:fs";
import path from "node:path";

import { stringify as stringifyYaml } from "yaml";

import {
  formatJson,
  ProjectValidationError,
  type BasePackageNode,
  type PackageFileContribution,
  type PackageTransformContext,
} from "../core/index.ts";
import {
  mergeWorkspaceEnvironmentMeta,
  type WorkspaceEnvironmentMeta,
} from "./environment-meta.ts";
import { resolvePackageDir } from "./roots.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function synthesizeWorkspaceRootFiles(
  files: ReadonlyMap<string, PackageFileContribution>,
  context: PackageTransformContext<WorkspaceEnvironmentMeta>,
): ReadonlyMap<string, PackageFileContribution> {
  const mergeResult = mergeWorkspaceEnvironmentMeta(context.instances);
  if (!mergeResult.ok) {
    throw new ProjectValidationError(mergeResult.issues);
  }
  const { merged } = mergeResult;

  const nextFiles = new Map(files);
  const rootRefDir = context.instance.definition.packageDir;
  const envDir = path.join(rootRefDir, "resources", "environment");

  const setTextFile = (
    targetPath: string,
    text: string,
    executable = false,
  ): void => {
    nextFiles.set(targetPath, {
      targetPath,
      content: encoder.encode(text),
      executable,
    });
  };

  // 1. Publication workflow, changesets config, root scripts & tasks when any package is publishable.
  if (context.hasPublishable) {
    setTextFile(
      ".changeset/config.json",
      readFileSync(
        path.join(rootRefDir, "resources", "publication", "config.json"),
        "utf8",
      ),
    );
    setTextFile(
      ".github/workflows/release.yml",
      readFileSync(
        path.join(rootRefDir, "resources", "publication", "release.yml"),
        "utf8",
      ),
    );

    const rootPkgEntry = nextFiles.get("package.json");
    if (rootPkgEntry !== undefined) {
      const rootPkg = JSON.parse(
        decoder.decode(rootPkgEntry.content),
      ) as Record<string, unknown>;
      const scripts = isRecord(rootPkg.scripts) ? { ...rootPkg.scripts } : {};
      scripts["publication:pack"] =
        "turbo run build && changeset pack --out-dir .changeset/packed";
      scripts["publication:publish"] =
        "changeset publish --from-pack-dir .changeset/packed";
      rootPkg.scripts = scripts;

      const devDeps = isRecord(rootPkg.devDependencies)
        ? { ...rootPkg.devDependencies }
        : {};
      devDeps["@changesets/cli"] = "catalog:";
      rootPkg.devDependencies = Object.fromEntries(
        Object.entries(devDeps).toSorted(([a], [b]) => a.localeCompare(b)),
      );
      setTextFile(
        "package.json",
        `${JSON.stringify(rootPkg, null, 2)}\n`,
        rootPkgEntry.executable,
      );
    }

    const rootTurboEntry = nextFiles.get("turbo.json");
    if (rootTurboEntry !== undefined) {
      const rootTurbo = JSON.parse(
        decoder.decode(rootTurboEntry.content),
      ) as Record<string, unknown>;
      const tasks = isRecord(rootTurbo.tasks) ? { ...rootTurbo.tasks } : {};
      tasks["//#publication:pack"] = { tags: ["work:release"], cache: false };
      tasks["//#publication:publish"] = {
        tags: ["work:release"],
        cache: false,
      };
      rootTurbo.tasks = tasks;
      setTextFile(
        "turbo.json",
        formatJson(rootTurbo),
        rootTurboEntry.executable,
      );
    }
  }

  // 2. .vscode/extensions.json and .vscode/settings.json
  setTextFile(
    ".vscode/extensions.json",
    formatJson({ recommendations: merged.vscode.extensions }),
  );
  setTextFile(".vscode/settings.json", formatJson(merged.vscode.settings));

  // 3. .devcontainer/Dockerfile and .devcontainer/devcontainer.json
  const dockerfileFragments = [
    readFileSync(path.join(envDir, "base.Dockerfile"), "utf8").trimEnd(),
    ...merged.devcontainer.layers.map((layer) =>
      readFileSync(layer.dockerfilePath, "utf8").trimEnd(),
    ),
  ];
  setTextFile(
    ".devcontainer/Dockerfile",
    `${dockerfileFragments.join("\n\n")}\n`,
  );

  const templateJson = JSON.parse(
    readFileSync(
      path.join(envDir, "devcontainer", "workspace-template.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  const buildConfig: Record<string, unknown> = isRecord(templateJson.build)
    ? { ...templateJson.build }
    : { dockerfile: "Dockerfile" };
  if (Object.keys(merged.devcontainer.buildArgs).length > 0) {
    buildConfig.args = merged.devcontainer.buildArgs;
  } else {
    delete buildConfig.args;
  }

  const baseContainerEnv = isRecord(templateJson.containerEnv)
    ? { ...templateJson.containerEnv }
    : {};
  const mergedContainerEnv: Record<string, unknown> = {
    ...baseContainerEnv,
    ...merged.devcontainer.containerEnv,
  };

  const devcontainerObj: Record<string, unknown> = {
    ...templateJson,
    name: context.repositoryName,
    build: buildConfig,
    customizations: {
      vscode: {
        extensions: merged.vscode.extensions,
      },
    },
    ...(Object.keys(mergedContainerEnv).length > 0
      ? { containerEnv: mergedContainerEnv }
      : {}),
    mounts: merged.devcontainer.mounts,
  };
  setTextFile(".devcontainer/devcontainer.json", formatJson(devcontainerObj));

  // 4. .github/dependabot.yml
  const hasNpmGroups = Object.keys(merged.dependabot.npmGroups).length > 0;
  const dependabotUpdates = merged.dependabot.updates.map((update) => {
    const isRootNpm =
      update.packageEcosystem === "npm" && update.directory === "/";
    return {
      "package-ecosystem": update.packageEcosystem,
      directory: update.directory,
      schedule: { interval: update.interval ?? "weekly" },
      ...(isRootNpm && hasNpmGroups
        ? { groups: merged.dependabot.npmGroups }
        : {}),
      ...(update.ignore !== undefined && update.ignore.length > 0
        ? {
            ignore: update.ignore.map((rule) => ({
              "dependency-name": rule.dependencyName,
              ...(rule.updateTypes !== undefined
                ? { "update-types": [...rule.updateTypes] }
                : {}),
            })),
          }
        : {}),
    };
  });
  setTextFile(
    ".github/dependabot.yml",
    stringifyYaml({ version: 2, updates: dependabotUpdates }),
  );

  return nextFiles;
}

/**
 * Builds the homogeneous base singleton packages (`workspace-root` at `.` and
 * `tooling-config` at `packages/tooling-config`).
 */
export function createBasePackages(
  templatesRoot?: string,
): readonly BasePackageNode<WorkspaceEnvironmentMeta>[] {
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  const toolingConfigDir = resolvePackageDir(
    "@boringparts/reference-tooling-config",
    import.meta.url,
    templatesRoot,
  );

  return [
    {
      nodeId: "workspace-root",
      leafName: "workspace-root",
      path: ".",
      definition: {
        packageName: "@boringparts/reference-workspace-root",
        packageDir: workspaceRootRefDir,
        role: "shared-library",
        publishable: false,
        resources: [
          { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
          {
            sourcePath: "resources/agent-instructions.md",
            targetPath: "AGENTS.md",
          },
          {
            sourcePath: "resources/github/check.yml",
            targetPath: ".github/workflows/check.yml",
          },
        ],
        meta: {
          devcontainer: {
            layers: [
              {
                id: "github-cli",
                dockerfilePath: path.join(
                  workspaceRootRefDir,
                  "resources",
                  "environment",
                  "devcontainer",
                  "github-cli.Dockerfile",
                ),
              },
            ],
            mounts: [
              {
                type: "volume",
                source: "${devcontainerId}-pnpm-store",
                target: "/pnpm/store",
              },
            ],
          },
          vscode: {
            extensions: ["oxc.oxc-vscode"],
            settings: {
              "editor.codeActionsOnSave": {
                "source.format.oxc": "always",
                "source.fixAll.oxc": "always",
              },
              "editor.defaultFormatter": "oxc.oxc-vscode",
              "editor.formatOnPaste": true,
              "editor.formatOnSave": true,
              "editor.formatOnSaveMode": "file",
              "oxc.configPath": "./oxlint.config.ts",
              "oxc.enable": true,
              "oxc.fmt.configPath": "./oxfmt.config.ts",
            },
          },
          dependabot: {
            updates: [
              {
                packageEcosystem: "devcontainers",
                directory: "/",
                interval: "weekly",
              },
              {
                packageEcosystem: "npm",
                directory: "/",
                interval: "weekly",
                ignore: [
                  {
                    dependencyName: "@types/node",
                    updateTypes: ["version-update:semver-major"],
                  },
                  {
                    dependencyName: "pnpm",
                    updateTypes: [
                      "version-update:semver-major",
                      "version-update:semver-minor",
                      "version-update:semver-patch",
                    ],
                  },
                ],
              },
              {
                packageEcosystem: "github-actions",
                directory: "/",
                interval: "weekly",
              },
              {
                packageEcosystem: "docker",
                directory: "/.devcontainer",
                interval: "weekly",
              },
            ],
          },
        },
        validateWorkspace: (instances) => {
          const result = mergeWorkspaceEnvironmentMeta(instances);
          return result.ok ? [] : result.issues;
        },
        transformFiles: synthesizeWorkspaceRootFiles,
      },
    },
    {
      nodeId: "tooling-config",
      leafName: "tooling-config",
      path: "packages/tooling-config",
      definition: {
        packageName: "@boringparts/reference-tooling-config",
        packageDir: toolingConfigDir,
        role: "shared-library",
        publishable: false,
      },
    },
  ];
}
