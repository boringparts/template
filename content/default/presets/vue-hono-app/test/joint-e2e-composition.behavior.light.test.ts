import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DefaultPresetPackageEvaluation } from "@boringparts/default-content-authoring/preset-root-contribution";
import { honoApiDependencyKey } from "@boringparts/reference-vue-hono-web/template";
import type { CompositionPackage } from "@boringparts/template-core/composition";
import type { ContentIdentity } from "@boringparts/template-core/content-identity";
import type { PackageDefinitionId } from "@boringparts/template-core/project-blueprint";

import { preset } from "../template/definition.ts";

const { compose: composeVueHonoJointE2e, prepare: prepareJointE2eResources } =
  preset.rootContribution;

const ownerIdentity: ContentIdentity = {
  namespace: "boringparts",
  packageName: "@boringparts/preset-vue-hono-app",
  exportPath: "./template",
};

const rootId = "package-root" as PackageDefinitionId;
const webId = "package-web" as PackageDefinitionId;
const apiId = "package-api" as PackageDefinitionId;
const otherApiId = "package-other-api" as PackageDefinitionId;

async function resources() {
  return (await prepareJointE2eResources({ ownerIdentity })).ownerFacts
    .resources;
}

function packageInstance(options: {
  readonly id: PackageDefinitionId;
  readonly packageName: string;
  readonly name: string;
  readonly path: string;
  readonly role: string;
  readonly dependencyBindings?: Readonly<Record<string, PackageDefinitionId>>;
}): CompositionPackage {
  return {
    packageDefinitionId: options.id,
    contentIdentity: {
      namespace: "boringparts",
      packageName: options.packageName,
      exportPath: "./template",
    },
    definition: {
      packageDefinitionId: options.id,
      name: options.name,
      path: options.path,
      role: options.role,
    },
    createdBy: "initialization",
    creationInput: null,
    dependencyBindings: options.dependencyBindings ?? {},
  };
}

function evaluation(
  packageInstance: CompositionPackage,
): DefaultPresetPackageEvaluation {
  return {
    package: packageInstance,
    bindings: new Map(),
    contribution: {
      packageDefinitionId: packageInstance.packageDefinitionId,
      files: [],
      facts: {
        sourcePackageName: packageInstance.contentIdentity.packageName,
        manifest: {},
        exposure: { exports: {}, imports: {} },
        deferredNativeDocuments: [],
        packageInput: undefined,
        nativeDocuments: [],
        compositionFiles: [],
        dependencyUses: [],
        templateDependencies: [],
        foundation: {},
        environmentNeeds: [],
        ciDiagnosticArtifacts: [],
        referenceBindings: {},
        ownerFacts: {},
      },
    },
  };
}

function selectedPackages(
  ...entries: readonly (readonly [string, CompositionPackage])[]
): ReadonlyMap<string, DefaultPresetPackageEvaluation> {
  return new Map(
    entries.map(([nodeIdentity, packageInstance]) => [
      nodeIdentity,
      evaluation(packageInstance),
    ]),
  );
}

function validSelection() {
  const root = packageInstance({
    id: rootId,
    packageName: "@boringparts/reference-workspace-root",
    name: "demo",
    path: ".",
    role: "native-package",
  });
  const api = packageInstance({
    id: apiId,
    packageName: "@boringparts/reference-hono-api",
    name: "@demo/api",
    path: "apps/api",
    role: "runtime-service",
  });
  const web = packageInstance({
    id: webId,
    packageName: "@boringparts/reference-vue-hono-web",
    name: "@demo/web",
    path: "apps/web",
    role: "browser-app",
    dependencyBindings: { [honoApiDependencyKey]: apiId },
  });
  return {
    root,
    api,
    web,
    selection: {
      selectionId: "selection-vue-hono",
      presetIdentity: ownerIdentity,
      nodes: { web: webId, api: apiId },
    },
  };
}

