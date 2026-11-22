import assert from "node:assert/strict";
import { it } from "node:test";

import { composeApplicationRequirements } from "../src/application-requirements.ts";

void it("merges identical Rust requirements and reports conflicting sources", () => {
  const rustToolchain = {
    toolchain: "1.98.0",
    components: ["rustfmt", "clippy"],
    configurationText:
      '[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n',
  };

  assert.deepEqual(
    composeApplicationRequirements([
      { source: "rust-reference-package", requirements: { rustToolchain } },
      {
        source: "rust-preset",
        requirements: { rustToolchain: { ...rustToolchain } },
      },
    ]),
    { rustToolchain },
  );
  assert.throws(
    () =>
      composeApplicationRequirements([
        { source: "rust-reference-package", requirements: { rustToolchain } },
        {
          source: "rust-preset",
          requirements: {
            rustToolchain: { ...rustToolchain, toolchain: "1.97.0" },
          },
        },
      ]),
    /Conflicting workspace Rust toolchain requirements between rust-reference-package and rust-preset/u,
  );
});
