import { defineReferencePackage } from "@ykdz/default-content-authoring/reference-package";
import type { JsonValue } from "@ykdz/template-core/json";

import referenceManifest from "../package.json" with { type: "json" };
import { projectCliPackageManifest } from "./package-manifest.ts";

export type TsCliCreationInput = Readonly<Record<string, JsonValue>> & {
  readonly leafName?: string;
  readonly packageName?: string;
  readonly packagePath?: string;
  readonly linkFrom?: readonly string[];
  readonly linkTo?:
    | Readonly<{ readonly nodeIdentity: string }>
    | Readonly<{ readonly packageDefinitionId: string }>;
};

function isJsonRecord(
  value: JsonValue,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringField(
  record: Readonly<Record<string, JsonValue>>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`ts-cli creationInput.${field} must be a string`);
  }
  return value;
}

function optionalStringArrayField(
  record: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly string[] | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `ts-cli creationInput.${field} must be an array of strings`,
    );
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function optionalLinkToField(
  record: Readonly<Record<string, JsonValue>>,
): TsCliCreationInput["linkTo"] | undefined {
  const value = record.linkTo;
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) {
    throw new Error("ts-cli creationInput.linkTo must be an object");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1) {
    throw new Error(
      "ts-cli creationInput.linkTo must specify exactly one target key",
    );
  }
  if (
    keys[0] === "nodeIdentity" &&
    typeof value.nodeIdentity === "string" &&
    value.nodeIdentity.length > 0
  ) {
    return { nodeIdentity: value.nodeIdentity };
  }
  if (
    keys[0] === "packageDefinitionId" &&
    typeof value.packageDefinitionId === "string" &&
    value.packageDefinitionId.length > 0
  ) {
    return { packageDefinitionId: value.packageDefinitionId };
  }
  throw new Error(
    "ts-cli creationInput.linkTo must provide a non-empty nodeIdentity or packageDefinitionId string",
  );
}

function parseTsCliCreationInput(value: JsonValue): TsCliCreationInput {
  if (!isJsonRecord(value)) {
    throw new Error("ts-cli creationInput must be a JSON object");
  }
  const leafName = optionalStringField(value, "leafName");
  const packageName = optionalStringField(value, "packageName");
  const packagePath = optionalStringField(value, "packagePath");
  const linkFrom = optionalStringArrayField(value, "linkFrom");
  const linkTo = optionalLinkToField(value);
  return {
    ...value,
    ...(leafName === undefined ? {} : { leafName }),
    ...(packageName === undefined ? {} : { packageName }),
    ...(packagePath === undefined ? {} : { packagePath }),
    ...(linkFrom === undefined ? {} : { linkFrom }),
    ...(linkTo === undefined ? {} : { linkTo }),
  };
}

function nodeDeclarationFrom(value: unknown): string {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("nodeDeclaration" in value) ||
    typeof value.nodeDeclaration !== "string"
  ) {
    throw new Error("CLI 生成需要默认组合提供有效的 Node 声明");
  }
  return value.nodeDeclaration;
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const referencePackage = defineReferencePackage({
  manifest: referenceManifest,
  artifactVersion: "0.0.0",
  resourceRoot: new URL("../", import.meta.url),
  alias: "cli-package-addition",
  instance: "independent",
  defaultLeafName: "cli",
  parseCreationInput: parseTsCliCreationInput,
  role: "cli-tool",
  dependencies: [
    {
      key: "base-workspace",
      ownerLocal: {
        specifier: "@ykdz/reference-workspace-root/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
    {
      key: "tooling-config",
      ownerLocal: {
        specifier: "@ykdz/reference-tooling-config/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  rootAttachmentDependencies: [
    {
      key: "npm-publication",
      ownerLocal: {
        specifier: "@ykdz/reference-npm-publication/template",
        resolve: (specifier) => import.meta.resolve(specifier),
      },
    },
  ],
  resources: [
    { path: "resources/gitignore", targetPath: ".gitignore" },
    { path: "resources/npmignore", targetPath: ".npmignore" },
    { path: "src/cli.ts" },
    { path: "src/main.ts" },
    { path: "src/cli-command-identity.ts" },
    { path: "test/e2e/journey.ts" },
    { path: "test/e2e/journeys/lookup.journey.ts" },
    { path: "test/e2e/run-journeys.ts" },
    { path: "test/e2e/source-journeys.test.ts" },
    { path: "test/integration/command.test.ts" },
    { path: "test/unit/cli-command-identity.test.ts" },
    { path: "tsconfig.build.json" },
    { path: "tsconfig.json" },
    { path: "tsconfig.node.json" },
    { path: "turbo.json" },
  ],
  templateDependencies: [
    { name: "@ykdz/tooling-config", purpose: "template-build" },
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "target",
    },
    {
      name: "@ykdz/reference-tooling-config",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/reference-workspace-root",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/reference-npm-publication",
      purpose: "template-execution",
    },
    {
      name: "@ykdz/template-core",
      purpose: "template-build",
    },
    {
      name: "@ykdz/default-content-authoring",
      purpose: "template-execution",
    },
  ],
  executionDependencies: [
    "@ykdz/reference-tooling-config",
    "@ykdz/reference-workspace-root",
    "@ykdz/reference-npm-publication",
    "@ykdz/default-content-authoring",
  ],
  templateScripts: [
    "build:template",
    "check:author-planning-roles",
    "test:template",
  ],
  targetExports: {},
  foundation: {
    toolchains: {},
    editorCapabilities: ["oxc-format-lint"],
    dependencyMaintenance: {
      ecosystems: ["npm", "github-actions", "docker"],
      interval: "weekly",
    },
  },
  environmentNeeds: [],
  transformManifest(options) {
    return projectCliPackageManifest({
      manifest: options.manifest,
      commandName: options.definition.name.slice(
        options.definition.name.lastIndexOf("/") + 1,
      ),
      nodeDeclaration: nodeDeclarationFrom(options.stableCommon),
    });
  },
  transformDocument({ path: documentPath, value }) {
    if (documentPath !== "turbo.json") return value;
    const tasks = recordFrom(value.tasks);
    const build = tasks === undefined ? undefined : recordFrom(tasks.build);
    if (tasks === undefined || build === undefined) {
      throw new Error("CLI 原生 turbo.json 必须声明 build 任务");
    }
    return {
      ...value,
      tasks: {
        ...tasks,
        build: { ...build, dependsOn: ["^build"] },
      },
    };
  },
});
