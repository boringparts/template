import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { findPlanningEffectViolations } from "../scripts/check-author-planning-roles.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type OwnerFixture = {
  readonly fixtureRoot: string;
  readonly packageRoot: string;
  readonly entryFile: string;
};

async function createOwnerFixture(
  prefix: string,
  packageName: string,
  options: { readonly sourceTypes?: boolean } = {},
): Promise<OwnerFixture> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const packageRoot = path.join(fixtureRoot, "owner");
  await Promise.all([
    mkdir(packageRoot),
    symlink(
      path.join(repositoryRoot, "node_modules"),
      path.join(fixtureRoot, "node_modules"),
      "dir",
    ),
  ]);

  const coreRoot = path.join(
    packageRoot,
    "node_modules/@boringparts/template-core",
  );
  const workspaceRoot = path.join(
    packageRoot,
    "node_modules/@boringparts/template-workspace",
  );
  await Promise.all([
    mkdir(coreRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
    writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, type: "module" }),
    ),
  ]);

  const referenceTypesFile = options.sourceTypes
    ? "reference-package.ts"
    : "reference-package.d.ts";
  const referenceTypes = [
    "export interface ReferencePackageDefinition {",
    "  parseCreationInput(): unknown;",
    "  createDefinition(): unknown;",
    "  evaluate(): unknown;",
    "}",
  ].join("\n");
  await Promise.all([
    writeFile(
      path.join(coreRoot, "package.json"),
      JSON.stringify({
        name: "@boringparts/template-core",
        type: "module",
        exports: {
          "./reference-package": options.sourceTypes
            ? {
                source: "./reference-package.ts",
                types: "./dist/reference-package.d.ts",
              }
            : { types: "./reference-package.d.ts" },
          "./composition": { types: "./composition.d.ts" },
        },
      }),
    ),
    writeFile(path.join(coreRoot, referenceTypesFile), referenceTypes),
    writeFile(
      path.join(coreRoot, "composition.d.ts"),
      [
        "export interface Composition {",
        "  resolve(): unknown;",
        "  combine(): unknown;",
        "}",
      ].join("\n"),
    ),
    writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "@boringparts/template-workspace",
        type: "module",
        exports: {
          "./reference-package": {
            types: "./reference-package.d.ts",
          },
          "./default-composition": {
            types: "./default-composition.d.ts",
          },
        },
      }),
    ),
    writeFile(
      path.join(workspaceRoot, "reference-package.d.ts"),
      [
        "export declare function defineReferencePackage(options: {",
        "  targetName(): unknown;",
        "  prepareFacts(): unknown;",
        "  transformManifest(): unknown;",
        "  transformDocument(): unknown;",
        "}): unknown;",
      ].join("\n"),
    ),
    writeFile(
      path.join(workspaceRoot, "default-composition.d.ts"),
      [
        "export interface DefaultPresetRootContributionOwner {",
        "  prepare(): unknown;",
        "  compose(): unknown;",
        "}",
      ].join("\n"),
    ),
  ]);

  return {
    fixtureRoot,
    packageRoot,
    entryFile: path.join(packageRoot, "template.ts"),
  };
}

function findOwnerViolations(fixture: OwnerFixture, identity: string) {
  return findPlanningEffectViolations(
    [
      {
        entryFile: fixture.entryFile,
        packageRoot: fixture.packageRoot,
        identity,
      },
    ],
    path.join(repositoryRoot, "tsconfig.config.json"),
  );
}

