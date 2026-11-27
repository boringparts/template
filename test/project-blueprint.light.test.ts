import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertProjectBlueprintDraft,
  validateProjectBlueprint,
} from "@boringparts/template-core/project-blueprint";

const firstPackageId = `package-${"1".repeat(64)}` as const;
const secondPackageId = `package-${"2".repeat(64)}` as const;
const missingPackageId = `package-${"3".repeat(64)}` as const;

function packageDefinition(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
  packageDefinitionId = firstPackageId,
) {
  return { packageDefinitionId, name, path: packagePath, role } as const;
}

function blueprintWithPackages(
  packages: readonly unknown[],
  packageLinkIntents: readonly unknown[] = [],
) {
  return {
    schemaVersion: 4,
    packages,
    packageLinkIntents,
  } as const;
}

function blueprintWithPackage(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
) {
  return blueprintWithPackages([packageDefinition(name, packagePath, role)]);
}

void describe("project blueprint package identity", () => {
  void it("preserves generic package names and roles and accepts safe relative paths", () => {
    const blueprint = blueprintWithPackage(
      "north:overview",
      "docs/guides/overview",
      "documentation",
    );

    assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
      ok: true,
      value: blueprint,
    });
  });

  void it("requires package role to be a string", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages([
          {
            packageDefinitionId: firstPackageId,
            name: "@demo/tool",
            path: "packages/tool",
            role: 42,
          },
        ]),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].role",
            message:
              "Field type or structure does not match the blueprint schema",
          },
        ],
      },
    );
  });

  for (const [field, duplicateValue, message] of [
    ["name", "@demo/tool", "Package name must be unique: @demo/tool"],
    ["path", "packages/tool", "Package path must be unique: packages/tool"],
  ] as const) {
    void it(`rejects duplicate package ${field} and identifies both sides`, () => {
      const existing = packageDefinition("@demo/tool");
      const requested = packageDefinition(
        field === "name" ? duplicateValue : "@demo/other",
        field === "path" ? duplicateValue : "packages/other",
        "cli-tool",
        secondPackageId,
      );

      assert.deepStrictEqual(
        validateProjectBlueprint(blueprintWithPackages([existing, requested])),
        {
          ok: false,
          issues: [
            {
              path: ".packages",
              message,
              packageIdentityIssue: {
                kind: "duplicate",
                field,
                existing: {
                  name: existing.name,
                  path: existing.path,
                  role: existing.role,
                },
                requested: {
                  name: requested.name,
                  path: requested.path,
                  role: requested.role,
                },
              },
            },
          ],
        },
      );
    });
  }

  for (const [label, packageDefinitionId] of [
    ["empty string", ""],
    ["short value", "package-short"],
    ["uppercase digest", `package-${"G".repeat(64)}`],
  ] as const) {
    void it(`rejects malformed persistent package definition ID: ${label}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackages([
            {
              ...packageDefinition("@demo/tool"),
              packageDefinitionId,
            },
          ]),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].packageDefinitionId",
              message:
                "Field type or structure does not match the blueprint schema",
            },
          ],
        },
      );
    });
  }

  void it("rejects a missing persistent package definition ID", () => {
    const definition = {
      ...packageDefinition("@demo/tool"),
    } as Record<string, unknown>;
    delete definition.packageDefinitionId;

    assert.deepStrictEqual(
      validateProjectBlueprint(blueprintWithPackages([definition])),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].packageDefinitionId",
            message: "Blueprint is missing a required field",
          },
        ],
      },
    );
  });

  void it("independently rejects duplicate package definition IDs", () => {
    const original = packageDefinition("@demo/tool");

    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages([
          original,
          packageDefinition(
            "@demo/other",
            "packages/other",
            "cli-tool",
            firstPackageId,
          ),
        ]),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[1].packageDefinitionId",
            message: `Package definition ID must be unique: ${firstPackageId}`,
          },
        ],
      },
    );
  });
});

void describe("project blueprint paths", () => {
  for (const packagePath of [
    "",
    "../escape",
    "/absolute/path",
    "C:/outside",
    "packages\\tool",
    "packages//tool",
    "packages/./tool",
    "packages/tool/",
  ]) {
    void it(`rejects unsafe relative path ${JSON.stringify(packagePath)}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackage("@demo/tool", packagePath),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: "Package path must be a normalized safe relative path",
              packageIdentityIssue: { kind: "invalid", field: "path" },
            },
          ],
        },
      );
    });
  }

  void it("rejects unsafe paths before assigning persistent package definition IDs", () => {
    assert.throws(
      () =>
        assertProjectBlueprintDraft({
          schemaVersion: 4,
          packages: [
            {
              name: "north:overview",
              path: "../escape",
              role: "documentation",
            },
          ],
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(
          ".packages[0].path: Package path must be a normalized safe relative path",
        ),
    );
  });
});

