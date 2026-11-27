import type { PresetDefinition } from "@boringparts/template-engine";

import { resolvePackageDir } from "../roots.ts";

/** Builds the `rust-bin` preset backed by `@boringparts/reference-rust-bin`. */
export function createRustBinPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-rust-bin",
    import.meta.url,
    templatesRoot,
  );

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
        reference: {
          packageName: "@boringparts/reference-rust-bin",
          packageDir,
          role: "native-package",
          publishable: false,
          rustPackageName: "app",
          files: [
            { sourcePath: "package.json", targetPath: "package.json" },
            { sourcePath: "turbo.json", targetPath: "turbo.json" },
            { sourcePath: "Cargo.toml", targetPath: "Cargo.toml" },
            { sourcePath: "Cargo.lock", targetPath: "Cargo.lock" },
            { sourcePath: "rustfmt.toml", targetPath: "rustfmt.toml" },
            { sourcePath: "src/main.rs", targetPath: "src/main.rs" },
            { sourcePath: "resources/gitignore", targetPath: ".gitignore" },
            { sourcePath: "resources/npmignore", targetPath: ".npmignore" },
          ],
        },
      },
    ],
    capabilities: {
      devcontainerLayers: ["github-cli", "rust-toolchain"],
      editorCapabilities: ["oxc-format-lint", "rust-tooling"],
      rustWorkspace: true,
      cargoDependabot: true,
    },
  };
}
