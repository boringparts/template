import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { templatePresets } from "@boringparts/template-content";
import { renderGeneratedPnpmWorkspaceYaml } from "@boringparts/template-workspace/dependency-catalog";
import { execa } from "execa";

const packageManagerPin = "pnpm@12.8.1";
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function generateNodeOnlyProject(prefix: string): Promise<string> {
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const projectDir = path.join(workspace, "demo-lib");
  const nodeOnlyPreset = templatePresets.find(
    (preset) => preset.identity.packageName === "@boringparts/preset-ts-lib",
  );
  if (nodeOnlyPreset === undefined) {
    throw new Error(
      "Content collection is missing the TypeScript library preset",
    );
  }

  await execa(
    "node",
    [
      "--conditions=source",
      path.join(repoRoot, "apps/cli/src/cli.ts"),
      "init",
      projectDir,
      "--preset",
      nodeOnlyPreset.alias,
    ],
    { cwd: repoRoot },
  );
  return projectDir;
}

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await execa("docker", ["version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = await dockerIsAvailable();

void describe("pnpm workspace policy", () => {
  void it(
    "installs injected workspace dependencies from a frozen lockfile and syncs build outputs",
    { timeout: 120000 },
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "pnpm-workspace-policy-"));
      const provider = path.join(root, "packages/provider");
      const consumer = path.join(root, "packages/consumer");

      await Promise.all([
        mkdir(path.join(provider, "dist"), { recursive: true }),
        mkdir(consumer, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          path.join(root, "package.json"),
          `${JSON.stringify({ private: true, packageManager: packageManagerPin })}\n`,
        ),
        writeFile(
          path.join(root, "pnpm-workspace.yaml"),
          renderGeneratedPnpmWorkspaceYaml({
            dependencies: [],
            packages: ["packages/*"],
          }),
        ),
        writeFile(
          path.join(provider, "package.json"),
          `${JSON.stringify({
            name: "@fixture/provider",
            version: "0.0.0",
            scripts: {
              build:
                "node -e \"require('node:fs').copyFileSync('source.txt', 'dist/version.txt')\"",
            },
          })}\n`,
        ),
        writeFile(path.join(provider, "source.txt"), "before\n"),
        writeFile(path.join(provider, "dist/version.txt"), "before\n"),
        writeFile(
          path.join(consumer, "package.json"),
          `${JSON.stringify({
            name: "@fixture/consumer",
            version: "0.0.0",
            dependencies: { "@fixture/provider": "workspace:*" },
            dependenciesMeta: {
              "@fixture/provider": { injected: true },
            },
          })}\n`,
        ),
      ]);

      const environment = { ...process.env, CI: "1" };
      await execa("pnpm", ["install", "--lockfile-only"], {
        cwd: root,
        env: environment,
      });
      await execa(
        "pnpm",
        ["install", "--offline", "--frozen-lockfile", "--ignore-scripts"],
        { cwd: root, env: environment },
      );

      const injectedProvider = path.join(
        consumer,
        "node_modules/@fixture/provider",
      );
      assert.strictEqual(
        (await lstat(injectedProvider)).isSymbolicLink(),
        true,
      );
      const injectedTarget = await readlink(injectedProvider);
      assert.ok(injectedTarget.includes("node_modules/.pnpm/"));
      assert.ok(!injectedTarget.includes("packages/provider"));
      await writeFile(path.join(provider, "source.txt"), "after\n");
      await execa("pnpm", ["--filter", "@fixture/provider", "run", "build"], {
        cwd: root,
        env: environment,
      });

      assert.strictEqual(
        await readFile(path.join(injectedProvider, "dist/version.txt"), "utf8"),
        "after\n",
      );
    },
  );

  void it(
    "installs a generated preset according to its packageManager pin and frozen lockfile",
    { timeout: 120000 },
    async () => {
      const projectDir = await generateNodeOnlyProject("pnpm-rendered-preset-");
      const environment = { ...process.env, CI: "1" };

      await execa("pnpm", ["install", "--lockfile-only", "--prefer-offline"], {
        cwd: projectDir,
        env: environment,
      });
      await execa("pnpm", ["fetch"], { cwd: projectDir, env: environment });
      await execa("pnpm", ["install", "--offline", "--frozen-lockfile"], {
        cwd: projectDir,
        env: environment,
      });
      await execa("pnpm", ["run", "typecheck"], {
        cwd: projectDir,
        env: environment,
      });
    },
  );

  void it(
    "switches pnpm per the current root manifest and completes frozen installs for both non-root and root users",
    { timeout: 300000 },
    async (context) => {
      if (!hasDocker) {
        context.skip();
        return;
      }

      const projectDir = await generateNodeOnlyProject("pnpm-native-users-");
      // Derive expected pnpm and Node versions from the generated root manifest and M1 slot instead of hardcoding versions.
      const generatedRootManifestText = await readFile(
        path.join(projectDir, "package.json"),
        "utf8",
      );
      const generatedRootManifest = JSON.parse(generatedRootManifestText) as {
        packageManager?: string;
        engines?: { node?: string };
      };
      const generatedPackageManager = generatedRootManifest.packageManager;
      if (generatedPackageManager === undefined) {
        throw new Error("generated root manifest is missing packageManager");
      }
      const expectedPnpmVersion = generatedPackageManager.replace(
        /^pnpm@/u,
        "",
      );
      await execa("pnpm", ["install", "--lockfile-only"], {
        cwd: projectDir,
        env: { ...process.env, CI: "1" },
      });
      // Root engines.node is the source of truth for the Node version; the container's runtime node --version must match it.
      const enginesNode = generatedRootManifest.engines?.node;
      if (enginesNode === undefined) {
        throw new Error("generated root manifest is missing engines.node");
      }
      const devcontainerConfig = JSON.parse(
        await readFile(
          path.join(projectDir, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ) as { build?: { args?: Record<string, string> } };
      const nodeBuildArg = devcontainerConfig.build?.args?.NODE_VERSION;
      if (nodeBuildArg === undefined) {
        throw new Error(
          "generated devcontainer is missing build.args.NODE_VERSION",
        );
      }
      // The M1 build arg must also match root engines.node so potential drift is never treated as the expected source of truth.
      assert.strictEqual(nodeBuildArg, enginesNode);

      // Use exclusively owned, uniquely named resources for this test; never force-remove shared image IDs or run prune.
      const stamp = `${process.pid}-${Date.now()}`;
      const imageTag = `t25-pnpm-native-users:${stamp}`;
      const containerName = `t25-pnpm-native-users-run-${stamp}`;

      try {
        // The bootstrap distribution image reference is derived from the build-time root declaration without extra version args;
        // the active project version continues to come from the runtime root manifest.
        await execa(
          "docker",
          [
            "buildx",
            "build",
            "--load",
            "-t",
            imageTag,
            "--build-arg",
            `NODE_VERSION=${nodeBuildArg}`,
            "--file",
            ".devcontainer/Dockerfile",
            ".",
          ],
          { cwd: projectDir },
        );

        await execa(
          "docker",
          [
            "run",
            "-d",
            "--name",
            containerName,
            "-w",
            "/workspace",
            imageTag,
            "sleep",
            "infinity",
          ],
          { cwd: projectDir },
        );
        await execa(
          "docker",
          [
            "exec",
            "--user",
            "root",
            containerName,
            "bash",
            "-c",
            "install -d -o node -g node /workspace",
          ],
          { cwd: projectDir },
        );
        // Populate the workspace via docker cp because client and daemon bind mount paths are not guaranteed to match.
        const supplyRootManifest = async (contents: string): Promise<void> => {
          const transfer = path.join(
            projectDir,
            ".root-manifest-transfer.json",
          );
          await writeFile(transfer, contents);
          await execa("docker", [
            "cp",
            transfer,
            `${containerName}:/workspace/package.json`,
          ]);
          await execa(
            "docker",
            [
              "exec",
              "--user",
              "root",
              containerName,
              "chown",
              "node:node",
              "/workspace/package.json",
            ],
            { cwd: projectDir },
          );
        };
        await supplyRootManifest(generatedRootManifestText);
        await execa("docker", [
          "cp",
          `${projectDir}/.`,
          `${containerName}:/workspace`,
        ]);
        await execa("docker", [
          "exec",
          "--user",
          "root",
          containerName,
          "chown",
          "-R",
          "node:node",
          "/workspace",
        ]);

        // Observe the actual node --version inside the container; the runtime version must match
        // root engines.node rather than relying only on the build arg text.
        const nodeRuntime = await execa(
          "docker",
          [
            "exec",
            "--user",
            "node",
            containerName,
            "bash",
            "-c",
            "node --version",
          ],
          { cwd: projectDir },
        );
        assert.strictEqual(
          nodeRuntime.stdout.trim().replace(/^v/u, ""),
          enginesNode,
        );

        // Run the non-root cold path first so the node user exercises its own writable native version cache
        // before any root pnpm call can mask non-root permission failures.
        const nodeCold = await execa(
          "docker",
          [
            "exec",
            "--user",
            "node",
            containerName,
            "bash",
            "-c",
            "cd /workspace && pnpm --version",
          ],
          { cwd: projectDir },
        );
        assert.strictEqual(nodeCold.stdout.trim(), expectedPnpmVersion);
        await execa(
          "docker",
          [
            "exec",
            "--user",
            "node",
            containerName,
            "pnpm",
            "install",
            "--frozen-lockfile",
          ],
          { cwd: projectDir },
        );

        // Run the root cold path independently so each user resolves from its own native cache.
        const rootCold = await execa(
          "docker",
          [
            "exec",
            "--user",
            "root",
            containerName,
            "bash",
            "-c",
            "cd /workspace && pnpm --version",
          ],
          { cwd: projectDir },
        );
        assert.strictEqual(rootCold.stdout.trim(), expectedPnpmVersion);

        // Verify global installs and PATH using a dependency-free local package without contacting a registry.
        for (const user of ["root", "node"]) {
          const globalTool = await execa("docker", [
            "exec",
            "--user",
            user,
            containerName,
            "bash",
            "-c",
            `set -eu
probe=$(mktemp -d)
printf '%s' '{"name":"container-global-probe","version":"1.0.0","bin":{"container-global-probe":"cli.cjs"}}' > "$probe/package.json"
printf '%s\\n' '#!/usr/bin/env node' 'console.log("GLOBAL_BIN_OK")' > "$probe/cli.cjs"
chmod +x "$probe/cli.cjs"
pnpm add --global --offline "$probe"
container-global-probe`,
          ]);
          assert.match(globalTool.stdout, /GLOBAL_BIN_OK/u);
        }

        // Verify native version switching without rebuilding the image by pointing the manifest to a different pnpm version.
        await supplyRootManifest(
          JSON.stringify({
            ...generatedRootManifest,
            packageManager: packageManagerPin,
          }),
        );
        const nodeRepointed = await execa(
          "docker",
          [
            "exec",
            "--user",
            "node",
            containerName,
            "bash",
            "-c",
            "cd /workspace && pnpm --version",
          ],
          { cwd: projectDir },
        );
        assert.strictEqual(
          nodeRepointed.stdout.trim(),
          packageManagerPin.replace(/^pnpm@/u, ""),
        );
        await writeFile(
          path.join(projectDir, "package.json"),
          JSON.stringify({
            ...generatedRootManifest,
            packageManager: packageManagerPin,
          }),
        );
        await execa("pnpm", ["install", "--lockfile-only"], {
          cwd: projectDir,
          env: { ...process.env, CI: "1" },
        });
        await execa("docker", [
          "cp",
          path.join(projectDir, "pnpm-lock.yaml"),
          `${containerName}:/workspace/pnpm-lock.yaml`,
        ]);
        await execa("docker", [
          "exec",
          "--user",
          "root",
          containerName,
          "chown",
          "node:node",
          "/workspace/pnpm-lock.yaml",
        ]);
        await execa(
          "docker",
          [
            "exec",
            "--user",
            "node",
            containerName,
            "pnpm",
            "install",
            "--frozen-lockfile",
          ],
          { cwd: projectDir },
        );

        // Verify the shared tool layer works for both users (system git default branch and TLS CA bundle).
        for (const user of ["node", "root"]) {
          const sanity = await execa(
            "docker",
            [
              "exec",
              "--user",
              user,
              containerName,
              "bash",
              "-c",
              "test -s /etc/ssl/certs/ca-certificates.crt && cd $(mktemp -d) && git init --quiet && git branch --show-current",
            ],
            { cwd: projectDir },
          );
          assert.strictEqual(sanity.stdout.trim(), "main");
        }
      } finally {
        await execa("docker", ["rm", "-f", containerName], { reject: false });
        await execa("docker", ["rmi", imageTag], { reject: false });
      }
    },
  );
});
