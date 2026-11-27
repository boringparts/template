import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createArtifactKey } from "@boringparts/reference-node-lib";

void describe("createArtifactKey", () => {
  void it("builds a deterministic artifact file name and digest", () => {
    const first = createArtifactKey({ baseName: "report" });
    const second = createArtifactKey({
      baseName: "  dir/report  ",
      extension: ".json",
    });
    assert.strictEqual(first.fileName, "report.json");
    assert.deepStrictEqual(first, second);
    assert.match(first.digest, /^[0-9a-f]{64}$/u);
  });

  void it("rejects empty base names and invalid extensions", () => {
    assert.throws(() => createArtifactKey({ baseName: " \t\n " }));
    assert.throws(() =>
      createArtifactKey({ baseName: "report", extension: "json" }),
    );
  });
});
