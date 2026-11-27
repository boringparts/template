import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { LoadedContentMember } from "@boringparts/template-core/content-identity";
import { definePreset } from "@boringparts/template-core/preset-definition";
import { loadContentSource } from "@boringparts/template-generator/content-source";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";
import { releaseToolchainSnapshot } from "@boringparts/template-workspace/release-toolchain-snapshot";

const content = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    "@boringparts/reference-workspace-root/template",
    "@boringparts/reference-rust-bin/template",
    "@boringparts/reference-tooling-config/template",
    "@boringparts/preset-rust-bin/template",
  ],
});

const member = (kind: "preset" | "reference", packageName: string) => {
  const found = content.find(
    (item) => item.kind === kind && item.identity.packageName === packageName,
  );
  assert.ok(
    found,
    `Explicit content collection is missing ${kind} ${packageName}`,
  );
  return found;
};

const rust = member("reference", "@boringparts/reference-rust-bin");
const root = member("reference", "@boringparts/reference-workspace-root");
const rustPreset = member("preset", "@boringparts/preset-rust-bin");
const aliasOnlyRustPresetDefinition = definePreset({
  metadata: {
    alias: "rust-alias-only",
    title: "Rust Alias Preset",
    description:
      "Selects Rust content solely through the reference package public alias.",
  },
  operations: ["init", "add"],
  nodes: {
    binary: { reference: { alias: "binary", instance: "independent" } },
  },
});
const aliasOnlyRustPreset: LoadedContentMember<
  typeof aliasOnlyRustPresetDefinition,
  "preset"
