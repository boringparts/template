import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectTomlStringValues } from "../src/toml.ts";

void describe("native TOML string projection", () => {
  void it("preserves comments, arrays, and unrelated tables when updating Cargo identity and toolchain", () => {
    const source = `# Cargo owns this file.
[toolchain]
channel = 'stable' # follow the root
components = ["rustfmt", "clippy"]

[[package]]
name = "anyhow"
version = "1.0.104"

[[package]]
name = "app" # local binary
dependencies = [
 "anyhow",
]
`;
    assert.equal(
      projectTomlStringValues(source, [
        { path: ["toolchain", "channel"], value: "1.99.0" },
        { path: ["package", 1, "name"], value: "worker" },
      ]),
      `# Cargo owns this file.
[toolchain]
channel = "1.99.0" # follow the root
components = ["rustfmt", "clippy"]

[[package]]
name = "anyhow"
version = "1.0.104"

[[package]]
name = "worker" # local binary
dependencies = [
 "anyhow",
]
`,
    );
    const identity = "[package]\n'name' = 'app' # kept\n";
    assert.equal(
      projectTomlStringValues(identity, [
        { path: ["package", "name"], value: "app" },
      ]),
      identity,
    );
  });

  void it("rejects missing or non-string fields without guessing locations", () => {
    for (const source of ["[toolchain]\n", "[toolchain]\nchannel = 1\n"]) {
      assert.throws(
        () =>
          projectTomlStringValues(source, [
            { path: ["toolchain", "channel"], value: "stable" },
          ]),
        /existing string field/u,
      );
    }
  });
});
