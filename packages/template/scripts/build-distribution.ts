import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveTemplateDistributionSources } from "@boringparts/template-presets";
import { build as esbuild } from "esbuild";

const packageRoot = path.resolve(import.meta.dirname, "..");

const excludedDirectories = new Set([
  "node_modules",
  "dist",
  "target",
  ".turbo",
  ".local",
  "test-results",
  "playwright-report",
  ".vitest",
  "coverage",
  ".pnpm-store",
]);

const excludedFiles = new Set([".DS_Store"]);

const rootBaselineFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml",
] as const;

function resolveExecutable(name: string, searchRoot: string): string {
  const candidate = path.join(searchRoot, "node_modules", ".bin", name);
  return existsSync(candidate) ? candidate : name;
}

export function copyTemplateDirectory(
  sourceDir: string,
  targetDir: string,
): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      if (excludedDirectories.has(entry.name)) {
        continue;
      }
      copyTemplateDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (excludedFiles.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) {
      continue;
    }
    copyFileSync(sourcePath, targetPath);
    const mode = statSync(sourcePath).mode & 0o777;
    chmodSync(targetPath, mode);
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

  // Inline workspace-private engine and presets into dist/ while keeping public npm runtime deps external.
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

  // Emit public declaration files and verify zero leaks from workspace-private packages.
  const tscBin = resolveExecutable("tsc", packageRoot);
  execFileSync(
    tscBin,
    ["-p", "tsconfig.build.json", "--emitDeclarationOnly", "--pretty", "false"],
    {
      cwd: packageRoot,
      stdio: "inherit",
    },
  );

  for (const internalDts of ["cli.d.ts", "cli-runner.d.ts"]) {
    rmSync(path.join(distDir, internalDts), { force: true });
  }

  for (const publicDts of ["main.d.ts", "cli-command-identity.d.ts"]) {
    const content = readFileSync(path.join(distDir, publicDts), "utf8");
    if (
      content.includes("@boringparts/template-engine") ||
      content.includes("@boringparts/template-presets")
    ) {
      throw new Error(
        `Public declaration ${publicDts} leaks workspace-private package imports.`,
      );
    }
  }

  // Copy static template assets using the exact registered package resolution from @boringparts/template-presets.
  const sources = resolveTemplateDistributionSources();

  for (const refPkg of sources.referencePackages) {
    copyTemplateDirectory(
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