void describe("author planning role check", () => {
  void it("restricts pure planning callbacks while allowing resource reads during preparation", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-rules-",
      "@fixture/planning-owner",
    );
    const helperFile = path.join(fixture.packageRoot, "planning-helper.ts");
    try {
      await Promise.all([
        writeFile(
          fixture.entryFile,
          `import { readFileSync } from "node:fs";
import type { ReferencePackageDefinition } from "@boringparts/template-core/reference-package";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";
import type { DefaultPresetRootContributionOwner } from "@boringparts/default-content-authoring/preset-root-contribution";
import { readOwnerValue } from "./planning-helper.ts";

export const reference: ReferencePackageDefinition = {
  parseCreationInput() { return undefined; },
  createDefinition() { return undefined; },
  evaluate() {
    readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
    return readOwnerValue();
  },
};

export const defaultReference = defineReferencePackage({
  prepareFacts() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  transformManifest() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  transformDocument() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
});

export const rootContribution = {
  prepare() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  compose() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
} satisfies DefaultPresetRootContributionOwner;
`,
        ),
        writeFile(
          helperFile,
          `import { readFileSync } from "node:fs";

export function readOwnerValue(): string {
  return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
}
`,
        ),
      ]);

      const violations = findOwnerViolations(
        fixture,
        "@fixture/planning-owner#./template",
      );

      assert.deepEqual(
        violations.map(({ role, effect, file }) => ({ role, effect, file })),
        [
          {
            role: "@fixture/planning-owner#./template:reference.evaluate",
            effect: "filesystem",
            file: helperFile,
          },
          {
            role: "@fixture/planning-owner#./template:reference.evaluate",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/planning-owner#./template:reference.transformManifest",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/planning-owner#./template:reference.transformDocument",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/planning-owner#./template:preset.compose",
            effect: "filesystem",
            file: fixture.entryFile,
          },
        ],
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("rejects filesystem and process state reads in targetName planning callbacks", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-target-name-",
      "@fixture/target-name-owner",
    );
    try {
      await writeFile(
        fixture.entryFile,
        `import { readFileSync } from "node:fs";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

export const reference = defineReferencePackage({
  targetName() {
    readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
    return process.env.TARGET_NAME;
  },
});
`,
      );

      const violations = findOwnerViolations(
        fixture,
        "@fixture/target-name-owner#./template",
      );

      assert.deepEqual(
        [...new Set(violations.map(({ effect }) => effect))].sort(),
        ["filesystem", "process-global"],
      );
      assert.ok(
        violations.every(
          (violation) =>
            violation.role ===
              "@fixture/target-name-owner#./template:reference.targetName" &&
            violation.file === fixture.entryFile,
        ),
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("rejects filesystem and process reads in defineReferencePackage parseCreationInput", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-parse-creation-input-",
      "@fixture/parse-input-owner",
    );
    try {
      await writeFile(
        fixture.entryFile,
        `import { readFileSync } from "node:fs";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

export const reference = defineReferencePackage({
  parseCreationInput(value) {
    readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
    void process.env.TARGET_NAME;
    return value;
  },
});
`,
      );

      const violations = findOwnerViolations(
        fixture,
        "@fixture/parse-input-owner#./template",
      );

      assert.deepEqual(
        [...new Set(violations.map(({ effect }) => effect))].sort(),
        ["filesystem", "process-global"],
      );
      assert.ok(
        violations.every(
          (violation) =>
            violation.role ===
              "@fixture/parse-input-owner#./template:reference.parseCreationInput" &&
            violation.file === fixture.entryFile,
        ),
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  for (const sdk of [
    {
      label: "installed declarations",
      sourceTypes: false,
    },
    {
      label: "source conditions",
      sourceTypes: true,
    },
  ]) {
    void it(`identifies planning roles from public SDK ${sdk.label}`, async () => {
      const fixture = await createOwnerFixture(
        "author-planning-declaration-",
        "@fixture/installed-owner",
        sdk,
      );
      try {
        await writeFile(
          fixture.entryFile,
          `import { readFileSync } from "node:fs";
import type { ReferencePackageDefinition } from "@boringparts/template-core/reference-package";

export const reference: ReferencePackageDefinition = {
  parseCreationInput() { return undefined; },
  createDefinition() { return undefined; },
  evaluate() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
};
`,
        );

        const violations = findOwnerViolations(
          fixture,
          "@fixture/installed-owner#./template",
        );

        assert.equal(violations.length, 1);
        assert.equal(
          violations[0]?.role,
          "@fixture/installed-owner#./template:reference.evaluate",
        );
        assert.equal(violations[0]?.file, fixture.entryFile);
      } finally {
        await rm(fixture.fixtureRoot, { recursive: true, force: true });
      }
    });
  }

  void it("identifies pure reference package evaluation through public namespace SDK imports", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-namespace-sdk-",
      "@fixture/namespace-owner",
    );
    try {
      await writeFile(
        fixture.entryFile,
        `import { readFileSync } from "node:fs";
import * as sdk from "@boringparts/template-core/reference-package";

export const reference: sdk.ReferencePackageDefinition = {
  parseCreationInput() { return undefined; },
  createDefinition() { return undefined; },
  evaluate() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
};
`,
      );

      const violations = findOwnerViolations(
        fixture,
        "@fixture/namespace-owner#./template",
      );

      assert.equal(violations.length, 1);
      assert.equal(violations[0]?.effect, "filesystem");
      assert.equal(
        violations[0]?.role,
        "@fixture/namespace-owner#./template:reference.evaluate",
      );
      assert.equal(violations[0]?.file, fixture.entryFile);
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("detects planning side effects across reference package functions, composition functions, and default owner callbacks", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-functional-contracts-",
      "@fixture/functional-owner",
    );
    try {
      await writeFile(
        fixture.entryFile,
        `import { readFileSync } from "node:fs";
import type { Composition } from "@boringparts/template-core/composition";
import type { ReferencePackageDefinition } from "@boringparts/template-core/reference-package";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";
import type { DefaultPresetRootContributionOwner } from "@boringparts/default-content-authoring/preset-root-contribution";

export const reference: ReferencePackageDefinition = {
  parseCreationInput() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  createDefinition() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  evaluate() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
};

export const composition: Composition = {
  resolve() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  combine() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
};

export const defaultReference = defineReferencePackage({
  prepareFacts() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  transformManifest() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  transformDocument() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
});

export const rootContribution = {
  prepare() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  compose() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
} satisfies DefaultPresetRootContributionOwner;
`,
      );

      const violations = findOwnerViolations(
        fixture,
        "@fixture/functional-owner#./template",
      );

      assert.deepEqual(
        violations.map(({ role, effect, file }) => ({ role, effect, file })),
        [
          {
            role: "@fixture/functional-owner#./template:reference.parseCreationInput",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:reference.createDefinition",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:reference.evaluate",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:composition.resolve",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:composition.combine",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:reference.transformManifest",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:reference.transformDocument",
            effect: "filesystem",
            file: fixture.entryFile,
          },
          {
            role: "@fixture/functional-owner#./template:preset.compose",
            effect: "filesystem",
            file: fixture.entryFile,
          },
        ],
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("scans pure factory callbacks in owner production configs", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-production-sources-",
      "@fixture/production-owner",
    );
    const spareFile = path.join(fixture.packageRoot, "spare.ts");
    try {
      await Promise.all([
        writeFile(
          path.join(fixture.packageRoot, "package.json"),
          JSON.stringify({
            name: "@fixture/production-owner",
            type: "module",
            dependencies: { "@boringparts/template-workspace": "workspace:*" },
            scripts: { "build:template": "tsc -p tsconfig.template.json" },
          }),
        ),
        writeFile(
          path.join(fixture.packageRoot, "tsconfig.template.json"),
          JSON.stringify({
            extends: path.join(repositoryRoot, "tsconfig.config.json"),
            include: ["*.ts"],
          }),
        ),
        writeFile(
          fixture.entryFile,
          `import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

export const reference = defineReferencePackage({
  prepareFacts() { return undefined; },
  transformManifest() { return "safe"; },
  transformDocument() { return "safe"; },
});
`,
        ),
        writeFile(
          spareFile,
          `import { readFileSync } from "node:fs";
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

export const reference = defineReferencePackage({
  prepareFacts() { return undefined; },
  transformManifest() {
    return readFileSync(new URL("./owner.txt", import.meta.url), "utf8");
  },
  transformDocument() { return "safe"; },
});
`,
        ),
      ]);

      const violations = findOwnerViolations(
        fixture,
        "@fixture/production-owner#./template",
      );

      assert.deepEqual(
        violations.map(({ effect, file }) => ({ effect, file })),
        [{ effect: "filesystem", file: spareFile }],
      );
      assert.equal(
        violations[0]?.role,
        "@fixture/production-owner#./template:reference.transformManifest",
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("rejects process state reads, require calls, and computed dynamic imports in pure reference package evaluation helpers", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-effects-",
      "@fixture/effect-owner",
    );
    const helperFile = path.join(fixture.packageRoot, "planning-helper.ts");
    try {
      await Promise.all([
        writeFile(
          fixture.entryFile,
          `import type { ReferencePackageDefinition } from "@boringparts/template-core/reference-package";
import { inspectOwnerState, loadComputedModule } from "./planning-helper.ts";

export const reference: ReferencePackageDefinition = {
  parseCreationInput() { return undefined; },
  createDefinition() { return undefined; },
  evaluate() {
    inspectOwnerState();
    loadComputedModule();
    return undefined;
  },
};
`,
        ),
        writeFile(
          helperFile,
          `export function inspectOwnerState(): string | undefined {
  return process.env.NODE_ENV;
}

export function loadComputedModule(): void {
  require("node:fs");
  const moduleName = "./resource";
  void import(moduleName + ".ts");
}
`,
        ),
      ]);

      const violations = findOwnerViolations(
        fixture,
        "@fixture/effect-owner#./template",
      );

      assert.deepEqual(
        [...new Set(violations.map(({ effect }) => effect))].sort(),
        ["computed-dynamic-import", "process-global", "require"],
      );
      assert.ok(
        violations.every(
          (violation) =>
            violation.role ===
              "@fixture/effect-owner#./template:reference.evaluate" &&
            violation.file === helperFile,
        ),
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });

  void it("allows pure transforms to use static owner JSON metadata", async () => {
    const fixture = await createOwnerFixture(
      "author-planning-static-metadata-",
      "@fixture/static-metadata-owner",
    );
    try {
      await writeFile(
        path.join(fixture.packageRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/static-metadata-owner",
          description: "Static owner metadata",
          type: "module",
        }),
      );
      await writeFile(
        fixture.entryFile,
        `import ownerManifest from "./package.json" with { type: "json" };
import { defineReferencePackage } from "@boringparts/default-content-authoring/reference-package";

export const reference = defineReferencePackage({
  prepareFacts() { return undefined; },
  transformManifest() { return undefined; },
  transformDocument() {
    const description: typeof ownerManifest.description = ownerManifest.description;
    return { description };
  },
});
`,
      );

      assert.deepEqual(
        findOwnerViolations(
          fixture,
          "@fixture/static-metadata-owner#./template",
        ),
        [],
      );
    } finally {
      await rm(fixture.fixtureRoot, { recursive: true, force: true });
    }
  });
});
