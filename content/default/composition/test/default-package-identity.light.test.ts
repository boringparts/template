import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ProjectBlueprintValidationError } from "@boringparts/template-core/project-blueprint";
import {
  assertDefaultProjectBlueprintDraft,
  isValidDefaultNpmPackageName,
  validateDefaultPackagePath,
  validateDefaultProjectBlueprint,
} from "@boringparts/template-workspace/default-package-identity";

const packageDefinitionId = `package-${"1".repeat(64)}` as const;

function blueprintWithPackage(
  name: string,
  packagePath = "packages/tool",
  role = "cli-tool",
) {
  return {
    schemaVersion: 4,
    packages: [{ packageDefinitionId, name, path: packagePath, role }],
    packageLinkIntents: [],
  } as const;
}

void describe("default policy package name contract", () => {
  void it("enforces npm package name length limits and Node built-in module reservations", () => {
    assert.strictEqual(isValidDefaultNpmPackageName("a".repeat(214)), true);
    assert.strictEqual(isValidDefaultNpmPackageName("a".repeat(215)), false);
    assert.strictEqual(
      isValidDefaultNpmPackageName(`@s/${"a".repeat(211)}`),
      true,
    );
    assert.strictEqual(
      isValidDefaultNpmPackageName(`@s/${"a".repeat(212)}`),
      false,
    );
    assert.strictEqual(isValidDefaultNpmPackageName("http"), false);
    assert.strictEqual(isValidDefaultNpmPackageName("@acme/http"), true);
  });

  for (const name of [
    "some-package",
    "example.com",
    "under_score",
    "123numeric",
    "@npm/thingy",
    "@jane/foo.js",
    "@scope/_hidden",
    "@scope/-hidden",
  ]) {
    void it(`accepts default policy npm name ${name}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(blueprintWithPackage(name)),
        {
          ok: true,
          value: blueprintWithPackage(name),
        },
      );
    });
  }

  for (const name of [
    "Uppercase",
    "@scope/Uppercase",
    " leading-space",
    "trailing-space ",
    "contain:colons",
    "excited!",
    ".hidden",
    "_hidden",
    "-hidden",
    "@scope/.hidden",
    "node_modules",
    "http",
    "inspector",
    "@scope",
    "@scope/",
    "@scope/name/extra",
    `@scope/${"a".repeat(208)}`,
  ]) {
    void it(`rejects default policy npm name ${name}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(blueprintWithPackage(name)),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].name",
              message:
                "Package name must be a valid npm package name for new packages",
              packageIdentityIssue: { kind: "invalid", field: "name" },
            },
          ],
        },
      );
    });
  }
});

void describe("default policy package role and path contract", () => {
  for (const role of [
    "cli-tool",
    "runtime-service",
    "browser-app",
    "shared-library",
    "node-library",
    "native-package",
  ]) {
    void it(`accepts default role ${role}`, () => {
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(
          blueprintWithPackage("@demo/tool", "packages/tool", role),
        ),
        {
          ok: true,
          value: blueprintWithPackage("@demo/tool", "packages/tool", role),
        },
      );
    });
  }

  void it("rejects unsupported roles under default policy", () => {
    assert.deepStrictEqual(
      validateDefaultProjectBlueprint(
        blueprintWithPackage("@demo/tool", "packages/tool", "documentation"),
      ),
      {
        ok: false,
        issues: [
          {
            path: ".packages[0].role",
            message:
              "Package Role must be cli-tool, runtime-service, browser-app, shared-library, node-library, or native-package",
          },
        ],
      },
    );
  });

  void it("enforces two-segment package paths and reports reserved workspace collections separately", () => {
    assert.deepStrictEqual(validateDefaultPackagePath("packages/tool"), {
      hasValidShape: true,
    });
    assert.deepStrictEqual(validateDefaultPackagePath("packages/nested/tool"), {
      hasValidShape: false,
    });
    assert.deepStrictEqual(validateDefaultPackagePath(".git/tool"), {
      hasValidShape: false,
      reservedWorkspaceCollection: ".git",
    });
  });

  for (const workspaceCollection of [
    ".git",
    ".github",
    ".devcontainer",
    ".template",
    "node_modules",
    "dist",
    "target",
  ]) {
    void it(`rejects reserved workspace collection ${workspaceCollection}`, () => {
      const packagePath = `${workspaceCollection}/evil`;
      assert.deepStrictEqual(
        validateDefaultProjectBlueprint(
          blueprintWithPackage("@demo/evil", packagePath, "shared-library"),
        ),
        {
          ok: false,
          issues: [
            {
              path: ".packages[0].path",
              message: `Package Path ${packagePath} uses reserved workspace collection ${workspaceCollection}`,
              packageIdentityIssue: { kind: "reserved", field: "path" },
            },
          ],
        },
      );
    });
  }

  void it("rejects reserved workspace collections before default policy initialization", () => {
    assert.throws(
      () =>
        assertDefaultProjectBlueprintDraft({
          schemaVersion: 4,
          packages: [
            {
              name: "@demo/evil",
              path: "dist/evil",
              role: "shared-library",
            },
          ],
        }),
      (error) => {
        if (!(error instanceof ProjectBlueprintValidationError)) return false;
        assert.deepStrictEqual(error.packageIdentityIssues, [
          { kind: "reserved", field: "path" },
        ]);
        return error.message.includes(
          ".packages[0].path: Package Path dist/evil uses reserved workspace collection dist",
        );
      },
    );
  });
});
