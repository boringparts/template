import path from "node:path";

import type { PresetDefinition } from "@boringparts/template-engine";

import type { WorkspaceEnvironmentMeta } from "../environment-meta.ts";
import { resolvePackageDir, resolveRustToolchainChannel } from "../roots.ts";

/** Builds the `rust-bin` preset backed by `@boringparts/reference-rust-bin`. */
export function createRustBinPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-rust-bin",
    import.meta.url,
    templatesRoot,
  );
  const rustToolchainChannel = resolveRustToolchainChannel(templatesRoot);

  return {
    alias: "rust-bin",
    title: "Rust Binary",
    description:
      "Native Rust binary workspace with rustfmt, clippy, and cargo tests.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "binary",
        defaultName: "app",
        defaultCollection: "crates",
        defaultPath: "crates/app",
        definition: {
          packageName: "@boringparts/reference-rust-bin",
          packageDir,
          role: "native-package",
          publishable: false,
          rustPackageName: "app",
          // Defer subpackage Cargo.lock emission until Ticket 03 removes root Cargo workspace synthesis.
          excludeFiles: ["Cargo.lock"],
          resources: [
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
          ],
          meta: {
            devcontainer: {
              layers: [
                {
                  id: "rust-toolchain",
                  dockerfilePath: path.join(
                    packageDir,
                    "resources",
                    "devcontainer",
                    "rust.Dockerfile",
                  ),
                },
              ],
              buildArgs: {
                RUST_TOOLCHAIN: rustToolchainChannel,
              },
              mounts: [
                {
                  type: "volume",
                  source: "${devcontainerId}-cargo-registry",
                  target: "/usr/local/cargo/registry",
                },
                {
                  type: "volume",
                  source: "${devcontainerId}-cargo-git",
                  target: "/usr/local/cargo/git",
                },
                {
                  type: "volume",
                  source: "${devcontainerId}-target",
                  target: "${containerWorkspaceFolder}/target",
                },
              ],
              containerEnv: {
                RUST_BACKTRACE: "1",
              },
            },
            vscode: {
              extensions: [
                "rust-lang.rust-analyzer",
                "tamasfe.even-better-toml",
              ],
              settings: {
                "rust-analyzer.cargo.features": "all",
                "rust-analyzer.check.command": "clippy",
                "rust-analyzer.procMacro.enable": true,
              },
            },
            dependabot: {
              updates: [
                {
                  packageEcosystem: "cargo",
                  directory: "/",
                  interval: "weekly",
                },
                {
                  packageEcosystem: "rust-toolchain",
                  directory: "/",
                  interval: "weekly",
                },
              ],
            },
          },
        },
      },
    ],
  };
}
