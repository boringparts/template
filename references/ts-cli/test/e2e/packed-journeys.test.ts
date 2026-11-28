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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runJourneys } from "./run-journeys.ts";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

type PnpmListNode = {
  readonly version?: string;
  readonly path?: string;
  readonly dependencies?: Readonly<Record<string, PnpmListNode>>;
};

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

function packToDir(pkgDir: string, packDir: string): string {
  const packStdout = runExec(
    "pnpm",
    ["pack", "--pack-destination", packDir],
    pkgDir,
  ).trim();
  const tarballPath = packStdout.split(/\r?\n/u).at(-1)!;
  assert.ok(existsSync(tarballPath), `Packed tarball missing: ${tarballPath}`);
  return tarballPath;
}

/**
 * Collects local workspace runtime dependencies (`version: "link:..."`) recursively
 * so multi-package workspaces (e.g. `ts-cli` linked to a local library) install offline
 * into the isolated consumer directory without querying npm for unpublished packages.
 */
function collectWorkspaceRuntimeDependencies(
  pkgDir: string,
): ReadonlyMap<string, string> {
  const parsed = JSON.parse(
    runExec("pnpm", ["list", "--prod", "--depth=Infinity", "--json"], pkgDir),
  ) as readonly PnpmListNode[];
  const collected = new Map<string, string>();
  const visited = new Set<string>();

  const walk = (deps: Readonly<Record<string, PnpmListNode>> | undefined) => {
    if (deps === undefined) {
      return;
    }
    for (const [depName, node] of Object.entries(deps)) {
      const visitKey = `${depName}\u0000${node.path ?? ""}`;
      if (visited.has(visitKey)) {
        continue;
      }
      visited.add(visitKey);
      if (
        typeof node.version === "string" &&
        node.version.startsWith("link:") &&
        typeof node.path === "string"
      ) {
        collected.set(depName, node.path);
      }
      walk(node.dependencies);
    }
  };

  for (const rootNode of parsed) {
    walk(rootNode.dependencies);
  }
  return collected;
}

void test(
  "runs all packed CLI journeys in an isolated consumer under Node 24.0.0",
  { timeout: 180_000 },
  async () => {
    assert.equal(process.versions.node, "24.0.0");

    const sourceManifest = JSON.parse(
      readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly bin: Readonly<Record<string, string>>;
      readonly version?: string;
    };
    const identity = cliCommandIdentity(sourceManifest);

    const tempRoot = mkdtempSync(path.join(tmpdir(), "ts-cli-dist-test-"));
    try {
      const packDir = path.join(tempRoot, "packed");
      const unpackDir = path.join(tempRoot, "unpacked");
      const consumerDir = path.join(tempRoot, "consumer");
      mkdirSync(packDir, { recursive: true });
      mkdirSync(unpackDir, { recursive: true });
      mkdirSync(consumerDir, { recursive: true });

      const tarballPath = packToDir(packageRoot, packDir);
      const workspaceDeps = collectWorkspaceRuntimeDependencies(packageRoot);
      const overrides: Record<string, string> = {};
      for (const [depName, depDir] of workspaceDeps) {
        const depTarballPath = packToDir(depDir, packDir);
        overrides[depName] = `file:${depTarballPath}`;
      }

      const entries = runExec("tar", ["-tzf", tarballPath], tempRoot)
        .split(/\r?\n/u)
        .filter(Boolean);
      assert.ok(entries.includes("package/dist/cli.js"));
      assert.ok(entries.includes("package/dist/main.js"));
      assert.ok(entries.includes("package/package.json"));
      for (const entry of entries) {
        assert.equal(
          entry.startsWith("package/src/"),
          false,
          `Unexpected source entry in tarball: ${entry}`,
        );
        assert.equal(
          entry.startsWith("package/test/"),
          false,
          `Unexpected test entry in tarball: ${entry}`,
        );
        assert.equal(
          entry.includes("node_modules/"),
          false,
          `Unexpected node_modules entry in tarball: ${entry}`,
        );
      }

      runExec("tar", ["-xzf", tarballPath, "-C", unpackDir], tempRoot);
      const packedManifest = JSON.parse(
        readFileSync(path.join(unpackDir, "package/package.json"), "utf8"),
      ) as {
        readonly bin?: Readonly<Record<string, string>>;
        readonly engines?: { readonly node?: string };
      };
      assert.deepStrictEqual(packedManifest.bin, {
        [identity.commandName]: "./dist/cli.js",
      });
      assert.deepStrictEqual(packedManifest.engines, { node: ">=24.0.0" });
      if (process.platform !== "win32") {
        const unpackedCliMode = statSync(
          path.join(unpackDir, "package/dist/cli.js"),
        ).mode;
        assert.notEqual(
          unpackedCliMode & 0o111,
          0,
          "dist/cli.js must be executable",
        );
      }

      writeFileSync(
        path.join(consumerDir, "package.json"),
        JSON.stringify({
          name: "isolated-cli-consumer",
          private: true,
          type: "module",
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
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

      const packedBin = path.join(
        consumerDir,
        "node_modules",
        ".bin",
        identity.commandName,
      );
      assert.ok(
        existsSync(packedBin),
        `Missing installed binary: ${packedBin}`,
      );
      if (process.platform !== "win32") {
        assert.notEqual(
          statSync(packedBin).mode & 0o111,
          0,
          "Installed CLI binary must preserve executable bit",
        );
      }

      const passed = await runJourneys({ mode: "packed", packedBin });
      assert.notStrictEqual(passed.length, 0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
