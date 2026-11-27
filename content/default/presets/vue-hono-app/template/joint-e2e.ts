import type {
  DefaultCompositionFile,
  DefaultRootDeclarationData,
} from "@boringparts/default-content-authoring/contracts";
import type {
  DefaultPresetPackageEvaluation,
  DefaultPresetRootContributionResource,
} from "@boringparts/default-content-authoring/preset-root-contribution";
import { honoApiDependencyKey } from "@boringparts/reference-vue-hono-web/template";
import type { CompositionPackage } from "@boringparts/template-core/composition";
import {
  contentIdentityKey,
  contentIdentityLabel,
  type ContentIdentity,
} from "@boringparts/template-core/content-identity";
import type { GenerationRecordSelection } from "@boringparts/template-core/generation-record";

export const vueHonoJointE2eResourcePaths = Object.freeze({
  configuration: "resources/joint-e2e/playwright.config.ts",
  appSpec: "resources/joint-e2e/test/e2e/app.spec.ts",
  fixtures: "resources/joint-e2e/test/e2e/fixtures.ts",
});

export type VueHonoJointE2eResourceSnapshot =
  DefaultPresetRootContributionResource;

type PreparedResource = Readonly<{
  readonly content: Uint8Array;
  readonly mode: number;
}>;

export type PreparedVueHonoJointE2eResources = Readonly<{
  readonly configuration: PreparedResource;
  readonly appSpec: PreparedResource;
  readonly fixtures: PreparedResource;
}>;

export type VueHonoJointRootDeclaration = DefaultRootDeclarationData;

export type VueHonoJointE2eComposition = Readonly<{
  readonly rootPackageDefinitionId: CompositionPackage["packageDefinitionId"];
  readonly rootDeclaration: VueHonoJointRootDeclaration;
}>;

export type VueHonoJointE2eOwnerFacts = Readonly<{
  readonly resources: readonly VueHonoJointE2eResourceSnapshot[];
}>;

function requireResource(
  resources: readonly VueHonoJointE2eResourceSnapshot[],
  path: string,
): PreparedResource {
  const matches = resources.filter((resource) => resource.path === path);
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `Resource snapshot is missing joint E2E file: ${path}`
        : `Resource snapshot contains duplicate joint E2E file: ${path}`,
    );
  }
  const resource = matches[0]!;
  return Object.freeze({
    content: resource.content.slice(),
    mode: resource.mode & 0o111,
  });
}

/** Extracts joint E2E resources from the immutable byte snapshots prepared by the outer layer. */
export function prepareVueHonoJointE2eResources(
  resources: readonly VueHonoJointE2eResourceSnapshot[],
): PreparedVueHonoJointE2eResources {
  return Object.freeze({
    configuration: requireResource(
      resources,
      vueHonoJointE2eResourcePaths.configuration,
    ),
    appSpec: requireResource(resources, vueHonoJointE2eResourcePaths.appSpec),
    fixtures: requireResource(resources, vueHonoJointE2eResourcePaths.fixtures),
  });
}

function requireNode(
  selectedPackages: ReadonlyMap<string, DefaultPresetPackageEvaluation>,
  selection: GenerationRecordSelection,
  nodeName: "web" | "api",
): CompositionPackage {
  const packageDefinitionId = selection.nodes[nodeName];
  if (packageDefinitionId === undefined) {
    throw new Error(`Vue-Hono preset is missing node ${nodeName}`);
  }
  const selectedEvaluation = selectedPackages.get(nodeName);
  const selectedPackage = selectedEvaluation?.package;
  if (
    selectedPackage === undefined ||
    selectedPackage.packageDefinitionId !== packageDefinitionId
  ) {
    throw new Error(
      `Vue-Hono preset node ${nodeName} did not resolve to selected package instance ${packageDefinitionId}`,
    );
  }
  return selectedPackage;
}

function sameIdentity(left: ContentIdentity, right: ContentIdentity): boolean {
  return contentIdentityKey(left) === contentIdentityKey(right);
}

function rootDeclaration(
  api: CompositionPackage,
  web: CompositionPackage,
): VueHonoJointRootDeclaration {
  return Object.freeze({
    manifest: Object.freeze({
      scripts: Object.freeze({ "test:e2e": "playwright test" }),
      devDependencies: Object.freeze({ "@playwright/test": "catalog:" }),
    }),
    turboTasks: Object.freeze({
      "//#test:e2e": Object.freeze({
        cache: false,
        tags: Object.freeze(["quality:heavy"]),
        dependsOn: Object.freeze([
          `${api.definition.name}#build`,
          `${web.definition.name}#build`,
          `${web.definition.name}#browser:prepare`,
        ]),
      }),
    }),
    typescript: Object.freeze({ include: Object.freeze(["test/**/*.ts"]) }),
    ciDiagnosticArtifacts: Object.freeze([
      Object.freeze({
        kind: "playwright" as const,
        owner: Object.freeze({
          kind: "workspace-orchestration" as const,
          path: "." as const,
        }),
      }),
    ]),
    environmentNeeds: Object.freeze({
      check: Object.freeze([
        Object.freeze({
          kind: "playwright-browser-assets" as const,
          browser: "chromium" as const,
          owner: Object.freeze({
            kind: "workspace-orchestration" as const,
            path: "." as const,
          }),
        }),
      ]),
    }),
  });
}

