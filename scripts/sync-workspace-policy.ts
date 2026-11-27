import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { execa } from "execa";
import { format } from "oxfmt";
import { parse } from "yaml";

import formatterConfig from "../oxfmt.config.ts";
import {
  readTemplateToolchainDeclarations,
  deriveTemplateToolchain,
} from "./template-toolchain-declarations.ts";

const root = new URL("../", import.meta.url);
const workspace = parse(
  await readFile(new URL("pnpm-workspace.yaml", root), "utf8"),
) as Record<string, unknown> & { catalog: Record<string, string> };
const ignore = await readFile(new URL(".gitignore", root), "utf8");
const {
  packages: _packages,
  catalog: _catalog,
  catalogs: _catalogs,
  ...installPolicy
} = workspace;
const check = process.argv.includes("--check");

async function formattedSource(name: string, source: string): Promise<string> {
  const result = await format(name, source, formatterConfig);
  if (result.errors.length > 0) {
    throw new Error(`Failed to format ${name}.`);
  }
  return result.code;
}

async function sendToOwner(
  packageName: string,
  taskName: string,
  source: string,
): Promise<void> {
  const result = await execa(
    "pnpm",
    [
      "--filter",
      packageName,
      "run",
      taskName,
      ...(check ? ["--", "--check"] : []),
    ],
    {
      cwd: fileURLToPath(root),
      input: source,
      reject: false,
    },
  );
  if (result.failed) {
    throw new Error(
      `${packageName} ${taskName} failed: ${result.stderr || result.stdout}`,
    );
  }
}

const workspaceSnapshot = await formattedSource(
  "workspace-policy-snapshot.ts",
  `// Derived by root sync:workspace-policy from native declarations; edit the source of truth and run sync explicitly.
export const dependencyCatalogSnapshot: Readonly<Record<string, string>> = ${JSON.stringify(workspace.catalog, null, 2)};

export const workspaceInstallPolicySnapshot = ${JSON.stringify(installPolicy, null, 2)};
`,
);
const resourceIgnoreSnapshot = await formattedSource(
  "resource-ignore-snapshot.ts",
  `// Derived by root sync:workspace-policy from root .gitignore; edit the source of truth and run sync explicitly.
export const resourceIgnoreSnapshot = ${JSON.stringify(ignore)};
`,
);
const declarations = await readTemplateToolchainDeclarations(
  fileURLToPath(root),
);
const derived = deriveTemplateToolchain(declarations);
if (derived.diagnostics.length > 0)
  throw new Error(derived.diagnostics.join("\n"));
const toolchainSnapshot = await formattedSource(
  "release-toolchain-snapshot.ts",
  `// Derived by root sync:workspace-policy from native toolchain declarations; edit the source of truth and run sync explicitly.
export const releaseToolchainSnapshot = Object.freeze(${JSON.stringify({ nodeVersion: declarations.rootNodeEngine.trim(), packageManagerPin: declarations.packageManagerDeclaration.trim(), rustVersion: declarations.rustToolchainChannel.trim() }, null, 2)} as const);

export type ReleaseToolchainSnapshot = typeof releaseToolchainSnapshot;
`,
);

await Promise.all([
  sendToOwner(
    "@boringparts/template-workspace",
    "sync:release-toolchain-snapshot",
    toolchainSnapshot,
  ),
  sendToOwner(
    "@boringparts/template-workspace",
    "sync:policy-snapshot",
    workspaceSnapshot,
  ),
  sendToOwner(
    "@boringparts/template-workspace-authoring",
    "sync:resource-ignore-snapshot",
    resourceIgnoreSnapshot,
  ),
]);
