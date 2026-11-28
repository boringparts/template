import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { build as esbuild } from "esbuild";

import { scanPackageDirectory } from "../src/core/index.ts";
import { resolveTemplateDistributionSources } from "../src/presets/index.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");

const rootBaselineFiles = ["package.json", "pnpm-workspace.yaml"] as const;
const publicDeclarationFiles = new Set([
  "main.d.ts",
  "cli-command-identity.d.ts",
]);
const internalDeclarationImportPattern =
  /(?:from\s+|import\s*\(\s*)["']\.\/(?:core|presets|sources|cli-runner|cli(?:\.[cm]?[jt]s)?)(?:\/|["'])/u;

function resolveExecutable(name: string, searchRoot: string): string {
  const candidate = path.join(searchRoot, "node_modules", ".bin", name);
  return existsSync(candidate) ? candidate : name;
}

function pruneInternalDeclarations(dir: string, distRoot: string): boolean {
  let hasEntries = false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (pruneInternalDeclarations(entryPath, distRoot)) {
        hasEntries = true;
      } else {
        rmSync(entryPath, { recursive: true, force: true });
      }
      continue;
    }
    const relPath = path.relative(distRoot, entryPath).replaceAll("\\", "/");
    if (entry.name.endsWith(".d.ts") && !publicDeclarationFiles.has(relPath)) {
      rmSync(entryPath, { force: true });
      continue;
    }
    hasEntries = true;
  }
  return hasEntries;
}

function copyTemplatePackage(sourceDir: string, targetDir: string): void {
  const files = scanPackageDirectory(sourceDir, { includeResources: true });
  for (const file of files) {
    const targetPath = path.join(targetDir, file.relativePath);
    mkdirSync(path.dirname(targetPath), { recursive: true });
    copyFileSync(file.absPath, targetPath);
    chmodSync(targetPath, file.mode);
  }
}

async function main(): Promise<void> {
  const distDir = path.join(packageRoot, "dist");
  const templatesDir = path.join(packageRoot, "templates");

  rmSync(distDir, { recursive: true, force: true });
  rmSync(templatesDir, { recursive: true, force: true });

  const manifest = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const externalDependencies = Object.keys(manifest.dependencies ?? {});

  // Bundle src/main.ts and src/cli.ts into dist/ while keeping public npm runtime deps external.
  await esbuild({
    entryPoints: [
      path.join(packageRoot, "src/main.ts"),
      path.join(packageRoot, "src/cli.ts"),
    ],
    outdir: distDir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node24",
    conditions: ["source", "node", "import", "default"],
    external: ["node:*", ...externalDependencies],
    logLevel: "warning",
  });

  const cliEntryPath = path.join(distDir, "cli.js");
  const cliSource = readFileSync(cliEntryPath, "utf8");
  if (!cliSource.startsWith("#!/usr/bin/env node")) {
    throw new Error(
      "Bundled dist/cli.js is missing the #!/usr/bin/env node shebang.",
    );
  }
  if (process.platform !== "win32") {
    chmodSync(cliEntryPath, 0o755);
  }

  // Emit public declaration files and prune internal declarations so dist/ exposes only public types.
  const tscBin = resolveExecutable("tsc", packageRoot);
  execFileSync(
    tscBin,
    ["-p", "tsconfig.build.json", "--emitDeclarationOnly", "--pretty", "false"],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );

  pruneInternalDeclarations(distDir, distDir);

  for (const publicDts of publicDeclarationFiles) {
    const content = readFileSync(path.join(distDir, publicDts), "utf8");
    if (
      content.includes("@boringparts/template-engine") ||
      content.includes("@boringparts/template-presets") ||
      internalDeclarationImportPattern.test(content)
    ) {
      throw new Error(
        `Public declaration ${publicDts} leaks internal module imports.`,
      );
    }
  }

  // Copy static template assets using the registered reference package resolution.
  const sources = resolveTemplateDistributionSources();

  for (const refPkg of sources.referencePackages) {
    copyTemplatePackage(
      refPkg.packageDir,
      path.join(templatesDir, "references", refPkg.slug),
    );
  }

  const rootTargetDir = path.join(templatesDir, "root");
  mkdirSync(rootTargetDir, { recursive: true });
  for (const fileName of rootBaselineFiles) {
    copyFileSync(
      path.join(sources.rootBaseDir, fileName),
      path.join(rootTargetDir, fileName),
    );
  }
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(path.resolve(mainFile)).href === import.meta.url
) {
  await main();
}
