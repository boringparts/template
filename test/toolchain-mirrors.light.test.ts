import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  templateContent,
  templatePresets,
} from "@boringparts/template-content";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

const temporaryDirectories: string[] = [];

function presetFor(packageName: string) {
  const preset = templatePresets.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(preset, `Missing public preset: ${packageName}`);
  return preset;
}

function workspaceGenerator() {
  return createDefaultGenerator({ content: templateContent });
}

async function createWorkspace(presetName = "@boringparts/preset-ts-lib") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "template-toolchain-mirror-"),
  );
  temporaryDirectories.push(directory);
  const repositoryRoot = path.join(directory, "demo");
  const generator = workspaceGenerator();
  const initialized = await generator.init({
    targetRoot: repositoryRoot,
    selection: {
      presets: [{ contentIdentity: presetFor(presetName).identity }],
    },
    conventions: {
      repositoryName: "demo",
      defaultPackageScope: "demo",
    },
  });
  assert.strictEqual(
    initialized.status,
    "success",
    JSON.stringify(initialized),
  );
  return { generator, repositoryRoot };
}

async function snapshotTree(root: string): Promise<string> {
  const entries: { path: string; mode: number; content: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const filePath = path.join(directory, entry.name);
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath, file);
      } else {
        entries.push({
          path: file,
          mode: (await stat(filePath)).mode & 0o777,
          content: await readFile(filePath, "utf8"),
        });
      }
    }
  }
  await visit(root);
  return JSON.stringify(entries);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function addTsLibrary(
  generator: ReturnType<typeof workspaceGenerator>,
  repositoryRoot: string,
  leafName: string,
) {
  return await generator.add({
    repositoryRoot,
    preset: presetFor("@boringparts/preset-ts-lib").identity,
    creationInput: {
      leafName,
      packagePath: `packages/${leafName}`,
    },
  });
}

void it("plans public package addition without writing and commits in the same process", async () => {
  const { generator, repositoryRoot } = await createWorkspace();
  const before = await snapshotTree(repositoryRoot);
  const planned = await generator.planAdd({
    repositoryRoot,
    preset: presetFor("@boringparts/preset-ts-lib").identity,
    creationInput: { leafName: "planned", packagePath: "packages/planned" },
  });

  assert.equal(planned.status, "planned", JSON.stringify(planned));
  assert.deepEqual(await snapshotTree(repositoryRoot), before);
  assert.ok(planned.plan.mutations.length > 0);
  const manifestMutation = planned.plan.mutations.find(
    (mutation) => mutation.path === "packages/planned/package.json",
  );
  assert.ok(manifestMutation);
  assert.match(
    new TextDecoder().decode(manifestMutation.content),
    /@demo\/planned/u,
  );

  const committed = await generator.commitPlan(planned.plan);
  assert.equal(committed.status, "success", JSON.stringify(committed));
  assert.notDeepEqual(await snapshotTree(repositoryRoot), before);
});

void it("rejects public package addition commit when relevant facts change after planning", async () => {
  const { generator, repositoryRoot } = await createWorkspace();
  const planned = await generator.planAdd({
    repositoryRoot,
    preset: presetFor("@boringparts/preset-ts-lib").identity,
    creationInput: { leafName: "stale", packagePath: "packages/stale" },
  });

  assert.equal(planned.status, "planned", JSON.stringify(planned));
  const packagePath = path.join(repositoryRoot, "packages/stale");
  await mkdir(packagePath);
  await writeFile(path.join(packagePath, "package.json"), "consumer\n");

  const committed = await generator.commitPlan(planned.plan);

  assert.equal(committed.status, "conflict", JSON.stringify(committed));
  assert.match(
    JSON.stringify(committed),
    /Target facts changed after planning/u,
  );
  assert.match(JSON.stringify(committed), /@boringparts\/reference-ts-lib/u);
  assert.equal(
    await readFile(path.join(packagePath, "package.json"), "utf8"),
    "consumer\n",
  );
  assert.deepEqual(await readdir(packagePath), ["package.json"]);
});

