import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  definePreset,
  presetOwnerFromManifest,
} from "../src/preset-definition.ts";

void describe("preset definition", () => {
  void it("derives preset owner identity from a real public export in the package manifest", () => {
    assert.deepStrictEqual(
      presetOwnerFromManifest(
        {
          name: "@demo/example-preset",
          exports: {
            ".": { source: "./src/preset.ts" },
            "./template": { source: "./template/definition.ts" },
          },
        },
        ".",
      ),
      {
        packageName: "@demo/example-preset",
        exportPath: ".",
      },
    );
    assert.throws(
      () =>
        presetOwnerFromManifest(
          {
            name: "@demo/hidden-preset",
            exports: { "./template": "./template/index.js" },
          },
          "./missing",
        ),
      /does not publish the selected preset entry/u,
    );
  });

  void it("preserves stable nodes, reference members, and allowed operations", () => {
    const library = {
      alias: "library",
      instance: "independent" as const,
    };
    const layout = { packageDirectory: "modules" };
    const creationInput = {
      init: { variant: "published" },
      add: { variant: "private" },
    };
    const preset = definePreset({
      metadata: {
        alias: "ts-lib",
        title: "TypeScript Library",
        description: "Strict TypeScript library.",
      },
      operations: ["init", "add"],
      nodes: { library: { reference: library, layout, creationInput } },
    });

    assert.strictEqual(preset.kind, "preset");
    assert.strictEqual(preset.nodes.library?.reference, library);
    assert.strictEqual(preset.nodes.library?.layout, layout);
    assert.strictEqual(preset.nodes.library?.creationInput, creationInput);
    assert.deepStrictEqual(preset.operations, ["init", "add"]);
  });

  void it("preserves and freezes sibling node dependency bindings", () => {
    const dependencyBindings = { api: "api" } as const;
    const preset = definePreset({
      metadata: {
        alias: "web-api",
        title: "Web and API",
        description:
          "Binds the web node's API dependency to the sibling node in the same selection.",
      },
      operations: ["init"],
      nodes: {
        web: {
          reference: { alias: "web", instance: "independent" },
          dependencyBindings,
        },
        api: {
          reference: { alias: "api", instance: "independent" },
        },
      },
    });
    const boundNode: "api" | undefined =
      preset.nodes.web?.dependencyBindings?.api;

    assert.deepStrictEqual(preset.nodes.web?.dependencyBindings, {
      api: "api",
    });
    assert.notStrictEqual(
      preset.nodes.web?.dependencyBindings,
      dependencyBindings,
    );
    assert.ok(Object.isFrozen(preset.nodes.web?.dependencyBindings));
    assert.equal(boundNode, "api");
  });

  void it("accepts the owning package root export as preset owner identity", () => {
    const preset = definePreset({
      metadata: {
        alias: "application",
        title: "Application",
        description: "Application preset with project-level projection.",
      },
      operations: ["init"],
      nodes: {
        application: {
          reference: { alias: "application", instance: "independent" },
        },
      },
      owner: { packageName: "@demo/application-preset", exportPath: "." },
    });

    assert.deepStrictEqual(preset.owner, {
      packageName: "@demo/application-preset",
      exportPath: ".",
    });
  });

  void it("rejects empty nodes, empty operations, invalid node names, and duplicate independent references", () => {
    const library = {
      alias: "library",
      instance: "independent" as const,
    };
    const metadata = {
      alias: "ts-lib",
      title: "TypeScript Library",
      description: "Strict TypeScript library.",
    };

    assert.throws(
      () => definePreset({ metadata, operations: ["init"], nodes: {} }),
      /at least one node/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: [],
          nodes: { library: { reference: library } },
        }),
      /at least one operation/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: { "bad node": { reference: library } },
        }),
      /Invalid preset node identity/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            first: { reference: library },
            second: { reference: library },
          },
        }),
      /independent reference more than once/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            consumer: {
              reference: { alias: "consumer", instance: "independent" },
              dependencyBindings: { provider: "missing" },
            },
            provider: {
              reference: { alias: "provider", instance: "independent" },
            },
          },
        }),
      /target does not exist/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            consumer: {
              reference: { alias: "consumer", instance: "independent" },
              dependencyBindings: { "": "consumer" },
            },
          },
        }),
      /Invalid preset node dependency binding/u,
    );
    assert.throws(
      () =>
        definePreset({
          metadata,
          operations: ["init"],
          nodes: {
            library: {
              reference: library,
              creationInput: { add: { variant: "private" } },
            },
          },
        }),
      /Invalid preset node creationInput operation/u,
    );
  });
});
