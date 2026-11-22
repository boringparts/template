import type { RustToolchainRequirement } from "@ykdz/default-content-authoring/contracts";
import { projectTomlStringValues } from "@ykdz/template-core/toml";
import { parse } from "smol-toml";

export type { RustToolchainRequirement };

export type PreparedRustToolchainDeclaration = {
  readonly channel: string;
  readonly components: readonly string[];
  readonly declaration: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses Rust toolchain channel and component declarations from a rust-toolchain.toml string. */
export function parseRustToolchainDeclaration(
  declaration: string,
): PreparedRustToolchainDeclaration {
  let parsed: unknown;
  try {
    parsed = parse(declaration);
  } catch (error) {
    throw new Error(
      `Rust toolchain declaration is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const toolchain = isRecord(parsed) ? parsed.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    throw new Error(
      "Rust toolchain declaration [toolchain].channel must be a non-empty string",
    );
  }
  const components = isRecord(toolchain) ? toolchain.components : undefined;
  if (
    components !== undefined &&
    (!Array.isArray(components) ||
      !components.every((component) => typeof component === "string"))
  ) {
    throw new Error(
      "Rust toolchain declaration [toolchain].components must be an array of strings",
    );
  }
  return {
    channel,
    components: components ?? [],
    declaration,
  };
}

/**
 * Projects the root rust-toolchain.toml declaration for the required channel.
 *
 * When `existingDeclaration` is provided, preserves its original bytes after verifying its
 * channel matches `requirement.toolchain`; throws on channel mismatch or invalid TOML.
 */
export function projectRustToolchainDeclaration(options: {
  readonly requirement: RustToolchainRequirement;
  readonly existingDeclaration?: string;
}): string {
  if (options.existingDeclaration !== undefined) {
    const existing = parseRustToolchainDeclaration(options.existingDeclaration);
    if (existing.channel !== options.requirement.toolchain) {
      throw new Error(
        "Existing root Rust channel does not match the shared toolchain requirement",
      );
    }
    return options.existingDeclaration;
  }
  return projectTomlStringValues(options.requirement.configurationText, [
    { path: ["toolchain", "channel"], value: options.requirement.toolchain },
  ]);
}