function outputFiles(options: {
  readonly api: CompositionPackage;
  readonly web: CompositionPackage;
  readonly resources: PreparedVueHonoJointE2eResources;
}): readonly DefaultCompositionFile[] {
  let configuration: string;
  try {
    configuration = new TextDecoder("utf-8", { fatal: true }).decode(
      options.resources.configuration.content,
    );
  } catch (cause) {
    throw new Error("Vue-Hono Playwright config must be valid UTF-8 text", {
      cause,
    });
  }

  const apiSourceName = options.api.contentIdentity.packageName;
  const webSourceName = options.web.contentIdentity.packageName;
  if (!configuration.includes(JSON.stringify(apiSourceName))) {
    throw new Error(
      `Vue-Hono Playwright config is missing API source package name: ${apiSourceName}`,
    );
  }
  if (!configuration.includes(JSON.stringify(webSourceName))) {
    throw new Error(
      `Vue-Hono Playwright config is missing web source package name: ${webSourceName}`,
    );
  }
  const outputConfiguration = new TextEncoder().encode(
    configuration
      .replaceAll(
        JSON.stringify(apiSourceName),
        JSON.stringify(options.api.definition.name),
      )
      .replaceAll(
        JSON.stringify(webSourceName),
        JSON.stringify(options.web.definition.name),
      ),
  );
  return Object.freeze([
    {
      path: "playwright.config.ts",
      content: outputConfiguration,
      mode: options.resources.configuration.mode,
      sourcePath: vueHonoJointE2eResourcePaths.configuration,
    },
    {
      path: "test/e2e/app.spec.ts",
      content: options.resources.appSpec.content.slice(),
      mode: options.resources.appSpec.mode,
      sourcePath: vueHonoJointE2eResourcePaths.appSpec,
    },
    {
      path: "test/e2e/fixtures.ts",
      content: options.resources.fixtures.content.slice(),
      mode: options.resources.fixtures.mode,
      sourcePath: vueHonoJointE2eResourcePaths.fixtures,
    },
  ]);
}

/** Purely composes the web and API instances selected for this preset along with its owned root attachments. */
export function composeVueHonoJointE2e(options: {
  readonly ownerIdentity: ContentIdentity;
  readonly selection: GenerationRecordSelection;
  /** Must contain only the two nodes selected for this preset, not the full workspace instance map. */
  readonly selectedPackages: ReadonlyMap<
    string,
    DefaultPresetPackageEvaluation
  >;
  /** Workspace root instance explicitly provided by the default composer. */
  readonly rootPackage: CompositionPackage;
  readonly ownerFacts: VueHonoJointE2eOwnerFacts;
}): VueHonoJointE2eComposition {
  if (
    options.selection.presetIdentity === null ||
    !sameIdentity(options.ownerIdentity, options.selection.presetIdentity)
  ) {
    throw new Error(
      `Vue-Hono root contribution preset identity does not match persisted selection: ${contentIdentityLabel(options.ownerIdentity)}`,
    );
  }
  if (
    options.rootPackage.definition.path !== "." ||
    options.rootPackage.definition.role !== "native-package"
  ) {
    throw new Error(
      "Vue-Hono composition requires an explicit native-package root instance",
    );
  }

  const web = requireNode(options.selectedPackages, options.selection, "web");
  const api = requireNode(options.selectedPackages, options.selection, "api");
  const nodeNames = Object.keys(options.selection.nodes).toSorted();
  if (nodeNames.join(",") !== "api,web") {
    throw new Error(
      "Vue-Hono persisted selection must contain only the api and web nodes",
    );
  }
  if (options.selectedPackages.size !== nodeNames.length) {
    throw new Error(
      "Vue-Hono composition accepts only the selected api and web package instances",
    );
  }
  if (web.packageDefinitionId === api.packageDefinitionId) {
    throw new Error(
      "Vue-Hono preset web and API must be distinct package instances",
    );
  }
  if (
    web.packageDefinitionId === options.rootPackage.packageDefinitionId ||
    api.packageDefinitionId === options.rootPackage.packageDefinitionId
  ) {
    throw new Error(
      "Vue-Hono web and API nodes cannot reuse the base root instance",
    );
  }
  for (const [label, selectedPackage, expectedRole] of [
    ["web", web, "browser-app"],
    ["API", api, "runtime-service"],
  ] as const) {
    if (selectedPackage.definition.role !== expectedRole) {
      throw new Error(
        `Vue-Hono preset requires ${label} instance ${selectedPackage.definition.name} (${selectedPackage.definition.path}) to have role ${expectedRole}, received ${selectedPackage.definition.role}`,
      );
    }
  }
  if (
    web.dependencyBindings[honoApiDependencyKey] !== api.packageDefinitionId
  ) {
    throw new Error(
      `Vue-Hono preset web instance ${web.definition.name} (${web.definition.path}) must be bound to the selected API instance ${api.definition.name} (${api.definition.path})`,
    );
  }

  const preparedResources = prepareVueHonoJointE2eResources(
    options.ownerFacts.resources,
  );
  return Object.freeze({
    rootPackageDefinitionId: options.rootPackage.packageDefinitionId,
    rootDeclaration: Object.freeze({
      ...rootDeclaration(api, web),
      files: outputFiles({ api, web, resources: preparedResources }),
    }),
  });
}
