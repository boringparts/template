import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { templateContent } from "@boringparts/template-content";
import {
  prepareContentCollection,
  writeNativeArchiveOverrides,
  type PackedArtifact,
  type PreparedContentCollection,
} from "@boringparts/template-content-artifacts";
import { execa } from "execa";

type PackageManifest = {
  name: string;
  version: string;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bundleDependencies?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: {
    access?: string;
    directory?: string;
    linkDirectory?: boolean;
    exports?: Record<string, unknown>;
  };
};

type WorkspaceDependency = {
  version?: string;
};

type WorkspacePackage = {
  name?: string;
  dependencies?: Record<string, WorkspaceDependency>;
};

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const destination = path.join(packageRoot, ".package");
const packageManifestPath = path.join(packageRoot, "package.json");
const packageManifest = JSON.parse(
  await readFile(packageManifestPath, "utf8"),
) as PackageManifest;
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "template-cli-pack-"));
let prepared: PreparedContentCollection | undefined;

function archiveByName(
  archives: readonly PackedArtifact[],
): ReadonlyMap<string, PackedArtifact> {
  const result = new Map<string, PackedArtifact>();
  for (const archive of archives) {
    const current = result.get(archive.name);
    if (
      current !== undefined &&
      (current.version !== archive.version || current.sha256 !== archive.sha256)
    ) {
      throw new Error(
        `CLI archive cannot bundle multiple content coordinates under the same package name: ${archive.name}`,
      );
    }
    result.set(archive.name, archive);
  }
  return result;
}

async function resolvedDependencies(): Promise<
  Readonly<Record<string, WorkspaceDependency>>
> {
  const { stdout } = await execa(
    "pnpm",
    ["--filter", packageManifest.name, "list", "--depth", "0", "--json"],
    { cwd: packageRoot },
  );
  const projects = JSON.parse(stdout) as WorkspacePackage[];
  const project = projects.find(
    (candidate) => candidate.name === packageManifest.name,
  );
  if (project?.dependencies === undefined) {
    throw new Error(
      `pnpm did not return resolved native dependencies for CLI: ${packageManifest.name}`,
    );
  }
  return project.dependencies;
}

async function workspaceRoot(): Promise<string> {
  const { stdout } = await execa(
    "pnpm",
    ["--workspace-root", "exec", "node", "-p", "process.cwd()"],
    { cwd: packageRoot },
  );
  return path.resolve(stdout.trim());
}

/** Excludes source-only maintenance exports from the published CLI archive manifest. */
function packageManifestForArchives(
  archives: readonly PackedArtifact[],
  resolved: Readonly<Record<string, WorkspaceDependency>>,
): PackageManifest {
  const localArchives = archiveByName(archives);
  const dependencies = { ...packageManifest.dependencies };
  for (const [name, archive] of localArchives) {
    dependencies[name] = archive.version;
  }
  for (const name of Object.keys(dependencies)) {
    if (localArchives.has(name)) continue;
    const version = resolved[name]?.version;
    if (version === undefined || version.startsWith("link:")) {
      throw new Error(
        `CLI native archive is missing a resolvable dependency: ${name}`,
      );
    }
    dependencies[name] = version;
  }

  const bundleDependencies = [
    ...new Set([
      ...(packageManifest.bundleDependencies ?? []),
      ...localArchives.keys(),
    ]),
  ].toSorted();
  const scripts = { ...packageManifest.scripts };
  delete scripts.prepack;
  const publishConfig = { ...packageManifest.publishConfig };
  delete publishConfig.directory;
  delete publishConfig.linkDirectory;
  delete publishConfig.exports;
  const exports = packageManifest.publishConfig?.exports;
  if (exports === undefined) {
    throw new Error(
      "CLI distribution manifest is missing publishConfig.exports",
    );
  }

  return {
    ...packageManifest,
    exports,
    files: [
      "dist",
      ...bundleDependencies.map((name) => `node_modules/${name}`),
      "!**/node_modules/**/node_modules",
    ],
    scripts,
    publishConfig,
    dependencies,
    bundleDependencies,
    devDependencies: {},
  };
}

try {
  prepared = await prepareContentCollection({
    content: templateContent,
    roots: templateContent,
    packageName: "@boringparts/template-content",
    additionalSdkRoots: ["@boringparts/template-workspace"],
    workspaceRoot: await workspaceRoot(),
    root: path.join(temporaryRoot, "content"),
  });

  const archives = [...prepared.archives.values()];
  const stage = path.join(temporaryRoot, "package");
  const dependencies = await resolvedDependencies();
  await mkdir(stage, { recursive: true });
  await cp(path.join(packageRoot, "dist"), path.join(stage, "dist"), {
    recursive: true,
  });
  await writeFile(
    path.join(stage, "package.json"),
    `${JSON.stringify(packageManifestForArchives(archives, dependencies), null, 2)}\n`,
  );
  await writeNativeArchiveOverrides(stage, archives);

  const install = await execa(
    "pnpm",
    ["--config.node-linker=hoisted", "install", "--prod", "--prefer-offline"],
    { reject: false, cwd: stage },
  );
  if (install.exitCode !== 0) {
    throw new Error(
      `pnpm failed to install CLI content closure: ${install.stderr || install.stdout}`,
    );
  }
  await rm(destination, { recursive: true, force: true });
  await cp(stage, destination, { recursive: true });
  console.log(`CLI distribution directory prepared: ${destination}`);
} finally {
  try {
    await prepared?.cleanup();
  } finally {
    if (process.env.TEMPLATE_CLI_PACK_KEEP_STAGE === "1") {
      console.error(`Preserved pack staging directory: ${temporaryRoot}`);
    } else {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}
