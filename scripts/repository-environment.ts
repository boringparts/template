import { readFileSync } from "node:fs";
import path from "node:path";

import {
  prepareRustDevelopmentContainerToolLayerFragments,
  rustDevelopmentContainerToolLayer,
} from "@boringparts/reference-rust-bin/environment";
import {
  browserTestDevelopmentContainerToolLayer,
  prepareWorkspaceDevelopmentContainerResources,
  prepareWorkspaceEditorCustomizationDeclarations,
  projectWorkspaceDevelopmentContainer,
  projectWorkspaceEditorCustomization,
  shellCheckDevelopmentContainerToolLayer,
} from "@boringparts/reference-workspace-root/environment";
import { createTemplateSourceHandle } from "@boringparts/template-core/template-source";
import type { DevelopmentContainerToolLayerProbe } from "@boringparts/template-environment/development-container-tool-layer";
import { format } from "oxfmt";

import formatterConfig from "../oxfmt.config.ts";
import type { TemplateToolchainDeclarations } from "./template-toolchain-declarations.ts";

function prepareRepositoryEnvironmentDockerfile(): string {
  try {
    return readFileSync(
      path.join(
        import.meta.dirname,
        "repository-environment/repository.Dockerfile",
      ),
      "utf8",
    );
  } catch (cause) {
    throw new Error(
      "Failed to read repository.Dockerfile while preparing scripts/repository-environment resources",
      { cause },
    );
  }
}

/**
 * Projects the source repository's devcontainer and editor files; shared tool
 * layers and editor policies remain owned by their respective packages.
 */
export async function repositoryDevelopmentEnvironment(
  declarations: TemplateToolchainDeclarations,
): Promise<{
  readonly files: Readonly<Record<string, string>>;
  readonly probes: readonly DevelopmentContainerToolLayerProbe[];
}> {
  const layers = [
    browserTestDevelopmentContainerToolLayer(
      declarations.playwrightTestVersion,
    ),
    rustDevelopmentContainerToolLayer(declarations.rustToolchainChannel.trim()),
    shellCheckDevelopmentContainerToolLayer(),
    {
      identity: "template-repository",
      requires: ["node-pnpm"],
      dockerfile: {
        source: createTemplateSourceHandle(
          path.join(import.meta.dirname, "repository-environment"),
        ),
        from: "repository.Dockerfile",
      },
      mounts: [
        {
          identity: "cargo-target",
          type: "volume" as const,
          source: "${devcontainerId}-target",
          target: "${containerWorkspaceFolder}/target",
        },
      ],
      probes: [
        { identity: "git-lfs", command: "git", args: ["lfs", "version"] },
      ],
    },
  ];
  const environmentResources = prepareWorkspaceDevelopmentContainerResources();
  const rustFragments = prepareRustDevelopmentContainerToolLayerFragments();
  const repositoryDockerfile = prepareRepositoryEnvironmentDockerfile();
  const container = projectWorkspaceDevelopmentContainer({
    nodeVersion: declarations.rootNodeEngine.trim(),
    packageManagerPin: declarations.packageManagerDeclaration.trim(),
    turboVersion: declarations.turboVersion.trim(),
    layers,
    resources: {
      ...environmentResources,
      dockerfileFragments: {
        ...environmentResources.dockerfileFragments,
        ...rustFragments,
        "repository.Dockerfile": repositoryDockerfile,
      },
    },
  });
  const editor = projectWorkspaceEditorCustomization(
    ["oxc-format-lint", "vue", "rust-tooling"],
    prepareWorkspaceEditorCustomizationDeclarations(),
  );
  const extensions = [...editor.extensions, "fill-labs.dependi"];
  const settings = {
    ...editor.settings,
    "[rust]": { "editor.defaultFormatter": "rust-lang.rust-analyzer" },
    "[toml]": { "editor.defaultFormatter": "tamasfe.even-better-toml" },
  };
  const files: Record<string, string> = {
    ".devcontainer/Dockerfile": container.dockerfile,
  };
  const structuredFiles: Record<string, unknown> = {
    ".devcontainer/devcontainer.json": {
      name: "Template",
      build: {
        dockerfile: "Dockerfile",
        args: Object.fromEntries(
          container.buildArguments.map(({ name, value }) => [name, value]),
        ),
      },
      features: container.features,
      customizations: { vscode: { extensions, settings } },
      runArgs: [
        "--security-opt=seccomp=unconfined",
        "--security-opt=apparmor=unconfined",
        "--cap-add=SYS_ADMIN",
      ],
      containerEnv: {
        RUST_BACKTRACE: "1",
      },
      postCreateCommand: {
        installNodeDependencies: "pnpm install --frozen-lockfile",
      },
      remoteUser: "root",
      mounts: container.mounts.map(
        ({ identity: _identity, ...mount }) => mount,
      ),
    },
    ".vscode/settings.json": settings,
    ".vscode/extensions.json": { recommendations: extensions },
  };
  for (const [file, value] of Object.entries(structuredFiles)) {
    const result = await format(
      file,
      JSON.stringify(value, null, 2),
      formatterConfig,
    );
    if (result.errors.length > 0)
      throw new Error(
        `Failed to format projected file ${file}: ${result.errors.map((error) => error.message).join("; ")}`,
      );
    files[file] = result.code;
  }
  return { files, probes: container.probes };
}
