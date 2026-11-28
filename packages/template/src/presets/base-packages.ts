import path from "node:path";

import type { SingletonPackage, WorkspaceRoot } from "../core/index.ts";
import { resolveReferencePackageDir } from "../sources/index.ts";

/**
 * Builds the declarative `WorkspaceRoot` handle backed by `@boringparts/reference-workspace-root`.
 */
export function createWorkspaceRoot(templatesRoot?: string): WorkspaceRoot {
  const workspaceRootRefDir = resolveReferencePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );

  return {
    packageName: "@boringparts/reference-workspace-root",
    packageDir: workspaceRootRefDir,
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
    publicationResources: [
      {
        sourcePath: "resources/publication/config.json",
        targetPath: ".changeset/config.json",
      },
      {
        sourcePath: "resources/publication/release.yml",
        targetPath: ".github/workflows/release.yml",
      },
    ],
    devcontainerBase: {
      dockerfileSourcePath: "resources/environment/base.Dockerfile",
      templateSourcePath:
        "resources/environment/devcontainer/workspace-template.json",
    },
    environment: {
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
  };
}

/**
 * Builds the declarative singleton subpackages instantiated once per workspace
 * through the same homogeneous `PackageInstance` pipeline as business packages.
 */
export function createSingletonPackages(
  templatesRoot?: string,
): readonly SingletonPackage[] {
  const toolingConfigDir = resolveReferencePackageDir(
    "@boringparts/reference-tooling-config",
    import.meta.url,
    templatesRoot,
  );

  return [
    {
      nodeId: "tooling-config",
      defaultName: "tooling-config",
      defaultPath: "packages/tooling-config",
      singleton: true,
      referencePackage: {
        packageName: "@boringparts/reference-tooling-config",
        packageDir: toolingConfigDir,
        role: "shared-library",
        publishable: false,
      },
    },
  ];
}
