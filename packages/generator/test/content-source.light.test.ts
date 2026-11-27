import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

import type { Composition } from "@boringparts/template-core/composition";
import {
  createContentIndex,
  type ContentIdentity,
  type LoadedContentMember,
} from "@boringparts/template-core/content-identity";
import type { PackageDefinitionId } from "@boringparts/template-core/project-blueprint";

import { loadContentSource } from "../src/content-source.ts";
import { createGenerator } from "../src/index.ts";

const temporaryDirectories: string[] = [];

async function createSource(options: {
  readonly namespace: string;
  readonly body: string;
}): Promise<readonly LoadedContentMember[]> {
  const root = await mkdtemp(path.join(tmpdir(), "template-content-source-"));
  temporaryDirectories.push(root);
  const sourceRoot = path.join(root, "collection");
  const packageRoot = path.join(root, "authors", options.namespace, "shared");
  await mkdir(path.join(sourceRoot, "node_modules", "@example"), {
    recursive: true,
  });
  await mkdir(path.join(packageRoot, "template"), { recursive: true });
  await symlink(
    packageRoot,
    path.join(sourceRoot, "node_modules", "@example", "shared"),
    "dir",
  );
  await writeFile(
    path.join(sourceRoot, "collection.mjs"),
    "export const resolve = (specifier) => import.meta.resolve(specifier);\n",
  );
  const manifest = {
    name: "@example/shared",
    version: "1.0.0",
    type: "module",
    exports: {
      "./reference": "./package.json",
      "./template": {
        source: "./template/definition.mjs",
        default: "./template/definition.mjs",
      },
    },
  };
  await writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2),
  );
  await writeFile(
    path.join(packageRoot, "template", "definition.mjs"),
    [
      'import manifest from "../package.json" with { type: "json" };',
      `export const referencePackage = { alias: "shared", instance: "independent", manifest, value: ${JSON.stringify(options.body)}, prepare() { return { resources: [], facts: {} }; }, parseCreationInput() { return {}; }, createDefinition() { return { name: "shared", path: "packages/shared", role: "shared-library" }; }, evaluate({ packageDefinitionId }) { return { packageDefinitionId, files: [], facts: {} }; } };`,
      "",
    ].join("\n"),
  );
  const source = await import(
    pathToFileURL(path.join(sourceRoot, "collection.mjs")).href
  );
  return await loadContentSource({
    namespace: options.namespace,
    resolve: source.resolve as (specifier: string) => string,
    members: ["@example/shared/template"],
  });
}

function testComposition(): Composition {
  const identity: ContentIdentity = {
    namespace: "test",
    packageName: "@fixture/test-composition",
    exportPath: "./composition",
  };
  return {
    identity,
    parseConventions(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("Conventions must be an object");
      }
      return {};
    },
    resolve({ conventions }) {
      return {
        stableCommon: conventions,
        packageInputs: new Map<PackageDefinitionId, unknown>(),
      };
    },
    combine() {
      return { facts: {} };
    },
  };
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

