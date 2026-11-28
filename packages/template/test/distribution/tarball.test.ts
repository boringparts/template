import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function runExec(
  command: string,
  args: readonly string[],
  cwd: string,
): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

void describe("@boringparts/template distribution tarball and out-of-repo consumer installation", () => {
  void it("runs under locked Node 24.0.0, packs pure JS + d.ts with yaml-only runtime dependency, and runs isolated single-package and snapshot consumers", () => {
    assert.equal(process.versions.node, "24.0.0");
    const tempRoot = mkdtempSync(path.join(tmpdir(), "template-dist-test-"));
    try {
      const packDir = path.join(tempRoot, "packed");
      const unpackDir = path.join(tempRoot, "unpacked");
      const consumerDir = path.join(tempRoot, "consumer");

      const packStdout = runExec(
        "pnpm",
        ["pack", "--pack-destination", packDir],
        packageRoot,
      ).trim();
      const tarballPath = packStdout.split(/\r?\n/u).at(-1)!;
      assert.ok(
        existsSync(tarballPath),
        `Packed tarball missing: ${tarballPath}`,
      );

      const tarballSize = statSync(tarballPath).size;
      assert.ok(
        tarballSize > 0 && tarballSize < 512 * 1024,
        `Expected lightweight tarball (< 512 KiB), got ${String(tarballSize)} bytes`,
      );

      const entries = runExec("tar", ["-tzf", tarballPath], tempRoot)
        .split(/\r?\n/u)
        .filter(Boolean);

      assert.ok(entries.includes("package/dist/index.js"));
      assert.ok(entries.includes("package/dist/index.d.ts"));
      for (const entry of entries) {
        assert.equal(
          entry.startsWith("package/templates/"),
          false,
          `Unexpected templates entry: ${entry}`,
        );
        assert.equal(
          entry.startsWith("package/src/"),
          false,
          `Unexpected src entry: ${entry}`,
        );
        assert.equal(
          entry.endsWith(".tgz"),
          false,
          `Unexpected nested tarball: ${entry}`,
        );
        assert.equal(
          entry.includes("node_modules/"),
          false,
          `Unexpected node_modules entry: ${entry}`,
        );
        assert.equal(
          entry.endsWith(".tsbuildinfo"),
          false,
          `Unexpected tsbuildinfo entry: ${entry}`,
        );
      }

      mkdirSync(unpackDir, { recursive: true });
      runExec("tar", ["-xzf", tarballPath, "-C", unpackDir], tempRoot);

      const sourceManifest: unknown = JSON.parse(
        readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      );
      assert.ok(
        typeof sourceManifest === "object" &&
          sourceManifest !== null &&
          "version" in sourceManifest &&
          typeof sourceManifest.version === "string",
      );
      const packedManifest = JSON.parse(
        readFileSync(path.join(unpackDir, "package/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly version: string;
        readonly private: boolean;
        readonly bin?: unknown;
        readonly engines?: { readonly node?: string };
        readonly dependencies: Record<string, string>;
        readonly exports: Record<string, unknown>;
      };
      assert.equal(packedManifest.name, "@boringparts/template");
      assert.equal(packedManifest.version, sourceManifest.version);
      assert.equal(packedManifest.private, false);
      assert.equal(packedManifest.bin, undefined);
      assert.deepStrictEqual(packedManifest.engines, { node: ">=24.0.0" });
      assert.deepStrictEqual(Object.keys(packedManifest.dependencies), [
        "yaml",
      ]);
      assert.ok(
        !packedManifest.dependencies.yaml!.startsWith("catalog:") &&
          !packedManifest.dependencies.yaml!.startsWith("workspace:"),
      );
      assert.deepStrictEqual(packedManifest.exports, {
        ".": {
          types: "./dist/index.d.ts",
          default: "./dist/index.js",
        },
        "./package.json": "./package.json",
      });

      const indexDts = readFileSync(
        path.join(unpackDir, "package/dist/index.d.ts"),
        "utf8",
      );
      for (const forbidden of [
        "@boringparts/cli-contract",
        "smol-toml",
        "zod",
        "references/",
      ]) {
        assert.equal(
          indexDts.includes(forbidden),
          false,
          `Public declaration leaked ${forbidden}`,
        );
      }

      // Install the packed tarball into an isolated out-of-repo directory with strict engine check.
      mkdirSync(consumerDir, { recursive: true });
      writeFileSync(
        path.join(consumerDir, "package.json"),
        JSON.stringify({
          name: "out-of-repo-consumer",
          private: true,
          type: "module",
        }),
      );
      runExec(
        "npm",
        [
          "install",
          "--engine-strict",
          "--ignore-scripts=false",
          "--no-audit",
          "--no-fund",
          tarballPath,
        ],
        consumerDir,
      );

      const consumerScript = `
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  bindTemplateCatalog,
  buildProjectProjection,
  createPackagedSourceContext,
  createWorkspaceSourceContext,
  definePreset,
  planProject,
  readPnpmWorkspaceCatalog,
  summarizePresets,
  validateWorkspacePolicy,
  writeProjectProjection,
  writeTemplateSnapshot,
} from "@boringparts/template";

const workDir = ${JSON.stringify(path.join(tempRoot, "consumer-run"))};
const tplDir = path.join(workDir, "tpl");
const rootTpl = path.join(tplDir, "root");
mkdirSync(path.join(rootTpl, "resources"), { recursive: true });
writeFileSync(path.join(rootTpl, "package.json"), JSON.stringify({
  name: "synth-root",
  private: true,
  scripts: { lint: "oxlint ." },
  devDependencies: { turbo: "^2.11.13" },
  devEngines: { runtime: { name: "node", version: "24.0.0" } },
  packageManager: "pnpm@12.21.0",
}));
writeFileSync(path.join(rootTpl, "turbo.json"), JSON.stringify({
  tasks: { lint: { tags: ["quality:light"] } },
}));
writeFileSync(path.join(rootTpl, "resources", "gitignore"), "node_modules/\\ndist/\\n");
writeFileSync(path.join(rootTpl, "resources", "base.Dockerfile"), "FROM node:24.0.0-bookworm-slim\\n");
writeFileSync(path.join(rootTpl, "resources", "tpl.json"), JSON.stringify({ name: "x", mounts: [] }));

const pkgTpl = path.join(tplDir, "app");
mkdirSync(path.join(pkgTpl, "bin"), { recursive: true });
writeFileSync(path.join(pkgTpl, "package.json"), JSON.stringify({
  name: "synth-app",
  bin: { "ref-app": "./bin/run.sh" },
  dependencies: { yaml: "^2.9.0" },
}));
writeFileSync(path.join(pkgTpl, "bin", "run.sh"), "#!/bin/sh\\necho hi\\n");
chmodSync(path.join(pkgTpl, "bin", "run.sh"), 0o755);

const workspaceRoot = {
  sourceDir: "root",
  resources: [{ sourcePath: "resources/gitignore", targetPath: ".gitignore" }],
  devcontainerBase: {
    dockerfileSourcePath: "resources/base.Dockerfile",
    templateSourcePath: "resources/tpl.json",
  },
};
const presets = [
  definePreset({
    alias: "app",
    title: "App",
    description: "CLI app",
    topology: "configurable-primary-package",
    nodes: [{
      nodeId: "app",
      defaultName: "app",
      defaultPath: "packages/app",
      referencePackage: { sourceDir: "app", role: "cli-tool", publishable: false },
    }],
  }),
];
const policy = validateWorkspacePolicy({
  nodeLinker: "isolated",
  preferSymlinkedExecutables: true,
  shellEmulator: true,
  autoInstallPeers: false,
  injectWorkspacePackages: false,
  dedupeInjectedDeps: false,
  minimumReleaseAge: 1440,
  minimumReleaseAgeStrict: true,
});

assert.equal(summarizePresets(presets)[0].name, "app");
const bound = bindTemplateCatalog({
  source: createWorkspaceSourceContext(tplDir),
  workspaceRoot,
  presets,
  workspacePolicy: policy,
});
const snapshotDir = path.join(workDir, "snapshot");
const snap = bound.writeTemplateSnapshot(snapshotDir);
assert.equal(existsSync(snap.workspacePolicyPath), true);

// Delete original templates and verify packaged source context works independently
rmSync(tplDir, { recursive: true, force: true });
const packagedSource = createPackagedSourceContext(snapshotDir);
const packagedPolicy = packagedSource.readWorkspacePolicy();
const outParent = path.join(workDir, "out");
mkdirSync(outParent, { recursive: true });

const planned = planProject({
  cwd: outParent,
  dir: "demo-ws",
  presetSpecs: ["app:my-bin"],
  source: packagedSource,
  workspaceRoot,
  presets,
  workspacePolicy: packagedPolicy,
});
assert.equal(planned.ok, true);
const projection = buildProjectProjection(planned.blueprint, {
  source: packagedSource,
  workspacePolicy: packagedPolicy,
});
const workspaceEntry = projection.entries.find((e) => e.path === "pnpm-workspace.yaml");
assert.ok(workspaceEntry);
const wsText = new TextDecoder().decode(workspaceEntry.content);
assert.equal(wsText.includes("catalog:"), false);
assert.equal(wsText.includes("catalogs:"), false);
assert.ok(wsText.includes("nodeLinker: isolated\\n\\npreferSymlinkedExecutables: true"));

const materialized = writeProjectProjection(projection);
assert.deepStrictEqual(materialized, { ok: true });
const binMode = statSync(path.join(outParent, "demo-ws/packages/my-bin/bin/run.sh")).mode;
assert.notEqual(binMode & 0o111, 0);
const pkgJson = JSON.parse(readFileSync(path.join(outParent, "demo-ws/packages/my-bin/package.json"), "utf8"));
assert.deepStrictEqual(pkgJson.bin, { "my-bin": "./bin/run.sh" });
assert.equal(typeof readPnpmWorkspaceCatalog, "function");
`;
      runExec(
        process.execPath,
        ["--input-type=module", "-e", consumerScript],
        consumerDir,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