void describe("Vue-Hono preset joint E2E composition", () => {
  void it("generates root files and shared declarations from persisted node bindings", async () => {
    const { root, web, api, selection } = validSelection();
    const ownerFacts = { resources: await resources() };
    const result = composeVueHonoJointE2e({
      ownerIdentity,
      selection,
      rootPackage: root,
      rootManifest: {},
      selectedPackages: selectedPackages(["web", web], ["api", api]),
      ownerFacts,
    });

    assert.deepStrictEqual(
      result.rootDeclaration.files?.map(({ path, mode }) => [path, mode]),
      [
        ["playwright.config.ts", 0],
        ["test/e2e/app.spec.ts", 0],
        ["test/e2e/fixtures.ts", 0],
      ],
    );
    assert.strictEqual(result.rootPackageDefinitionId, rootId);
    const configuration = new TextDecoder().decode(
      result.rootDeclaration.files[0]!.content,
    );
    assert.match(configuration, /const apiPackageName = "@demo\/api";/u);
    assert.match(configuration, /const webPackageName = "@demo\/web";/u);
    assert.match(configuration, /--filter \$\{apiPackageName\}/u);
    assert.match(configuration, /--filter \$\{webPackageName\}/u);
    assert.deepStrictEqual(result.rootDeclaration.manifest, {
      scripts: { "test:e2e": "playwright test" },
      devDependencies: { "@playwright/test": "catalog:" },
    });
    assert.deepStrictEqual(result.rootDeclaration.turboTasks, {
      "//#test:e2e": {
        cache: false,
        tags: ["quality:heavy"],
        dependsOn: [
          "@demo/api#build",
          "@demo/web#build",
          "@demo/web#browser:prepare",
        ],
      },
    });
    assert.deepStrictEqual(result.rootDeclaration.typescript, {
      include: ["test/**/*.ts"],
    });
    assert.deepStrictEqual(result.rootDeclaration.environmentNeeds?.check, [
      {
        kind: "playwright-browser-assets",
        browser: "chromium",
        owner: { kind: "workspace-orchestration", path: "." },
      },
    ]);
    assert.deepStrictEqual(result.rootDeclaration.ciDiagnosticArtifacts, [
      {
        kind: "playwright",
        owner: { kind: "workspace-orchestration", path: "." },
      },
    ]);
  });

  void it("rejects mismatched preset identity, selected nodes, service role, or API binding", async () => {
    const { root, web, api, selection } = validSelection();
    const validPackages = selectedPackages(["web", web], ["api", api]);
    const ownerFacts = { resources: await resources() };

    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity: { ...ownerIdentity, namespace: "other" },
          selection,
          rootPackage: root,
          rootManifest: {},
          selectedPackages: validPackages,
          ownerFacts,
        }),
      /preset identity/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection: { ...selection, nodes: { web: webId } },
          rootPackage: root,
          rootManifest: {},
          selectedPackages: validPackages,
          ownerFacts,
        }),
      /node api/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          rootManifest: {},
          selectedPackages: selectedPackages(
            [
              "web",
              {
                ...web,
                definition: { ...web.definition, role: "shared-library" },
              },
            ],
            ["api", api],
          ),
          ownerFacts,
        }),
      /web.*browser-app/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          rootManifest: {},
          selectedPackages: selectedPackages(
            ["web", { ...web, dependencyBindings: { "hono-api": otherApiId } }],
            ["api", api],
          ),
          ownerFacts,
        }),
      /bound to.*API/u,
    );
    assert.throws(
      () =>
        composeVueHonoJointE2e({
          ownerIdentity,
          selection,
          rootPackage: root,
          rootManifest: {},
          selectedPackages: selectedPackages(
            [
              "web",
              {
                ...web,
                contentIdentity: {
                  ...web.contentIdentity,
                  packageName: "@other/web",
                },
              },
            ],
            ["api", api],
          ),
          ownerFacts,
        }),
      /web source package name/u,
    );
  });

  void it("prepares the joint config and two test resources from the outer layer", async () => {
    const prepared = await resources();
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/playwright.config.ts",
        )!.content,
      ),
      /@boringparts\/reference-hono-api/u,
    );
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/test/e2e/app.spec.ts",
        )!.content,
      ),
      /calls the API/u,
    );
    assert.match(
      new TextDecoder().decode(
        prepared.find(
          ({ path }) => path === "resources/joint-e2e/test/e2e/fixtures.ts",
        )!.content,
      ),
      /PLAYWRIGHT_WEB_URL/u,
    );
    assert.deepStrictEqual(
      prepared.map(({ mode }) => mode),
      [0, 0, 0],
    );
  });
});
