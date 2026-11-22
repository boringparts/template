import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertGenerationRecordMatchesBlueprint,
  parseGenerationRecordStructure,
  type GenerationRecord,
} from "../src/generation-record.ts";
import type { JsonValue } from "../src/json.ts";
import type { ProjectBlueprint } from "../src/project-blueprint.ts";

const packageIdA =
  "package-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const packageIdB =
  "package-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

const validRecord = {
  schemaVersion: 6,
  composition: {
    identity: {
      namespace: "fixture",
      packageName: "@fixture/composition",
      exportPath: "./composition",
    },
    conventions: { edition: "draft" },
  },
  packages: [
    {
      packageDefinitionId: packageIdA,
      contentIdentity: {
        namespace: "fixture",
        packageName: "@fixture/root",
        exportPath: "./template",
      },
      createdBy: "initialization",
      creationInput: { path: "." },
      dependencyBindings: { lib: packageIdB },
    },
    {
      packageDefinitionId: packageIdB,
      contentIdentity: {
        namespace: "fixture",
        packageName: "@fixture/lib",
        exportPath: "./template",
      },
      createdBy: "shared-dependency",
      creationInput: null,
      dependencyBindings: {},
    },
  ],
  selections: [
    {
      selectionId: "selection-1",
      presetIdentity: null,
      nodes: { root: packageIdA, lib: packageIdB },
    },
  ],
} as const;

const matchingBlueprint: ProjectBlueprint = {
  schemaVersion: 4,
  packages: [
    {
      packageDefinitionId: packageIdA,
      name: "@demo/root",
      path: ".",
      role: "native-package",
    },
    {
      packageDefinitionId: packageIdB,
      name: "@demo/lib",
      path: "packages/lib",
      role: "shared-library",
    },
  ],
  packageLinkIntents: [],
};

void describe("generation record parsing", () => {
  void it("parses a valid schema6 record as JsonValue without trusting unvalidated domain types", () => {
    const parsed: GenerationRecord<JsonValue, JsonValue> =
      parseGenerationRecordStructure(validRecord);

    type Conventions = { readonly edition: string };
    type Input = { readonly path: string };
    // @ts-expect-error callers cannot fabricate domain types via type arguments
    parseGenerationRecordStructure<Conventions, Input>(validRecord);

    // @ts-expect-error conventions remain JsonValue until validated by composition
    const _edition: string = parsed.composition.conventions.edition;
    void _edition;

    assert.equal(parsed.schemaVersion, 6);
    assert.deepEqual(parsed.composition.conventions, { edition: "draft" });
    assert.deepEqual(parsed.packages[0]?.creationInput, { path: "." });
  });

  void it("rejects malformed schema6 generation records and blueprint mismatches", () => {
    assert.throws(
      () =>
        parseGenerationRecordStructure({
          ...validRecord,
          schemaVersion: 5,
        }),
      /schema6/u,
    );

    assert.throws(
      () =>
        parseGenerationRecordStructure({
          ...validRecord,
          packages: [
            {
              ...validRecord.packages[0],
              creationInput: { bad: Number.NaN },
            },
            validRecord.packages[1],
          ],
        }),
      /valid JSON data/u,
    );

    assert.throws(
      () =>
        parseGenerationRecordStructure({
          ...validRecord,
          packages: [
            {
              ...validRecord.packages[0],
              dependencyBindings: { "   ": packageIdB },
            },
            validRecord.packages[1],
          ],
        }),
      /dependencyBindings/u,
    );

    const matched: GenerationRecord<JsonValue, JsonValue> =
      assertGenerationRecordMatchesBlueprint(validRecord, matchingBlueprint);
    assert.equal(matched.packages.length, 2);

    assert.throws(
      () =>
        assertGenerationRecordMatchesBlueprint(validRecord, {
          ...matchingBlueprint,
          packages: [matchingBlueprint.packages[0]!],
        }),
      /mismatched package instances/u,
    );
  });
});
