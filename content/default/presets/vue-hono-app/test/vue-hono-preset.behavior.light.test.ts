import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { honoApiDependencyKey } from "@boringparts/reference-vue-hono-web/template";
import {
  contentIdentityKey,
  type ContentIdentity,
  type LoadedContentMember,
} from "@boringparts/template-core/content-identity";
import { loadContentSource } from "@boringparts/template-generator/content-source";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";

const content = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@boringparts/reference-workspace-root/template",
      load: () => import("@boringparts/reference-workspace-root/template"),
    },
    {
      specifier: "@boringparts/reference-hono-api/template",
      load: () => import("@boringparts/reference-hono-api/template"),
    },
    {
      specifier: "@boringparts/reference-vue-hono-web/template",
      load: () => import("@boringparts/reference-vue-hono-web/template"),
    },
    {
      specifier: "@boringparts/reference-tooling-config/template",
      load: () => import("@boringparts/reference-tooling-config/template"),
    },
    {
      specifier: "@boringparts/reference-ts-lib/template",
      load: () => import("@boringparts/reference-ts-lib/template"),
    },
    {
      specifier: "@boringparts/reference-npm-publication/template",
      load: () => import("@boringparts/reference-npm-publication/template"),
    },
    {
      specifier: "@boringparts/preset-vue-hono-app/template",
      load: () => import("@boringparts/preset-vue-hono-app/template"),
    },
  ],
});

function member(
  kind: "preset" | "reference",
  packageName: string,
): LoadedContentMember {
  const found = content.find(
    (item) => item.kind === kind && item.identity.packageName === packageName,
  );
  assert.ok(
    found,
    `Explicit content collection is missing ${kind} ${packageName}`,
  );
  return found;
}

const root = member("reference", "@boringparts/reference-workspace-root");
const api = member("reference", "@boringparts/reference-hono-api");
const web = member("reference", "@boringparts/reference-vue-hono-web");
const library = member("reference", "@boringparts/reference-ts-lib");
const preset = member("preset", "@boringparts/preset-vue-hono-app");

const conventions = {
  repositoryName: "demo",
  defaultPackageScope: "demo",
};

const temporaryRoots = new Set<string>();

async function createTargetRoot(prefix: string): Promise<string> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, "demo");
}

async function snapshotTree(targetRoot: string): Promise<
  readonly {
    readonly path: string;
    readonly mode: number;
    readonly bytes: string;
  }[]
> {
  const entries: { path: string; mode: number; bytes: string }[] = [];
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const entryPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, entryPath);
      } else {
        entries.push({
          path: entryPath,
          mode: (await stat(absolutePath)).mode & 0o777,
          bytes: (await readFile(absolutePath)).toString("base64"),
        });
      }
    }
  }
  await visit(targetRoot);
  return entries;
}

