import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  createWorkspaceSourceContext,
  normalizeRelativePackagePath,
  readPnpmWorkspaceCatalog,
  validateWorkspacePolicy,
} from "../../src/index.ts";

function runGit(cwd: string, args: readonly string[]): void {
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

void describe("SourceContext and WorkspacePolicy helpers", () => {
  void it("enumerates plain non-Git workspace directories while skipping top-level resources by default", () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), "template-plain-src-"));
    try {
      const pkgDir = path.join(baseDir, "templates", "my-lib");
      mkdirSync(path.join(pkgDir, "src"), { recursive: true });
      mkdirSync(path.join(pkgDir, "resources", "extra"), { recursive: true });
      mkdirSync(path.join(pkgDir, "scripts"), { recursive: true });

      writeFileSync(path.join(pkgDir, "package.json"), '{"name":"my-lib"}\n');
      writeFileSync(
        path.join(pkgDir, "src", "index.ts"),
        "export const x = 1;\n",
      );
      const scriptPath = path.join(pkgDir, "scripts", "run.sh");
      writeFileSync(scriptPath, "#!/bin/sh\necho ok\n");
      chmodSync(scriptPath, 0o755);
      writeFileSync(
        path.join(pkgDir, "resources", "extra", "readme.txt"),
        "resource asset\n",
      );

      const source = createWorkspaceSourceContext(baseDir);
      assert.equal(source.kind, "workspace");
      assert.equal(source.rootDir, baseDir);

      const regularFiles = source.listPackageFiles("templates/my-lib");
      assert.deepStrictEqual(
        regularFiles.map((file) => file.relativePath),
        ["package.json", "scripts/run.sh", "src/index.ts"],
      );
      const runSh = regularFiles.find(
        (file) => file.relativePath === "scripts/run.sh",
      );
      assert.ok(runSh);
      assert.equal(runSh.executable, true);

      const allFiles = source.listPackageFiles("templates/my-lib", {
        includeResources: true,
      });
      assert.deepStrictEqual(
        allFiles.map((file) => file.relativePath),
        [
          "package.json",
          "resources/extra/readme.txt",
          "scripts/run.sh",
          "src/index.ts",
        ],
      );

      assert.equal(
        source.readPackageText("templates/my-lib", "src/index.ts"),
        "export const x = 1;\n",
      );
      assert.equal(
        source.tryReadPackageText("templates/my-lib", "missing.txt"),
        undefined,
      );
      assert.throws(() => source.listPackageFiles("../escape"));
      assert.equal(normalizeRelativePackagePath("a/b/c"), "a/b/c");
      assert.equal(normalizeRelativePackagePath("../a"), undefined);
      assert.equal(normalizeRelativePackagePath("/abs/path"), undefined);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  void it("uses git ls-files in Git-managed directories to exclude .gitignore artifacts while preserving executable bits", () => {
    const repoDir = mkdtempSync(path.join(tmpdir(), "template-git-src-"));
    try {
      runGit(repoDir, ["init"]);
      runGit(repoDir, ["config", "user.name", "Test"]);
      runGit(repoDir, ["config", "user.email", "test@example.com"]);

      writeFileSync(path.join(repoDir, ".gitignore"), "dist/\n*.log\n");
      const pkgDir = path.join(repoDir, "templates", "service");
      mkdirSync(path.join(pkgDir, "src"), { recursive: true });
      mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
      mkdirSync(path.join(pkgDir, "bin"), { recursive: true });

      writeFileSync(path.join(pkgDir, "package.json"), '{"name":"service"}\n');
      writeFileSync(path.join(pkgDir, "src", "server.ts"), "export {};\n");
      const cliPath = path.join(pkgDir, "bin", "start.sh");
      writeFileSync(cliPath, "#!/bin/sh\n");
      chmodSync(cliPath, 0o755);

      runGit(repoDir, ["add", ".gitignore", "templates/service/package.json"]);
      runGit(repoDir, ["commit", "-m", "initial"]);

      // Dirty build artifacts that must be ignored by git ls-files
      writeFileSync(path.join(pkgDir, "dist", "server.js"), "dirty();\n");
      writeFileSync(path.join(pkgDir, "debug.log"), "dirty log\n");

      const source = createWorkspaceSourceContext(repoDir);
      const files = source.listPackageFiles("templates/service");
      assert.deepStrictEqual(
        files.map((file) => file.relativePath),
        ["bin/start.sh", "package.json", "src/server.ts"],
      );
      const startSh = files.find(
        (file) => file.relativePath === "bin/start.sh",
      );
      assert.ok(startSh);
      assert.equal(startSh.executable, true);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  void it("reads pnpm-workspace.yaml catalogs via yaml and validates WorkspacePolicy with empty defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "template-policy-"));
    try {
      const yamlPath = path.join(dir, "pnpm-workspace.yaml");
      writeFileSync(
        yamlPath,
        [
          "packages:",
          "  - packages/*",
          "catalog:",
          "  yaml: ^2.9.0",
          "catalogs:",
          "  node-24:",
          '    "@types/node": ~24.0.0',
          "overrides:",
          '  "foo>bar": "^1.0.0"',
          "",
        ].join("\n"),
      );

      const parsedCatalog = readPnpmWorkspaceCatalog(yamlPath);
      assert.deepStrictEqual(parsedCatalog, {
        catalog: { yaml: "^2.9.0" },
        catalogs: { "node-24": { "@types/node": "~24.0.0" } },
        overrides: { "foo>bar": "^1.0.0" },
      });

      const emptyYamlPath = path.join(dir, "empty-workspace.yaml");
      writeFileSync(emptyYamlPath, "packages:\n  - packages/*\n");
      assert.deepStrictEqual(readPnpmWorkspaceCatalog(emptyYamlPath), {
        catalog: {},
        catalogs: {},
        overrides: {},
      });

      const minimalPolicy = validateWorkspacePolicy({
        nodeLinker: "isolated",
        preferSymlinkedExecutables: true,
        shellEmulator: true,
        autoInstallPeers: false,
        injectWorkspacePackages: false,
        dedupeInjectedDeps: false,
        minimumReleaseAge: 1440,
        minimumReleaseAgeStrict: true,
        catalog: {},
        catalogs: {},
        overrides: {},
        allowBuilds: {},
        minimumReleaseAgeExclude: [],
        syncInjectedDepsAfterScripts: [],
      });
      assert.equal(minimalPolicy.nodeLinker, "isolated");
      assert.deepStrictEqual(minimalPolicy.catalog, {});
      assert.deepStrictEqual(minimalPolicy.minimumReleaseAgeExclude, []);

      assert.throws(() => validateWorkspacePolicy({ nodeLinker: "" }, "bad"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
