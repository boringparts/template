import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  referencePackage,
  type TsCliCreationInput,
} from "../../template/definition.ts";

void describe("ts-cli creationInput validation", () => {
  void it("accepts supported CLI creation inputs", () => {
    const inputs: readonly TsCliCreationInput[] = [
      referencePackage.parseCreationInput({}),
      referencePackage.parseCreationInput({
        leafName: "admin-cli",
        packageName: "@demo/admin-cli",
        packagePath: "tools/admin-cli",
        linkFrom: ["apps/web"],
        linkTo: { nodeIdentity: "library" },
      }),
      referencePackage.parseCreationInput({
        linkTo: { packageDefinitionId: "package-not-restored" },
      }),
    ];

    assert.equal(inputs.length, 3);
    assert.deepEqual(inputs[1]?.linkTo, { nodeIdentity: "library" });
  });

  void it("rejects non-object and malformed creationInput fields", () => {
    for (const invalid of [
      "bad",
      123,
      [],
      { leafName: 42 },
      { packageName: true },
      { packagePath: {} },
      { linkFrom: "apps/web" },
      { linkFrom: [123] },
      { linkTo: 999 },
      { linkTo: {} },
      { linkTo: { nodeIdentity: "" } },
      { linkTo: { packageDefinitionId: "" } },
      { linkTo: { nodeIdentity: "library", packageDefinitionId: "pkg" } },
      { linkTo: { unknown: "library" } },
    ]) {
      assert.throws(() => referencePackage.parseCreationInput(invalid));
    }
  });
});