> = {
  identity: {
    namespace: "boringparts",
    packageName: "@boringparts/preset-rust-alias-only",
    exportPath: "./template",
  },
  kind: "preset",
  alias: aliasOnlyRustPresetDefinition.metadata.alias,
  definition: aliasOnlyRustPresetDefinition,
  source: {
    specifier: "@boringparts/preset-rust-alias-only/template",
    moduleURL: import.meta.url,
    manifestURL: import.meta.url,
  },
};
const conventions = { repositoryName: "demo", defaultPackageScope: "demo" };
const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Rust native content public composition behavior", () => {
  void it("projects Cargo files and shared root toolchain from the native owner on init", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-init-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: rustPreset.identity }] },
      conventions,
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      rootManifest.scripts["toolchain:prepare"],
      "cargo --version",
    );
    const rootTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as { tasks: Record<string, unknown> };
    assert.deepStrictEqual(rootTurbo.tasks["//#toolchain:prepare"], {
      cache: false,
      tags: ["work:preparation"],
    });

    const cargoManifest = await readFile(
      path.join(targetRoot, "packages/app/Cargo.toml"),
      "utf8",
    );
    assert.match(cargoManifest, /name = "app"/u);
    const cargoLock = await readFile(
      path.join(targetRoot, "packages/app/Cargo.lock"),
      "utf8",
    );
    assert.match(cargoLock, /name = "app"/u);
    const packageManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/app/package.json"),
        "utf8",
      ),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(
      packageManifest.scripts.lint,
      "cargo clippy --workspace --all-targets -- -D warnings",
    );
    assert.strictEqual(packageManifest.scripts.test, "cargo test --workspace");
    assert.strictEqual(packageManifest.scripts.typecheck, undefined);
    assert.strictEqual(packageManifest.scripts["lint:fix"], undefined);
    const packageTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "packages/app/turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn?: readonly string[] }> };
    assert.deepStrictEqual(packageTurbo.tasks.lint?.dependsOn, [
      "//#toolchain:prepare",
    ]);
    assert.strictEqual(
      (await stat(path.join(targetRoot, "packages/app/src/main.rs"))).isFile(),
      true,
    );

    const toolchain = await readFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      "utf8",
    );
    assert.match(
      toolchain,
      new RegExp(`channel = "${releaseToolchainSnapshot.rustVersion}"`, "u"),
    );
    assert.ok(!toolchain.includes("template/rust-toolchain.toml"));
    const devcontainer = JSON.parse(
      await readFile(
        path.join(targetRoot, ".devcontainer/devcontainer.json"),
        "utf8",
      ),
    ) as {
      build: { args: Record<string, string> };
      mounts: { source?: string; target?: string }[];
    };
    assert.strictEqual(
      devcontainer.build.args.RUST_TOOLCHAIN,
      releaseToolchainSnapshot.rustVersion,
    );
    assert.ok(
      devcontainer.mounts.some(
        ({ source }) => source === "${devcontainerId}-cargo-registry",
      ),
    );
    assert.ok(
      initialized.ownerFacts.container.probes.some(
        ({ command }) => command === "cargo",
      ),
    );
  });

  void it("preserves existing toolchain bytes and updates the runtime environment when first adding Rust to a non-Rust root", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-add-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const customDeclaration =
      '# local setting\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt"]\nprofile = "minimal"\n';
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      customDeclaration,
    );
    const added = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: rust.identity,
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      customDeclaration,
    );
    assert.strictEqual(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ).build.args.RUST_TOOLCHAIN,
      "nightly-2026-10-01",
    );
    assert.ok(
      JSON.parse(
        await readFile(
          path.join(targetRoot, ".devcontainer/devcontainer.json"),
          "utf8",
        ),
      ).mounts.some((mount: { source?: string }) =>
        mount.source?.includes("cargo-registry"),
      ),
    );
    assert.match(
      await readFile(
        path.join(targetRoot, "packages/native/Cargo.toml"),
        "utf8",
      ),
      /name = "native"/u,
    );
  });

  void it("rejects add without modifying other files when an existing Rust root declaration is missing", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-missing-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: rustPreset.identity }] },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    await rm(path.join(targetRoot, "rust-toolchain.toml"));
    const before = await readFile(path.join(targetRoot, "package.json"));

    const rejected = await generator.add({
      repositoryRoot: targetRoot,
      contentIdentity: rust.identity,
      creationInput: { leafName: "another", packagePath: "packages/another" },
    });
    assert.strictEqual(rejected.status, "operation-failure");
    assert.deepStrictEqual(
      await readFile(path.join(targetRoot, "package.json")),
      before,
    );
    await assert.rejects(
      access(path.join(targetRoot, "packages/another/Cargo.toml")),
      { code: "ENOENT" },
    );
  });

  void it("invalidates an in-process plan when the root toolchain changes after planning", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-stale-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      '[toolchain]\nchannel = "stable"\ncomponents = ["rustfmt", "clippy"]\n',
    );

    const planned = await generator.planAdd({
      repositoryRoot: targetRoot,
      contentIdentity: rust.identity,
      creationInput: { leafName: "native", packagePath: "packages/native" },
    });
    assert.strictEqual(planned.status, "planned", JSON.stringify(planned));
    if (planned.status !== "planned") return;

    const changedDeclaration =
      '[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt", "clippy"]\n';
    await writeFile(
      path.join(targetRoot, "rust-toolchain.toml"),
      changedDeclaration,
    );
    const committed = await generator.commitPlan(planned.plan);
    assert.notStrictEqual(committed.status, "success");
    assert.strictEqual(
      await readFile(path.join(targetRoot, "rust-toolchain.toml"), "utf8"),
      changedDeclaration,
    );
    await assert.rejects(
      access(path.join(targetRoot, "packages/native/Cargo.toml")),
      { code: "ENOENT" },
    );
  });

  void it("reads and locks the root toolchain along the preset graph when adding Rust via an alias node", async () => {
    const targetRoot = await createTargetRoot("template-rust-bin-alias-add-");
    const generator = createDefaultGenerator({
      content: [...content, aliasOnlyRustPreset],
    });
    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "root", contentIdentity: root.identity }],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );

    const customDeclaration =
      '# local setting\n[toolchain]\nchannel = "nightly-2026-10-01"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';
    const declarationPath = path.join(targetRoot, "rust-toolchain.toml");
    await writeFile(declarationPath, customDeclaration);

    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: aliasOnlyRustPreset.identity,
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      await readFile(declarationPath, "utf8"),
      customDeclaration,
    );

    const planned = await generator.planAdd({
      repositoryRoot: targetRoot,
      preset: aliasOnlyRustPreset.identity,
      creationInput: { leafName: "second", packagePath: "packages/second" },
    });
    assert.strictEqual(planned.status, "planned", JSON.stringify(planned));
    if (planned.status !== "planned") return;

    const changedDeclaration =
      '[toolchain]\nchannel = "nightly-2026-10-02"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';
    await writeFile(declarationPath, changedDeclaration);
    const committed = await generator.commitPlan(planned.plan);
    assert.notStrictEqual(committed.status, "success");
    assert.strictEqual(
      await readFile(declarationPath, "utf8"),
      changedDeclaration,
    );
    await assert.rejects(
      access(path.join(targetRoot, "packages/second/Cargo.toml")),
      { code: "ENOENT" },
    );
  });
});
