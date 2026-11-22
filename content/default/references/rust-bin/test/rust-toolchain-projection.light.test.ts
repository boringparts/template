import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseRustToolchainDeclaration,
  projectRustToolchainDeclaration,
} from "@ykdz/reference-rust-bin/template";

void describe("Rust toolchain shared facts", () => {
  void it("parses channel and components while preserving the raw declaration", () => {
    const source =
      '# maintainer note\n[toolchain]\nchannel = "1.99.0" # pinned\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

    assert.deepEqual(parseRustToolchainDeclaration(source), {
      channel: "1.99.0",
      components: ["rustfmt", "clippy"],
      declaration: source,
    });
    assert.throws(
      () => parseRustToolchainDeclaration('[toolchain]\nchannel = "   "\n'),
      /\[toolchain\]\.channel must be a non-empty string/u,
    );
    assert.throws(
      () => parseRustToolchainDeclaration("[toolchain\nchannel = 'stable'\n"),
      /not valid TOML/u,
    );
    assert.throws(
      () =>
        parseRustToolchainDeclaration(
          '[toolchain]\nchannel = "stable"\ncomponents = "rustfmt"\n',
        ),
      /\[toolchain\]\.components must be an array of strings/u,
    );
  });

  void it("preserves compatible root declaration bytes when adding a package", () => {
    const configurationText =
      '[toolchain]\nchannel = "1.99.0"\ncomponents = ["rustfmt", "clippy"]\n';
    const requirement = {
      toolchain: "1.98.0",
      components: ["rustfmt", "clippy"],
      configurationText,
    };
    const existingDeclaration =
      '# user extension\n[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\nprofile = "minimal"\n';

    assert.equal(
      projectRustToolchainDeclaration({
        requirement,
        existingDeclaration,
      }),
      existingDeclaration,
    );
    assert.equal(
      projectRustToolchainDeclaration({ requirement }),
      '[toolchain]\nchannel = "1.98.0"\ncomponents = ["rustfmt", "clippy"]\n',
    );
  });
});
