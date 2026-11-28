import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
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

import { standardPresetVerificationScenarios } from "@boringparts/template-presets";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const allPresetArgs = standardPresetVerificationScenarios;

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

void describe("CLI distribution tarball and isolated consumer installation", () => {
  void it("packs a lightweight tarball with bundled dist, static templates, pure declarations, and executes all presets outside the repo", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "template-dist-test-"));
    try {
      const packDir = path.join(tempRoot, "packed");
      const consumerDir = path.join(tempRoot, "consumer");
      const unpackDir = path.join(tempRoot, "unpacked");

      // Pack from the built package directory using pnpm so catalog:/publishConfig are resolved.
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

      // Tarball should stay lightweight (well under 2 MB without TypeScript or nested tarballs).
      const tarballSize = statSync(tarballPath).size;
      assert.ok(
        tarballSize < 2 * 1024 * 1024,
        `Expected lightweight tarball (< 2 MiB), got ${String(tarballSize)} bytes`,
      );

      const entries = runExec("tar", ["-tzf", tarballPath], tempRoot)
        .split(/\r?\n/u)
        .filter(Boolean);

      assert.ok(entries.includes("package/dist/cli.js"));
      assert.ok(entries.includes("package/dist/main.js"));
      assert.ok(entries.includes("package/dist/main.d.ts"));
      assert.ok(entries.includes("package/templates/root/package.json"));
      assert.ok(entries.includes("package/templates/root/pnpm-workspace.yaml"));
      assert.equal(
        entries.includes("package/templates/root/rust-toolchain.toml"),
        false,
      );
      assert.ok(
        entries.includes(
          "package/templates/references/rust-bin/rust-toolchain.toml",
        ),
      );
      assert.equal(
        entries.includes("package/templates/root/oxfmt.config.ts"),
        false,
      );
      assert.equal(
        entries.includes("package/templates/root/oxlint.config.ts"),
        false,
      );
      assert.equal(
        entries.includes(
          "package/templates/references/npm-publication/package.json",
        ),
        false,
      );
      assert.ok(
        entries.includes(
          "package/templates/references/workspace-root/oxfmt.config.ts",
        ),
      );
      assert.ok(
        entries.includes(
          "package/templates/references/workspace-root/oxlint.config.ts",
        ),
      );
      assert.ok(
        entries.includes(
          "package/templates/references/workspace-root/resources/publication/config.json",
        ),
      );
      assert.ok(
        entries.includes(
          "package/templates/references/workspace-root/resources/publication/release.yml",
        ),
      );

      for (const slug of [
        "hono-api",
        "node-lib",
        "rust-bin",
        "tooling-config",
        "ts-cli",
        "ts-lib",
        "vike-db",
        "vike-deployment",
        "vike-migrations",
        "vike-web",
        "vue-app",
        "vue-hono-e2e",
        "vue-hono-web",
        "workspace-root",
      ]) {
        assert.ok(
          entries.includes(`package/templates/references/${slug}/package.json`),
          `Missing reference template in tarball: ${slug}`,
        );
      }

      // Ensure zero nested tarballs, node_modules, build caches, or runtime sqlite data.
      for (const entry of entries) {
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
          entry.includes("/.local/"),
          false,
          `Unexpected runtime .local entry: ${entry}`,
        );
        assert.equal(
          entry.includes("/target/"),
          false,
          `Unexpected Rust target entry: ${entry}`,
        );
      }

      // Inspect unpacked manifest, declaration purity, and executable bits.
      execFileSync("mkdir", ["-p", unpackDir]);
      runExec("tar", ["-xzf", tarballPath, "-C", unpackDir], tempRoot);

      const packedManifest = JSON.parse(
        readFileSync(path.join(unpackDir, "package/package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly version: string;
        readonly private: boolean;
        readonly dependencies: Record<string, string>;
        readonly bundleDependencies?: unknown;
      };
      assert.equal(packedManifest.name, "@boringparts/template");
      assert.equal(packedManifest.version, "0.4.0");
      assert.equal(packedManifest.private, false);
      assert.equal(packedManifest.bundleDependencies, undefined);
      assert.equal(
        Object.hasOwn(
          packedManifest.dependencies,
          "@boringparts/template-engine",
        ),
        false,
      );
      assert.equal(
        Object.hasOwn(
          packedManifest.dependencies,
          "@boringparts/template-presets",
        ),
        false,
      );
      assert.equal(
        Object.hasOwn(packedManifest.dependencies, "typescript"),
        false,
      );
      for (const expectedDep of [
        "@boringparts/cli-contract",
        "smol-toml",
        "validate-npm-package-name",
        "yaml",
        "zod",
      ]) {
        const version = packedManifest.dependencies[expectedDep];
        assert.ok(
          typeof version === "string" && !version.startsWith("catalog:"),
          `Expected resolved dependency version for ${expectedDep}, got ${String(version)}`,
        );
      }

      const mainDts = readFileSync(
        path.join(unpackDir, "package/dist/main.d.ts"),
        "utf8",
      );
      assert.equal(mainDts.includes("@boringparts/template-engine"), false);
      assert.equal(mainDts.includes("@boringparts/template-presets"), false);

      const cliMode = statSync(
        path.join(unpackDir, "package/dist/cli.js"),
      ).mode;
      assert.notEqual(cliMode & 0o111, 0, "dist/cli.js must be executable");
      assert.ok(
        entries.includes(
          "package/templates/references/vike-deployment/Dockerfile",
        ),
      );
      assert.ok(
        entries.includes(
          "package/templates/references/vike-deployment/Dockerfile.dockerignore",
        ),
      );
      const entrypointMode = statSync(
        path.join(
          unpackDir,
          "package/templates/references/vike-deployment/scripts/container-entrypoint.sh",
        ),
      ).mode;
      assert.notEqual(
        entrypointMode & 0o111,
        0,
        "container-entrypoint.sh must preserve executable bit",
      );

      // Install the packed tarball into a completely isolated consumer directory outside the repo.
      execFileSync("mkdir", ["-p", consumerDir]);
      writeFileSync(
        path.join(consumerDir, "package.json"),
        JSON.stringify({
          name: "isolated-consumer",
          private: true,
          type: "module",
        }),
      );
      runExec(
        "npm",
        [
          "install",
          "--ignore-scripts=false",
          "--no-audit",
          "--no-fund",
          tarballPath,
        ],
        consumerDir,
      );

      const templateBin = path.join(consumerDir, "node_modules/.bin/template");
      assert.equal(
        runExec(templateBin, ["--version"], consumerDir),
        "template 0.4.0\n",
      );

      const schemaOut = JSON.parse(
        runExec(templateBin, ["--schema"], consumerDir),
      ) as { readonly kind: string; readonly schemaVersion: string };
      assert.equal(schemaOut.kind, "directory");
      assert.equal(schemaOut.schemaVersion, "6");

      const presetsOut = JSON.parse(
        runExec(templateBin, ["presets"], consumerDir),
      ) as {
        readonly kind: string;
        readonly data: {
          readonly presets: readonly { readonly name: string }[];
        };
      };
      assert.equal(presetsOut.kind, "data");
      assert.equal(presetsOut.data.presets.length, 7);

      // Run dry-run init for all 7 single presets and both multi-package combinations.
      for (const scenario of allPresetArgs) {
        const targetDir = path.join(tempRoot, "dry-run", scenario.id);
        const initOut = JSON.parse(
          runExec(
            templateBin,
            ["init", targetDir, ...scenario.args, "--dry-run"],
            consumerDir,
          ),
        ) as {
          readonly kind: string;
          readonly variant: string;
          readonly data: {
            readonly dryRun: boolean;
            readonly files: readonly string[];
          };
        };
        assert.equal(initOut.kind, "data", scenario.id);
        assert.equal(initOut.variant, "planned", scenario.id);
        assert.equal(initOut.data.dryRun, true, scenario.id);
        assert.ok(initOut.data.files.includes("package.json"), scenario.id);
        assert.equal(existsSync(targetDir), false, scenario.id);
      }

      // Also verify the public programmatic entry point resolves without workspace private packages
      // and materializes a clean repository whose .gitignore excludes .local/ without excluding data/.
      const generatedRepoDir = path.join(tempRoot, "programmatic-init");
      const programOut = runExec(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { runCli } from "@boringparts/template";
let out = "";
const code = await runCli({
  argv: ["node", "template", "init", ${JSON.stringify(generatedRepoDir)}, "--preset", "vike-app"],
  cwd: process.cwd(),
  identity: { commandName: "template", version: "0.4.0" },
  write: ({ destination, chunk }) => { if (destination === "stdout") out += chunk; },
});
if (code !== 0) process.exit(code);
process.stdout.write(out);`,
        ],
        consumerDir,
      );
      const parsedProgram = JSON.parse(programOut) as {
        readonly variant: string;
        readonly data: { readonly packages: readonly unknown[] };
      };
      assert.equal(parsedProgram.variant, "initialized");
      assert.equal(parsedProgram.data.packages.length, 4);
      const generatedGitignore = readFileSync(
        path.join(generatedRepoDir, ".gitignore"),
        "utf8",
      );
      assert.ok(generatedGitignore.split(/\r?\n/u).includes(".local/"));
      assert.equal(generatedGitignore.split(/\r?\n/u).includes("data/"), false);
      const generatedEntrypointMode = statSync(
        path.join(
          generatedRepoDir,
          "packages/deployment/scripts/container-entrypoint.sh",
        ),
      ).mode;
      assert.notEqual(generatedEntrypointMode & 0o111, 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
