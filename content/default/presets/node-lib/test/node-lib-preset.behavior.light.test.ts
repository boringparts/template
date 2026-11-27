import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { loadContentSource } from "@boringparts/template-generator/content-source";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";
import { parse as parseYaml } from "yaml";

const content = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@boringparts/reference-workspace-root/template",
      load: () => import("@boringparts/reference-workspace-root/template"),
    },
    {
      specifier: "@boringparts/reference-node-lib/template",
      load: () => import("@boringparts/reference-node-lib/template"),
    },
    {
      specifier: "@boringparts/reference-tooling-config/template",
      load: () => import("@boringparts/reference-tooling-config/template"),
    },
    {
      specifier: "@boringparts/reference-npm-publication/template",
      load: () => import("@boringparts/reference-npm-publication/template"),
    },
    {
      specifier: "@boringparts/preset-node-lib/template",
      load: () => import("@boringparts/preset-node-lib/template"),
    },
  ],
});

const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-node-lib",
);
assert.ok(preset);

const temporaryRoots = new Set<string>();

async function createTemporaryRoot(prefix: string, name = "demo") {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.add(temporaryRoot);
  return path.join(temporaryRoot, name);
}

after(async () => {
  await Promise.all(
    [...temporaryRoots].map((temporaryRoot) =>
      rm(temporaryRoot, { recursive: true, force: true }),
    ),
  );
});

void describe("Node.js library public preset", () => {
  void it("initializes, adds packages repeatedly, and projects catalog:node-24 on demand", async () => {
    const targetRoot = await createTemporaryRoot("template-node-lib-preset-");
    const generator = createDefaultGenerator({ content });
    const initialized = await generator.init({
      targetRoot,
      selection: { presets: [{ contentIdentity: preset.identity }] },
      conventions: { repositoryName: "demo", defaultPackageScope: "demo" },
    });

    assert.strictEqual(
      initialized.status,
      "success",
      JSON.stringify(initialized),
    );
    const packageRoot = path.join(targetRoot, "packages/node-lib");
    assert.strictEqual(
      (await stat(path.join(packageRoot, "src/index.ts"))).mode & 0o777,
      0o644,
    );

    const manifest = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly imports?: unknown;
      readonly devEngines?: {
        readonly runtime?: {
          readonly name?: string;
          readonly version?: string;
          readonly onFail?: string;
        };
      };
      readonly engines?: { readonly node?: string };
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly devDependencies?: Readonly<Record<string, string>>;
      readonly scripts: Readonly<Record<string, string>>;
    };
    assert.strictEqual(manifest.name, "@demo/node-lib");
    assert.strictEqual("imports" in manifest, false);
    assert.deepStrictEqual(manifest.devEngines, {
      runtime: {
        name: "node",
        version: "24.0.0",
        onFail: "download",
      },
    });
    assert.deepStrictEqual(manifest.engines, { node: ">=24.0.0" });
    assert.strictEqual(manifest.dependencies?.zod, "catalog:");
    assert.strictEqual(
      manifest.devDependencies?.["@types/node"],
      "catalog:node-24",
    );
    assert.match(manifest.scripts.test ?? "", /--conditions=source/u);
    assert.strictEqual(
      manifest.scripts["test:dist"],
      "node --test --test-reporter=spec 'test/**/*.test.ts'",
    );

    const manifestKeys = Object.keys(manifest);
    assert.ok(
      manifestKeys.indexOf("devEngines") < manifestKeys.indexOf("engines"),
    );

    const workspaceYaml = parseYaml(
      await readFile(path.join(targetRoot, "pnpm-workspace.yaml"), "utf8"),
    ) as {
      readonly catalogs?: Readonly<
        Record<string, Readonly<Record<string, string>>>
      >;
      readonly minimumReleaseAgeExclude?: unknown;
    };
    assert.deepStrictEqual(workspaceYaml.catalogs, {
      "node-24": {
        "@types/node": "~24.0.0",
      },
    });
    assert.strictEqual("minimumReleaseAgeExclude" in workspaceYaml, false);

    const nodeTsconfig = JSON.parse(
      await readFile(path.join(packageRoot, "tsconfig.node.json"), "utf8"),
    ) as {
      readonly compilerOptions: {
        readonly lib?: readonly string[];
        readonly skipLibCheck?: boolean;
        readonly types?: readonly string[];
      };
    };
    assert.deepStrictEqual(nodeTsconfig.compilerOptions.lib, ["es2024"]);
    assert.strictEqual(nodeTsconfig.compilerOptions.skipLibCheck, true);
    assert.deepStrictEqual(nodeTsconfig.compilerOptions.types, ["node"]);

    const buildTsconfig = JSON.parse(
      await readFile(path.join(packageRoot, "tsconfig.build.json"), "utf8"),
    ) as {
      readonly compilerOptions: {
        readonly customConditions?: readonly string[];
        readonly skipLibCheck?: boolean;
        readonly types?: readonly string[];
      };
    };
    assert.deepStrictEqual(buildTsconfig.compilerOptions.customConditions, []);
    assert.strictEqual("skipLibCheck" in buildTsconfig.compilerOptions, false);
    assert.deepStrictEqual(buildTsconfig.compilerOptions.types, ["node"]);

    const entrySource = await readFile(
      path.join(packageRoot, "src/index.ts"),
      "utf8",
    );
    assert.match(entrySource, /from "\.\/artifact-schema\.ts"/u);
    assert.doesNotMatch(entrySource, /#\/artifact-schema/u);

    const testSource = await readFile(
      path.join(packageRoot, "test/artifact-key.test.ts"),
      "utf8",
    );
    assert.match(testSource, /from "@demo\/node-lib"/u);

    const added = await generator.add({
      repositoryRoot: targetRoot,
      preset: preset.identity,
      creationInput: { leafName: "extra-node-lib" },
    });
    assert.strictEqual(added.status, "success", JSON.stringify(added));
    const addedManifest = JSON.parse(
      await readFile(
        path.join(targetRoot, "packages/extra-node-lib/package.json"),
        "utf8",
      ),
    ) as { readonly name: string; readonly role?: unknown };
    assert.strictEqual(addedManifest.name, "@demo/extra-node-lib");

    const blueprint = JSON.parse(
      await readFile(path.join(targetRoot, ".template/blueprint.json"), "utf8"),
    ) as {
      readonly packages: readonly {
        readonly path: string;
        readonly role: string;
      }[];
    };
    assert.ok(
      blueprint.packages.some(
        (pkg) =>
          pkg.path === "packages/node-lib" && pkg.role === "node-library",
      ),
    );
    assert.ok(
      blueprint.packages.some(
        (pkg) =>
          pkg.path === "packages/extra-node-lib" && pkg.role === "node-library",
      ),
    );
  });
});
