import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { projectCliPackageManifest } from "../../template/package-manifest.ts";

const manifest = {
  name: "@boringparts/reference-ts-cli",
  private: true,
  bin: { "reference-cli": "./dist/cli.js" },
  files: ["dist"],
  engines: { node: "^26.13.1" },
};

void describe("CLI template manifest transformation", () => {
  void it("rewrites the bin command name and tested Node baseline while preserving other fields", () => {
    assert.deepStrictEqual(
      projectCliPackageManifest({
        manifest,
        commandName: "public-cli",
        nodeDeclaration: "26.13.1",
      }),
      {
        ...manifest,
        bin: { "public-cli": "./dist/cli.js" },
        engines: { node: "^26.13.1" },
      },
    );
    assert.deepStrictEqual(manifest.bin, { "reference-cli": "./dist/cli.js" });
    assert.deepStrictEqual(manifest.engines, { node: "^26.13.1" });
  });

  void it("rejects invalid target command names", () => {
    for (const commandName of [
      "",
      "tools/release",
      "tools\\release",
      "release tool",
      "release\u0000",
      "-release",
      "Release",
      "发布",
      "public--cli",
    ]) {
      assert.throws(
        () =>
          projectCliPackageManifest({
            manifest,
            commandName,
            nodeDeclaration: "24",
          }),
        /command name/u,
      );
    }
  });

  void it("rejects manifests without a single string bin entry", () => {
    for (const invalid of [
      null,
      {},
      { bin: {} },
      { bin: { release: "./dist/cli.js", ship: "./dist/cli.js" } },
      { bin: { release: 1 } },
    ]) {
      assert.throws(
        () =>
          projectCliPackageManifest({
            manifest: invalid,
            commandName: "public-cli",
            nodeDeclaration: "24",
          }),
        /CLI package manifest/u,
      );
    }
  });
});