void describe("project blueprint package link intents", () => {
  void it("accepts explicit links between existing instances", () => {
    const blueprint = blueprintWithPackages(
      [
        packageDefinition("@demo/consumer", "packages/consumer"),
        packageDefinition(
          "@demo/provider",
          "packages/provider",
          "shared-library",
          secondPackageId,
        ),
      ],
      [{ consumerId: firstPackageId, providerId: secondPackageId }],
    );

    assert.deepStrictEqual(validateProjectBlueprint(blueprint), {
      ok: true,
      value: blueprint,
    });
  });

  for (const [label, packageLinkIntents, path, message] of [
    [
      "missing consumer",
      [{ consumerId: missingPackageId, providerId: firstPackageId }],
      ".packageLinkIntents[0].consumerId",
      "Package link references a non-existent consumer package instance",
    ],
    [
      "missing provider",
      [{ consumerId: firstPackageId, providerId: missingPackageId }],
      ".packageLinkIntents[0].providerId",
      "Package link references a non-existent provider package instance",
    ],
    [
      "self-link",
      [{ consumerId: firstPackageId, providerId: firstPackageId }],
      ".packageLinkIntents[0]",
      "Package link must not target itself",
    ],
  ] as const) {
    void it(`rejects ${label}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint(
          blueprintWithPackages(
            [packageDefinition("@demo/tool")],
            packageLinkIntents,
          ),
        ),
        { ok: false, issues: [{ path, message }] },
      );
    });
  }

  void it("rejects duplicate explicit links", () => {
    const connection = {
      consumerId: firstPackageId,
      providerId: secondPackageId,
    };
    assert.deepStrictEqual(
      validateProjectBlueprint(
        blueprintWithPackages(
          [
            packageDefinition("@demo/consumer", "packages/consumer"),
            packageDefinition(
              "@demo/provider",
              "packages/provider",
              "shared-library",
              secondPackageId,
            ),
          ],
          [connection, connection],
        ),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packageLinkIntents[1]",
            message: "Package link must not be duplicated",
          },
        ],
      },
    );
  });
});

void describe("project blueprint structure and format", () => {
  for (const [value, path] of [
    [
      { schemaVersion: 4, packages: [42], packageLinkIntents: [] },
      ".packages[0]",
    ],
    [
      { schemaVersion: 4, packages: [], packageLinkIntents: [42] },
      ".packageLinkIntents[0]",
    ],
  ] as const) {
    void it("reports actionable paths for structural errors", () => {
      assert.deepStrictEqual(validateProjectBlueprint(value), {
        ok: false,
        issues: [
          {
            path,
            message:
              "Field type or structure does not match the blueprint schema",
          },
        ],
      });
    });
  }

  void it("reports structural errors first without running cross-document semantic validation", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [
          {
            packageDefinitionId: firstPackageId,
            name: 42,
            path: "packages/tool",
            role: "cli-tool",
          },
        ],
        packageLinkIntents: [
          { consumerId: firstPackageId, providerId: missingPackageId },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].name",
            message:
              "Field type or structure does not match the blueprint schema",
          },
        ],
      },
    );
  });

  void it("rejects unknown fields in nested persisted objects", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [
          {
            ...packageDefinition("@demo/tool"),
            inferredFromManifest: true,
          },
        ],
        packageLinkIntents: [
          {
            consumerId: firstPackageId,
            providerId: secondPackageId,
            inferredFromWorkspace: true,
          },
        ],
      }),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].inferredFromManifest",
            message: "Blueprint v4 contains an unknown field",
          },
          {
            path: ".packageLinkIntents[0].inferredFromWorkspace",
            message: "Blueprint v4 contains an unknown field",
          },
        ],
      },
    );
  });

  for (const schemaVersion of [3, 5]) {
    void it(`rejects legacy or unsupported blueprint schema ${schemaVersion}`, () => {
      assert.deepStrictEqual(
        validateProjectBlueprint({
          schemaVersion,
          packages: [],
          packageLinkIntents: [],
        }),
        {
          ok: false,
          issues: [
            {
              path: ".schemaVersion",
              message: `Unsupported local template metadata version ${schemaVersion}; only schema4 is supported`,
            },
          ],
        },
      );
    });
  }

  void it("rejects root fields not owned by the blueprint", () => {
    assert.deepStrictEqual(
      validateProjectBlueprint({
        schemaVersion: 4,
        packages: [],
        packageLinkIntents: [],
        repositoryName: "not-blueprint-owned",
      }),
      {
        ok: false,
        issues: [
          {
            path: ".repositoryName",
            message: "Blueprint v4 contains an unknown field",
          },
        ],
      },
    );
  });
});
