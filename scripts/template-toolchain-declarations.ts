import { readFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

export type TemplateToolchainDeclarations = {
  readonly rootNodeEngine: string;
  readonly rootNodeRuntimeName: string;
  readonly rootNodeRuntimeOnFail: string;
  readonly packageManagerDeclaration: string;
  readonly rustToolchainChannel: string;
  readonly playwrightTestVersion: string;
  readonly turboVersion: string;
};

/**
 * Validates root toolchain declarations and derives the public CLI Node caret
 * range and pinned pnpm version.
 */
export function deriveTemplateToolchain(
  declarations: TemplateToolchainDeclarations,
): {
  readonly diagnostics: string[];
  readonly cliNodeEngine: string;
  readonly pnpmVersion: string | undefined;
} {
  const node = declarations.rootNodeEngine.trim();
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/u.exec(
    declarations.packageManagerDeclaration.trim(),
  )?.[1];
  const diagnostics: string[] = [];
  if (declarations.rootNodeRuntimeName.trim() !== "node")
    diagnostics.push(
      `Root devEngines.runtime.name must be "node", got ${declarations.rootNodeRuntimeName}`,
    );
  if (!/^\d+\.\d+\.\d+$/u.test(node))
    diagnostics.push(
      `Root devEngines.runtime.version must declare an exact tested Node patch version (e.g. 26.13.1), got ${declarations.rootNodeEngine}`,
    );
  if (declarations.rootNodeRuntimeOnFail.trim() !== "download")
    diagnostics.push(
      `Root devEngines.runtime.onFail must be "download", got ${declarations.rootNodeRuntimeOnFail}`,
    );
  if (pnpmVersion === undefined)
    diagnostics.push(
      `Root packageManager must be an exact pnpm pin (e.g. pnpm@11.21.0 without range or hash), got ${declarations.packageManagerDeclaration}`,
    );
  if (!/^\d+\.\d+\.\d+$/u.test(declarations.rustToolchainChannel.trim()))
    diagnostics.push(
      `Root rust-toolchain.toml must declare an exact tested Rust version (e.g. 1.97.1; stable, beta, nightly, and ranges are not allowed), got ${declarations.rustToolchainChannel}`,
    );
  if (declarations.playwrightTestVersion.trim().length === 0) {
    diagnostics.push(
      "Root pnpm-workspace.yaml must declare @playwright/test in catalog",
    );
  }
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u.test(
      declarations.turboVersion.trim(),
    )
  ) {
    diagnostics.push(
      `Root pnpm-workspace.yaml must declare an exact turbo version in catalog (e.g. 2.11.13), got ${declarations.turboVersion}`,
    );
  }
  return { diagnostics, cliNodeEngine: `^${node}`, pnpmVersion };
}

/**
 * Extracts `devEngines.runtime` fields from a root manifest or returns
 * missing-field placeholders for validation diagnostics.
 */
export function readNodeDevEngine(manifest: {
  readonly devEngines?: unknown;
}): {
  readonly name: string;
  readonly version: string;
  readonly onFail: string;
} {
  const devEngines = manifest.devEngines;
  const runtime = isRecord(devEngines) ? devEngines.runtime : undefined;
  if (!isRecord(runtime)) {
    return {
      name: "(missing devEngines.runtime.name)",
      version: "(missing devEngines.runtime.version)",
      onFail: "(missing devEngines.runtime.onFail)",
    };
  }
  return {
    name:
      typeof runtime.name === "string"
        ? runtime.name
        : "(missing devEngines.runtime.name)",
    version:
      typeof runtime.version === "string"
        ? runtime.version
        : "(missing devEngines.runtime.version)",
    onFail:
      typeof runtime.onFail === "string"
        ? runtime.onFail
        : "(missing devEngines.runtime.onFail)",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads root toolchain declarations from `package.json`, `rust-toolchain.toml`,
 * and `pnpm-workspace.yaml`, using missing-field placeholders so callers can
 * report all validation diagnostics together.
 */
export async function readTemplateToolchainDeclarations(
  repositoryRoot: string,
): Promise<TemplateToolchainDeclarations> {
  const [manifestContents, rustContents, workspaceContents] = await Promise.all(
    [
      readFile(path.join(repositoryRoot, "package.json"), "utf8"),
      readFile(path.join(repositoryRoot, "rust-toolchain.toml"), "utf8").catch(
        () => "",
      ),
      readFile(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8").catch(
        () => "",
      ),
    ],
  );
  const manifest = JSON.parse(manifestContents) as {
    readonly devEngines?: unknown;
    readonly packageManager?: unknown;
  };
  const rustDeclaration = parseToml(rustContents);
  const workspaceDeclaration = parseYaml(workspaceContents);
  const workspaceCatalog =
    isRecord(workspaceDeclaration) && isRecord(workspaceDeclaration.catalog)
      ? workspaceDeclaration.catalog
      : undefined;
  const playwrightTestVersion =
    workspaceCatalog?.["@playwright/test"] ?? workspaceCatalog?.playwright;
  const turboVersion = workspaceCatalog?.turbo;
  const toolchain = rustDeclaration.toolchain;
  const channel =
    typeof toolchain === "object" &&
    toolchain !== null &&
    "channel" in toolchain
      ? toolchain.channel
      : undefined;
  const nodeDevEngine = readNodeDevEngine(manifest);
  return {
    rootNodeEngine: nodeDevEngine.version,
    rootNodeRuntimeName: nodeDevEngine.name,
    rootNodeRuntimeOnFail: nodeDevEngine.onFail,
    packageManagerDeclaration:
      typeof manifest.packageManager === "string"
        ? manifest.packageManager
        : "(missing packageManager)",
    rustToolchainChannel:
      typeof channel === "string"
        ? channel
        : "(missing rust-toolchain.toml channel)",
    playwrightTestVersion:
      typeof playwrightTestVersion === "string" ? playwrightTestVersion : "",
    turboVersion:
      typeof turboVersion === "string" ? turboVersion : "(missing turbo)",
  };
}