void describe("typed content source public entry", () => {
  void it("preserves concrete reference package, preset definition, and author extension types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "template-content-typed-"));
    temporaryDirectories.push(root);
    const manifests = new Map([
      ["@example/shared", "@example/shared"],
      ["@example/preset", "@example/preset"],
    ]);
    for (const packageName of manifests.values()) {
      const packageRoot = path.join(root, packageName.replaceAll("/", "+"));
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: packageName,
          exports: { "./template": {}, "./reference": "./package.json" },
        }),
      );
    }
    const referenceURL = import.meta
      .resolve("./content-source-reference.fixture.ts");
    const presetURL = import.meta.resolve("./content-source-preset.fixture.ts");
    const members = await loadContentSource({
      namespace: "typed",
      resolve(specifier) {
        const parts = specifier.split("/");
        const packageName = parts.slice(0, 2).join("/");
        const exportPath = parts.slice(2).join("/");
        const packageRoot = path.join(root, packageName!.replaceAll("/", "+"));
        return pathToFileURL(
          exportPath === "reference"
            ? path.join(packageRoot, "package.json")
            : fileURLToPath(
                packageName === "@example/shared" ? referenceURL : presetURL,
              ),
        ).href;
      },
      members: [
        {
          specifier: "@example/shared/template",
          load: () => import("./content-source-reference.fixture.ts"),
        },
        {
          specifier: "@example/preset/template",
          load: () => import("./content-source-preset.fixture.ts"),
        },
      ],
    });

    const reference = members[0];
    if (reference.kind === "reference") {
      const extension: "from-reference" = reference.definition.externalMarker;
      const preparedFacts: "prepared-reference" =
        reference.definition.prepare().facts.phase;
      assert.equal(extension, "from-reference");
      assert.equal(preparedFacts, "prepared-reference");
      // @ts-expect-error Reference package-specific fields do not belong to other member kinds.
      const invalid: number = reference.definition.externalMarker;
      void invalid;
    }

    const preset = members[1];
    if (preset.kind === "preset") {
      const presetField: 42 = preset.definition.externalPresetField;
      assert.equal(presetField, 42);
      // @ts-expect-error Preset definitions preserve their own metadata types.
      const invalid: string = preset.definition.externalPresetField;
      void invalid;
    }
  });

  void it("rejects a type loader callback that points to a different public module than resolver", async () => {
    const alpha = await createSource({ namespace: "alpha", body: "alpha" });
    assert.ok(alpha[0]);
    const root = await mkdtemp(
      path.join(tmpdir(), "template-content-mismatch-"),
    );
    temporaryDirectories.push(root);
    const packageRoot = path.join(root, "package");
    await mkdir(packageRoot, { recursive: true });
    const manifest = {
      name: "@example/shared",
      exports: { "./template": {}, "./reference": "./package.json" },
    };
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify(manifest),
    );
    await assert.rejects(
      loadContentSource({
        namespace: "mismatch",
        resolve(specifier) {
          return specifier.endsWith("/reference")
            ? pathToFileURL(path.join(packageRoot, "package.json")).href
            : import.meta.resolve("./content-source-reference.fixture.ts");
        },
        members: [
          {
            specifier: "@example/shared/template",
            load: async () => await import(alpha[0]!.source.moduleURL),
          },
        ],
      }),
      /Type loader callback .* did not return the same module as the resolved public code entry/u,
    );
  });
});

void describe("loading content source public entries", () => {
  void it("loads a valid reference definition and completes planning and initialization", async () => {
    const members = await createSource({
      namespace: "new-contract",
      body: "valid",
    });
    const member = members[0];
    assert.ok(member);
    const generator = createGenerator({
      content: members,
      composition: testComposition(),
    });
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-content-source-target-"),
    );
    temporaryDirectories.push(targetRoot);

    const planned = await generator.planInit({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "shared", contentIdentity: member.identity }],
      },
      conventions: {},
      operationFacts: null,
    });
    assert.equal(planned.status, "planned", JSON.stringify(planned));

    const initialized = await generator.init({
      targetRoot,
      selection: {
        roots: [{ nodeIdentity: "shared", contentIdentity: member.identity }],
      },
      conventions: {},
      operationFacts: null,
    });
    assert.equal(initialized.status, "success", JSON.stringify(initialized));
  });

  void it("loads same-name packages using each collection's own resolver and preserves both definitions", async () => {
    const alpha = await createSource({
      namespace: "alpha",
      body: "from alpha",
    });
    const beta = await createSource({ namespace: "beta", body: "from beta" });
    const index = createContentIndex([...alpha, ...beta]);
    const selected = index.resolve(
      { alias: "shared", namespace: "beta" },
      "reference",
    );

    assert.strictEqual(alpha[0]?.identity.packageName, "@example/shared");
    assert.strictEqual(alpha[0]?.identity.namespace, "alpha");
    assert.strictEqual(beta[0]?.identity.namespace, "beta");
    assert.notStrictEqual(
      alpha[0]?.source.moduleURL,
      beta[0]?.source.moduleURL,
    );
    assert.strictEqual(
      (selected.definition as { value: string }).value,
      "from beta",
    );
    assert.throws(
      () => index.resolve("shared", "reference"),
      /Ambiguous content alias/u,
    );
  });

  void it("rejects duplicate canonical identities registered within a single collection", async () => {
    const members = await createSource({
      namespace: "duplicate",
      body: "value",
    });
    const member = members[0]!;
    assert.throws(
      () => createContentIndex([member, member]),
      /Duplicate canonical content identity/u,
    );
  });
});