void it("rejects package addition commit when generation metadata changes after planning", async () => {
  const { generator, repositoryRoot: targetRoot } = await createWorkspace();
  const planned = await generator.planAdd({
    repositoryRoot: targetRoot,
    preset: presetFor("@boringparts/preset-ts-lib").identity,
    creationInput: { leafName: "second", packagePath: "packages/second" },
  });
  assert.equal(planned.status, "planned", JSON.stringify(planned));
  if (planned.status !== "planned") return;
  await writeFile(
    path.join(targetRoot, ".template/generation.json"),
    "generation record changed after planning\n",
  );
  const committed = await generator.commitPlan(planned.plan);
  assert.equal(committed.status, "conflict", JSON.stringify(committed));
  if (committed.status !== "conflict") return;
  assert.ok(
    committed.conflicts.some(
      (conflict) => conflict.path === ".template/generation.json",
    ),
  );
  assert.equal(
    await readFile(path.join(targetRoot, ".template/generation.json"), "utf8"),
    "generation record changed after planning\n",
  );
  await assert.rejects(
    readFile(path.join(targetRoot, "packages/second/package.json")),
    { code: "ENOENT" },
  );
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

void describe("Node and Rust root toolchain mirrors", () => {
  void it("reconciles dev and deployment bootstrap mirrors from the current root pnpm declaration while preserving unrelated lines", async () => {
    const { generator, repositoryRoot } = await createWorkspace(
      "@boringparts/preset-vike-app",
    );
    const manifestPath = path.join(repositoryRoot, "package.json");
    const manifest = await readJson<{ packageManager: string }>(manifestPath);
    manifest.packageManager = "pnpm@12.8.1";
    await writeJson(manifestPath, manifest);
    const dockerfiles = [".devcontainer/Dockerfile", "Dockerfile"];
    for (const file of dockerfiles) {
      const target = path.join(repositoryRoot, file);
      const source = await readFile(target, "utf8");
      await writeFile(
        target,
        source.replace(
          /ghcr\.io\/pnpm\/pnpm:[\d.]+/u,
          "ghcr.io/pnpm/pnpm:999.0.0",
        ) + "\n# preserved user content\n",
      );
    }
    const added = await addTsLibrary(generator, repositoryRoot, "utilities");
    assert.equal(added.status, "success", JSON.stringify(added));
    if (added.status !== "success") return;
    for (const file of dockerfiles) {
      const source = await readFile(path.join(repositoryRoot, file), "utf8");
      assert.match(source, /COPY --from=ghcr\.io\/pnpm\/pnpm:12\.8\.1 /u);
      assert.ok(source.endsWith("\n# preserved user content\n"));
      assert.equal(
        added.actions.filter((action) => action.path === file).length,
        1,
      );
    }
    const next = await addTsLibrary(generator, repositoryRoot, "helpers");
    assert.equal(next.status, "success", JSON.stringify(next));
    if (next.status !== "success") return;
    assert.equal(
      next.actions.some((action) => dockerfiles.includes(action.path)),
      false,
    );
  });

  void it("initializes M1 from root Node version, reconciles drift once, and skips writes when semantically equal", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const manifestPath = path.join(repositoryRoot, "package.json");
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const manifest = await readJson<{ engines: { node: string } }>(
      manifestPath,
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
      runArgs?: unknown[];
    }>(devcontainerPath);
    assert.strictEqual(
      devcontainer.build.args.NODE_VERSION,
      manifest.engines.node,
    );

    const rootNode = "24.18.0";
    manifest.engines.node = rootNode;
    await writeJson(manifestPath, manifest);
    devcontainer.build.args.NODE_VERSION = "user-edited";
    devcontainer.runArgs = ["--init"];
    await writeJson(devcontainerPath, devcontainer);

    const added = await addTsLibrary(generator, repositoryRoot, "utilities");
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    if (added.status !== "success")
      throw new Error("Expected package addition to succeed");
    assert.strictEqual(
      added.actions.filter(
        (action) => action.path === ".devcontainer/devcontainer.json",
      ).length,
      1,
    );
    const reconciled = await readJson<{
      build: { args: Record<string, unknown> };
      runArgs?: unknown[];
    }>(devcontainerPath);
    assert.strictEqual(reconciled.build.args.NODE_VERSION, rootNode);
    assert.deepStrictEqual(reconciled.runArgs, ["--init"]);

    const next = await addTsLibrary(generator, repositoryRoot, "helpers");
    assert.strictEqual(next.status, "success", JSON.stringify(next));
    if (next.status !== "success")
      throw new Error("Expected second package addition to succeed");
    assert.strictEqual(
      next.actions.some(
        (action) => action.path === ".devcontainer/devcontainer.json",
      ),
      false,
    );
  });

  void it("preserves absent config files and omitted M1 keys during reconciliation", async () => {
    const missingFile = await createWorkspace();
    const devcontainerPath = path.join(
      missingFile.repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    await rm(devcontainerPath);
    const afterMissingFile = await addTsLibrary(
      missingFile.generator,
      missingFile.repositoryRoot,
      "utilities",
    );
    assert.strictEqual(
      afterMissingFile.status,
      "success",
      JSON.stringify(afterMissingFile),
    );
    await assert.rejects(readFile(devcontainerPath));

    const missingKey = await createWorkspace();
    const missingKeyPath = path.join(
      missingKey.repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const configuration = await readJson<{
      build: { args: Record<string, unknown> };
    }>(missingKeyPath);
    delete configuration.build.args.NODE_VERSION;
    await writeJson(missingKeyPath, configuration);
    const afterMissingKey = await addTsLibrary(
      missingKey.generator,
      missingKey.repositoryRoot,
      "utilities",
    );
    assert.strictEqual(
      afterMissingKey.status,
      "success",
      JSON.stringify(afterMissingKey),
    );
    const retained = await readJson<{
      build: { args: Record<string, unknown> };
    }>(missingKeyPath);
    assert.strictEqual(
      Object.hasOwn(retained.build.args, "NODE_VERSION"),
      false,
    );
  });

  void it("fails package addition atomically when M1 has an invalid value type", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    devcontainer.build.args.NODE_VERSION = [];
    await writeJson(devcontainerPath, devcontainer);
    const before = await snapshotTree(repositoryRoot);

    const rejected = await addTsLibrary(generator, repositoryRoot, "utilities");
    assert.strictEqual(rejected.status, "conflict");
    if (rejected.status !== "conflict")
      throw new Error(
        "Expected config type conflict to block package addition",
      );
    assert.ok(
      rejected.conflicts.some((conflict) =>
        conflict.reason.includes("non-string"),
      ),
    );
    assert.strictEqual(await snapshotTree(repositoryRoot), before);
  });

  void it("establishes M5 root declaration when adding Rust to a Node repo for the first time and preserves user edits afterward", async () => {
    const { generator, repositoryRoot } = await createWorkspace();
    const rustPreset = presetFor("@boringparts/preset-rust-bin");
    const first = await generator.add({
      repositoryRoot,
      preset: rustPreset.identity,
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });
    assert.strictEqual(first.status, "success", JSON.stringify(first));
    const toolchainPath = path.join(repositoryRoot, "rust-toolchain.toml");
    const initialToolchain = await readFile(toolchainPath, "utf8");
    const initialChannel = /^channel = "([^"]+)"$/mu.exec(
      initialToolchain,
    )?.[1];
    assert.ok(initialChannel);
    const devcontainerPath = path.join(
      repositoryRoot,
      ".devcontainer/devcontainer.json",
    );
    const devcontainer = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    assert.strictEqual(devcontainer.build.args.RUST_TOOLCHAIN, initialChannel);

    const customToolchain =
      '# local choice\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(toolchainPath, customToolchain);
    const second = await generator.add({
      repositoryRoot,
      preset: rustPreset.identity,
      creationInput: {
        leafName: "second-native",
        packagePath: "packages/second-native",
      },
    });
    assert.strictEqual(second.status, "success", JSON.stringify(second));
    assert.strictEqual(await readFile(toolchainPath, "utf8"), customToolchain);
    const updated = await readJson<{
      build: { args: Record<string, unknown> };
    }>(devcontainerPath);
    assert.strictEqual(updated.build.args.RUST_TOOLCHAIN, "nightly-2026-10-01");
  });
});
