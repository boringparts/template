import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createTemplateSourceHandle,
  resolveTemplateSource,
} from "@ykdz/template-core/template-source";
import type { DevelopmentContainerToolLayer } from "@ykdz/template-environment/development-container-tool-layer";

const resourceSource = createTemplateSourceHandle(
  fileURLToPath(new URL("../resources/devcontainer/", import.meta.url)),
);

/** Reads the Rust devcontainer Dockerfile fragment during host repository sync. */
export function prepareRustDevelopmentContainerToolLayerFragments(): Readonly<
  Record<string, string>
> {
  try {
    return {
      "rust.Dockerfile": readFileSync(
        resolveTemplateSource(resourceSource, "rust.Dockerfile"),
        "utf8",
      ),
    };
  } catch (cause) {
    throw new Error(
      "Failed to read rust.Dockerfile while preparing @ykdz/reference-rust-bin#./environment",
      { cause },
    );
  }
}

/** Declares the Rust devcontainer tool layer build arguments, Cargo mounts, and probes. */
export function rustDevelopmentContainerToolLayer(
  rustVersion: string,
): DevelopmentContainerToolLayer {
  return {
    identity: "rust",
    dockerfile: { source: resourceSource, from: "rust.Dockerfile" },
    requires: ["node-pnpm"],
    buildArguments: [{ name: "RUST_TOOLCHAIN", value: rustVersion }],
    mounts: [
      {
        identity: "cargo-registry",
        type: "volume",
        source: "${devcontainerId}-cargo-registry",
        target: "/usr/local/cargo/registry",
      },
      {
        identity: "cargo-git",
        type: "volume",
        source: "${devcontainerId}-cargo-git",
        target: "/usr/local/cargo/git",
      },
    ],
    probes: [
      { identity: "cargo", command: "cargo", args: ["--version"] },
      { identity: "rustc", command: "rustc", args: ["--version"] },
      { identity: "rustfmt", command: "cargo", args: ["fmt", "--version"] },
      { identity: "clippy", command: "cargo", args: ["clippy", "--version"] },
    ],
  };
}
