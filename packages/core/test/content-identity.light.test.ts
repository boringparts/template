import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  contentIdentityKey,
  createContentIndex,
  deriveContentMembers,
  type LoadedContentMember,
} from "../src/content-identity.ts";

type Definition = { readonly value: string };

function member(options: {
  readonly namespace: string;
  readonly packageName: string;
  readonly exportPath: string;
  readonly alias: string;
  readonly kind: "reference" | "preset";
  readonly value: string;
}): LoadedContentMember<Definition> {
  return {
    identity: {
      namespace: options.namespace,
      packageName: options.packageName,
      exportPath: options.exportPath,
    },
    kind: options.kind,
    alias: options.alias,
    definition: { value: options.value },
    source: {
      specifier: `${options.packageName}${options.exportPath === "." ? "" : options.exportPath.slice(1)}`,
      moduleURL: `file:///${options.value}.js`,
      manifestURL: `file:///${options.value}/package.json`,
    },
  };
}

void describe("canonical content identity index", () => {
  void it("preserves reference package and preset definition types from a single collection", () => {
    const reference: LoadedContentMember<
      { readonly marker: "reference" },
      "reference"
    > = {
      ...member({
        namespace: "typed",
        packageName: "@example/reference",
        exportPath: "./template",
        alias: "reference",
        kind: "reference",
        value: "reference",
      }),
      kind: "reference",
      definition: { marker: "reference" },
    };
    const preset: LoadedContentMember<{ readonly marker: 42 }, "preset"> = {
      ...member({
        namespace: "typed",
        packageName: "@example/preset",
        exportPath: "./template",
        alias: "preset",
        kind: "preset",
        value: "preset",
      }),
      kind: "preset",
      definition: { marker: 42 },
    };
    const derived = deriveContentMembers([reference, preset] as const);
    const referenceMarker: "reference" =
      derived.referencePackages[0]!.definition.marker;
    const presetMarker: 42 = derived.presets[0]!.definition.marker;
    // @ts-expect-error Derived reference packages cannot hold preset definitions.
    const invalidReference: 42 =
      derived.referencePackages[0]!.definition.marker;
    // @ts-expect-error Derived presets cannot hold reference package definitions.
    const invalidPreset: "reference" = derived.presets[0]!.definition.marker;

    assert.deepEqual(derived.referencePackages, [reference]);
    assert.deepEqual(derived.presets, [preset]);
    assert.equal(referenceMarker, "reference");
    assert.equal(presetMarker, 42);
    void invalidReference;
    void invalidPreset;
  });

  void it("encodes all three identity components and resolves scoped aliases or canonical identities", () => {
    const alpha = member({
      namespace: "alpha",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "alpha",
    });
    const beta = member({
      namespace: "beta",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "beta",
    });
    const index = createContentIndex([alpha, beta]);

    assert.strictEqual(
      contentIdentityKey(alpha.identity),
      '["alpha","@example/shared","./template"]',
    );
    assert.strictEqual(
      index.resolve({ alias: "shared", namespace: "beta" }, "reference"),
      beta,
    );
    assert.strictEqual(index.resolve(beta.identity, "reference"), beta);
    assert.throws(
      () => index.resolve("shared", "reference"),
      /Ambiguous content alias/u,
    );
  });

  void it("rejects ambiguous aliases, kind mismatches, and duplicate canonical identities", () => {
    const reference = member({
      namespace: "first",
      packageName: "@example/content",
      exportPath: "./template",
      alias: "content",
      kind: "reference",
      value: "first",
    });
    const sameAlias = member({
      namespace: "first",
      packageName: "@example/content-preset",
      exportPath: "./template",
      alias: "content",
      kind: "preset",
      value: "second",
    });
    const index = createContentIndex([reference, sameAlias]);

    assert.strictEqual(index.resolve("content", "reference"), reference);
    assert.strictEqual(index.resolve("content", "preset"), sameAlias);
    assert.throws(
      () => index.resolve(sameAlias.identity, "reference"),
      /Content kind mismatch/u,
    );
    assert.throws(
      () =>
        createContentIndex([
          reference,
          {
            ...reference,
            source: { ...reference.source, moduleURL: "file:///revision.js" },
          },
        ]),
      /source revisions/u,
    );
  });

  void it("prefers the matching source namespace when resolving by definition object", () => {
    const alpha = member({
      namespace: "alpha",
      packageName: "@example/shared",
      exportPath: "./template",
      alias: "shared",
      kind: "reference",
      value: "physical-source",
    });
    const beta = {
      ...alpha,
      identity: { ...alpha.identity, namespace: "beta" },
    };
    const index = createContentIndex([alpha, beta]);

    assert.strictEqual(
      index.fromDefinition(alpha.definition, "reference", {
        namespace: "beta",
      }),
      beta,
    );
    assert.throws(
      () => index.fromDefinition(alpha.definition, "reference"),
      /belongs to multiple namespaces/u,
    );
    assert.strictEqual(
      createContentIndex([alpha]).fromDefinition(
        alpha.definition,
        "reference",
        { namespace: "beta" },
      ),
      alpha,
    );
    const betaEntry = {
      ...beta,
      identity: { ...beta.identity, exportPath: "./another-entry" },
    };
    assert.throws(
      () =>
        createContentIndex([alpha, beta, betaEntry]).fromDefinition(
          alpha.definition,
          "reference",
          { namespace: "beta" },
        ),
      /multiple canonical entries/u,
    );
  });
});
