import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { referencePackage } from "../template/definition.ts";

void describe("rust-bin creationInput validation", () => {
  void it("accepts supported rust-bin creation inputs including linkFrom for composition diagnostics", () => {
    assert.deepEqual(referencePackage.parseCreationInput({}), {});
    assert.deepEqual(
      referencePackage.parseCreationInput({
        leafName: "worker",
        packageName: "@demo/worker",
        packagePath: "packages/worker",
        linkFrom: ["packages/cli"],
      }),
      {
        leafName: "worker",
        packageName: "@demo/worker",
        packagePath: "packages/worker",
        linkFrom: ["packages/cli"],
      },
    );
  });

  void it("rejects non-object, invalid field types, and unknown creationInput fields", () => {
    for (const invalid of [
      "bad",
      123,
      [],
      { leafName: 42 },
      { packageName: null },
      { packagePath: 123 },
      { linkFrom: "packages/cli" },
      { linkFrom: [123] },
      { unknownField: "value" },
    ]) {
      assert.throws(() => referencePackage.parseCreationInput(invalid));
    }
  });
});
