import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import type { CurrentProjectProjectionEntry } from "@boringparts/template-core/project-projection";
import { parse as parseToml } from "smol-toml";

export const rootRustDeclarationFileName = "rust-toolchain.toml";
const rootRustToolchainChannelField = "[toolchain].channel";

export class RustToolchainDeclarationFailure extends Error {
  readonly field = rootRustToolchainChannelField;
  readonly suggestion: string;

  constructor(
    requirement: string,
    actualDeclaration: string,
    suggestion: string,
  ) {
    super(
      `Adding a package requires ${rootRustToolchainChannelField} in the root ${rootRustDeclarationFileName} ${requirement}, but got ${actualDeclaration}. ${suggestion}`,
    );
    this.suggestion = suggestion;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type RustToolchainChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

export type PreparedRootRustToolchainTarget = {
  readonly target?: { readonly channel: string; readonly declaration: string };
  readonly readFact: CurrentProjectProjectionEntry;
};

/**
 * Reads the root `rust-toolchain.toml` once during add preparation and captures the file or
 * missing-file read fact. Throws `RustToolchainDeclarationFailure` if invalid, or if missing
 * when required.
 */
export async function prepareRootRustToolchainTarget(options: {
  readonly repositoryRoot: string;
  readonly required: boolean;
}): Promise<PreparedRootRustToolchainTarget> {
  const filePath = path.join(
    options.repositoryRoot,
    rootRustDeclarationFileName,
  );
  let stat;
  try {
    stat = await lstat(filePath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      if (options.required) {
        throw new RustToolchainDeclarationFailure(
          "to exist",
          "missing file",
          `Create a root ${rootRustDeclarationFileName} declaring channel under [toolchain] before adding packages.`,
        );
      }
      return {
        readFact: { path: rootRustDeclarationFileName, kind: "missing" },
      };
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new RustToolchainDeclarationFailure(
      "to be in a regular file",
      "a non-regular file",
      `Fix the root ${rootRustDeclarationFileName} so it is a regular TOML file.`,
    );
  }
  const bytes = new Uint8Array(await readFile(filePath));
  const declaration = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const reading = readRustToolchainChannelFromToml(declaration);
  if (reading.status !== "explained") {
    throw new RustToolchainDeclarationFailure(
      "to be a valid TOML declaration",
      reading.reason,
      `Fix the root ${rootRustDeclarationFileName} to declare a non-empty channel under [toolchain] before adding packages.`,
    );
  }
  return {
    target: { channel: reading.channel, declaration },
    readFact: {
      path: rootRustDeclarationFileName,
      kind: "file",
      content: bytes,
      mode: stat.mode & 0o111,
    },
  };
}

/** Parses the root Rust toolchain channel from TOML text for shared toolchain mirror validation. */
export function readRustToolchainChannelFromToml(
  contents: string,
): RustToolchainChannelReading {
  let declaration: unknown;
  try {
    declaration = parseToml(contents);
  } catch (error) {
    return {
      reason: `invalid TOML declaration: ${error instanceof Error ? error.message : String(error)}`,
      status: "unreadable",
    };
  }
  const toolchain = isRecord(declaration) ? declaration.toolchain : undefined;
  const channel = isRecord(toolchain) ? toolchain.channel : undefined;
  if (typeof channel !== "string" || channel.trim().length === 0) {
    return {
      reason: `[toolchain].channel must be a non-empty string, got ${JSON.stringify(channel ?? null)}`,
      status: "unreadable",
    };
  }
  return { channel, status: "explained" };
}