function generator() {
  return createDefaultGenerator({ content });
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Vue-Hono composite preset public behavior", () => {
  void it("initializes native packages, bindings, joint E2E resources, and root declarations and retains them on replay", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-preset-");
    const initialized = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    const packages = initialized.blueprint.packages;
    const rootPackage = packages.find(
      ({ path: packagePath }) => packagePath === ".",
    );
    const apiPackage = packages.find(
      ({ path: packagePath }) => packagePath === "apps/api",
    );
    const webPackage = packages.find(
      ({ path: packagePath }) => packagePath === "apps/web",
    );
    assert.ok(rootPackage);
    assert.ok(apiPackage);
    assert.ok(webPackage);
    assert.ok(
      packages.some(
        ({ path: packagePath }) => packagePath === "packages/tooling-config",
      ),
    );
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      {
        consumerId: webPackage.packageDefinitionId,
        providerId: apiPackage.packageDefinitionId,
      },
    ]);
    assert.deepStrictEqual(
      initialized.generationRecord.selections.map(
        ({ presetIdentity }) => presetIdentity,
      ),
      [preset.identity],
    );

    const playwrightPath = path.join(targetRoot, "playwright.config.ts");
    const playwrightBeforeAdd = await readFile(playwrightPath, "utf8");
    assert.match(playwrightBeforeAdd, /const apiPackageName = "@demo\/api";/u);
    assert.match(playwrightBeforeAdd, /const webPackageName = "@demo\/web";/u);

    const webManifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.strictEqual(webManifest.dependencies["@demo/api"], "workspace:*");
    assert.ok(webManifest.devDependencies?.typescript);
    assert.strictEqual(
      webManifest.devDependencies?.["typescript-7"],
      undefined,
    );
    const webTurbo = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/turbo.json"), "utf8"),
    ) as { tasks: Record<string, { dependsOn?: readonly string[] }> };
    assert.deepStrictEqual(webTurbo.tasks.lint?.dependsOn, [
      "@demo/api#build",
      "^lint",
    ]);
    assert.deepStrictEqual(webTurbo.tasks["lint:fix"]?.dependsOn, [
      "@demo/api#build",
    ]);

    const rootManifest = JSON.parse(
      await readFile(path.join(targetRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    assert.strictEqual(rootManifest.scripts["test:e2e"], "playwright test");
    for (const scriptName of [
      "format:check",
      "format:write",
      "lint",
      "lint:fix",
    ] as const) {
      const tokens = (rootManifest.scripts[scriptName] ?? "").split(/\s+/u);
      assert.ok(
        tokens.includes("test"),
        `root ${scriptName} must include test directory`,
      );
    }
    const turbo = JSON.parse(
      await readFile(path.join(targetRoot, "turbo.json"), "utf8"),
    ) as {
      tasks: Record<
        string,
        { dependsOn?: readonly string[]; tags?: readonly string[] }
      >;
    };
    assert.deepStrictEqual(turbo.tasks["//#test:e2e"]?.tags, ["quality:heavy"]);
    assert.deepStrictEqual(turbo.tasks["//#test:e2e"]?.dependsOn, [
      "@demo/api#build",
      "@demo/web#build",
      "@demo/web#browser:prepare",
    ]);
    const typeScriptConfiguration = JSON.parse(
      await readFile(path.join(targetRoot, "tsconfig.config.json"), "utf8"),
    ) as { include: readonly string[] };
    assert.ok(typeScriptConfiguration.include.includes("test/**/*.ts"));

    assert.ok(
      initialized.ownerFacts.environmentNeeds.check.some(
        (need) =>
          need.kind === "playwright-browser-assets" &&
          need.owner?.kind === "workspace-orchestration" &&
          need.owner.path === ".",
      ),
    );
    assert.match(
      await readFile(
        path.join(targetRoot, ".github/workflows/check.yml"),
        "utf8",
      ),
      /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS:[^\n]*\n\s+\./u,
    );

    const beforeUnsupportedAdd = await snapshotTree(targetRoot);
    const unsupportedAdd = await generator().add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
    });
    assert.strictEqual(
      unsupportedAdd.status,
      "operation-failure",
      JSON.stringify(unsupportedAdd),
    );
    assert.deepStrictEqual(
      await snapshotTree(targetRoot),
      beforeUnsupportedAdd,
    );

    const added = await generator().add({
      repositoryRoot: targetRoot,
      contentIdentity: library.identity,
      creationInput: { leafName: "extra" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    assert.strictEqual(
      await readFile(playwrightPath, "utf8"),
      playwrightBeforeAdd,
    );
    const updatedRecord = JSON.parse(
      await readFile(
        path.join(targetRoot, ".template/generation.json"),
        "utf8",
      ),
    ) as {
      packages: {
        contentIdentity: ContentIdentity;
        packageDefinitionId: string;
      }[];
      selections: {
        presetIdentity: ContentIdentity | null;
        nodes: Record<string, string>;
      }[];
    };
    assert.strictEqual(
      updatedRecord.packages.find(
        ({ contentIdentity }) =>
          contentIdentityKey(contentIdentity) ===
          contentIdentityKey(root.identity),
      )?.packageDefinitionId,
      rootPackage.packageDefinitionId,
    );
    assert.strictEqual(
      updatedRecord.selections[0]?.presetIdentity?.packageName,
      preset.identity.packageName,
    );
    assert.ok(
      updatedRecord.packages.some(
        ({ contentIdentity }) =>
          contentIdentityKey(contentIdentity) ===
          contentIdentityKey(library.identity),
      ),
    );
  });

  void it("binds web and API instances directly by public content identity", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-direct-");
    const initialized = await generator().init({
      targetRoot,
      selection: {
        roots: [
          {
            nodeIdentity: "web",
            contentIdentity: web.identity,
            dependencyBindings: { [honoApiDependencyKey]: "api" },
          },
          { nodeIdentity: "api", contentIdentity: api.identity },
        ],
      },
      conventions,
    });
    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    if (initialized.status !== "success") return;

    const webRecord = initialized.generationRecord.packages.find(
      ({ contentIdentity }) =>
        contentIdentityKey(contentIdentity) ===
        contentIdentityKey(web.identity),
    );
    const apiPackageId = webRecord?.dependencyBindings[honoApiDependencyKey];
    const apiPackage = initialized.blueprint.packages.find(
      ({ packageDefinitionId }) => packageDefinitionId === apiPackageId,
    );
    const webPackage = initialized.blueprint.packages.find(
      ({ path: packagePath }) => packagePath === "apps/web",
    );
    assert.ok(apiPackage);
    assert.ok(webPackage);
    assert.deepStrictEqual(initialized.blueprint.packageLinkIntents, [
      {
        consumerId: webPackage.packageDefinitionId,
        providerId: apiPackage.packageDefinitionId,
      },
    ]);
    const manifest = JSON.parse(
      await readFile(path.join(targetRoot, "apps/web/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    assert.strictEqual(manifest.dependencies["@demo/api"], "workspace:*");
  });

  void it("commits no generated files when a joint root file conflicts", async () => {
    const targetRoot = await createTargetRoot("template-vue-hono-conflict-");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(
      path.join(targetRoot, "playwright.config.ts"),
      "export default {};\n",
    );
    const before = await snapshotTree(targetRoot);
    const result = await generator().init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions,
    });
    assert.strictEqual(result.status, "conflict", JSON.stringify(result));
    assert.deepStrictEqual(await snapshotTree(targetRoot), before);
  });
});
