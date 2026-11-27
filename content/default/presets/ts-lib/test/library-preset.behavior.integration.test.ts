import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadContentSource } from "@boringparts/template-generator/content-source";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";
import { execa } from "execa";

const content = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@boringparts/reference-workspace-root/template",
      load: () => import("@boringparts/reference-workspace-root/template"),
    },
    {
      specifier: "@boringparts/reference-ts-lib/template",
      load: () => import("@boringparts/reference-ts-lib/template"),
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
      specifier: "@boringparts/preset-ts-lib/template",
      load: () => import("@boringparts/preset-ts-lib/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-ts-lib",
);
assert.ok(preset);

void describe("TypeScript library public preset installation behavior", () => {
  void it(
    "applies source links immediately and runs from built output alone after Turbo dependency builds",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-provider-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-library");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const generator = createDefaultGenerator({ content });
      const initialized = await generator.init({
        targetRoot,
        selection: {
          presets: [{ contentIdentity: preset.identity }],
        },
        conventions: {
          repositoryName: "demo-library",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

      const added = await generator.add({
        repositoryRoot: targetRoot,
        preset: preset.identity,
        creationInput: {
          leafName: "provider",
          packagePath: "packages/provider",
          linkFrom: ["packages/lib"],
        },
      });
      assert.strictEqual(added.status, "success", JSON.stringify(added));

      const consumerRoot = path.join(targetRoot, "packages/lib");
      const providerSource = path.join(
        targetRoot,
        "packages/provider/src/index.ts",
      );
      await writeFile(
        path.join(consumerRoot, "src/observe-provider.ts"),
        [
          'import { greet } from "@demo/provider";',
          "",
          "export function observeProvider(): string {",
          '  return greet("Ada").message;',
          "}",
          "",
        ].join("\n"),
      );
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });

      const runSource = () =>
        execa(
          process.execPath,
          [
            "--conditions=source",
            "--input-type=module",
            "--eval",
            'import { observeProvider } from "./src/observe-provider.ts"; console.log(observeProvider());',
          ],
          { cwd: consumerRoot, cancelSignal: testContext.signal },
        ).then(({ stdout }) => stdout);
      assert.strictEqual(await runSource(), "Hello, Ada");
      await writeFile(
        providerSource,
        (await readFile(providerSource, "utf8")).replace(
          "Hello,",
          "Linked source:",
        ),
      );
      const sourceOutput = await runSource();
      assert.strictEqual(sourceOutput, "Linked source: Ada");

      const beforeProviderBuild = await execa(
        "pnpm",
        ["--filter", "./packages/lib", "run", "build"],
        { cwd: targetRoot, cancelSignal: testContext.signal, reject: false },
      );
      assert.notStrictEqual(beforeProviderBuild.exitCode, 0);

      const dryRun = await execa(
        "pnpm",
        ["exec", "turbo", "run", "typecheck", "build", "--dry-run=json"],
        { cwd: targetRoot, cancelSignal: testContext.signal },
      );
      const tasks = (
        JSON.parse(dryRun.stdout) as {
          readonly tasks: readonly {
            readonly taskId: string;
            readonly dependencies: readonly string[];
          }[];
        }
      ).tasks;
      const consumerBuild = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#build",
      );
      const consumerTypecheck = tasks.find(
        ({ taskId }) => taskId === "@demo/lib#typecheck",
      );
      assert.ok(consumerBuild);
      assert.ok(consumerTypecheck);
      assert.ok(consumerBuild.dependencies.includes("@demo/provider#build"));
      assert.ok(
        consumerTypecheck.dependencies.includes("@demo/provider#typecheck"),
      );
      assert.ok(
        !consumerTypecheck.dependencies.includes("@demo/provider#build"),
      );
      const obsoleteSource = path.join(consumerRoot, "src/obsolete.ts");
      const obsoleteOutput = path.join(consumerRoot, "dist/obsolete.js");
      await writeFile(obsoleteSource, "export const obsolete = true;\n");
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      assert.match(await readFile(obsoleteOutput, "utf8"), /obsolete/u);
      await rm(obsoleteSource);
      await execa("pnpm", ["exec", "turbo", "run", "build", "--force"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      await assert.rejects(readFile(obsoleteOutput), { code: "ENOENT" });
      await rm(path.join(targetRoot, "packages/provider/src"), {
        recursive: true,
        force: true,
      });
      assert.strictEqual(
        await execa(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            'import { observeProvider } from "./dist/observe-provider.js"; console.log(observeProvider());',
          ],
          {
            cwd: consumerRoot,
            cancelSignal: testContext.signal,
          },
        ).then(({ stdout }) => stdout),
        sourceOutput,
      );
      assert.match(
        await readFile(
          path.join(targetRoot, "packages/provider/dist/index.d.ts"),
          "utf8",
        ),
        /declare function greet/u,
      );
    },
  );

  void it(
    "runs source and built-output self-reference tests and rejects Node or DOM globals during build",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-ts-lib-neutral-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-neutral-library");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const generator = createDefaultGenerator({ content });
      const initialized = await generator.init({
        targetRoot,
        selection: {
          presets: [{ contentIdentity: preset.identity }],
        },
        conventions: {
          repositoryName: "demo-neutral-library",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });

      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT;

      const sourceTest = await execa(
        "pnpm",
        ["--filter", "./packages/lib", "run", "test"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(sourceTest.exitCode, 0);

      const distTest = await execa(
        "pnpm",
        ["exec", "turbo", "run", "test:dist", "--filter=./packages/lib"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(distTest.exitCode, 0);

      const libraryRoot = path.join(targetRoot, "packages/lib");
      const builtJs = await readFile(
        path.join(libraryRoot, "dist/index.js"),
        "utf8",
      );
      const builtDts = await readFile(
        path.join(libraryRoot, "dist/index.d.ts"),
        "utf8",
      );
      assert.match(builtJs, /from "\.\/name-schema\.js"/u);
      assert.doesNotMatch(builtJs, /#\/name-schema|\.ts/u);
      assert.match(builtDts, /declare function greet/u);
      assert.doesNotMatch(builtDts, /#\/name-schema|\.ts/u);

      // Prove skipLibCheck: true is genuinely required under pure es2024 + types: []:
      // zod's .d.cts references the global URL type, which is absent without DOM/Node types.
      const strictLibCheckFailure = await execa(
        "pnpm",
        [
          "exec",
          "tsc",
          "-p",
          "tsconfig.build.json",
          "--skipLibCheck",
          "false",
          "--noEmit",
          "--pretty",
          "false",
        ],
        {
          cwd: libraryRoot,
          env: environment,
          cancelSignal: testContext.signal,
          reject: false,
        },
      );
      assert.notStrictEqual(strictLibCheckFailure.exitCode, 0);
      assert.match(
        `${strictLibCheckFailure.stdout}\n${strictLibCheckFailure.stderr}`,
        /Cannot find name 'URL'/u,
      );

      const leakPath = path.join(libraryRoot, "src/platform-leak.ts");
      for (const [label, code] of [
        [
          "node:* module",
          'import { readFileSync } from "node:fs";\nexport const leak = readFileSync;\n',
        ],
        ["Node global process", "export const leak = process.env;\n"],
        ["DOM global window", "export const leak = window.location;\n"],
      ] as const) {
        await writeFile(leakPath, code);
        const buildFailure = await execa(
          "pnpm",
          ["--filter", "./packages/lib", "run", "build"],
          {
            cwd: targetRoot,
            env: environment,
            cancelSignal: testContext.signal,
            reject: false,
          },
        );
        assert.notStrictEqual(
          buildFailure.exitCode,
          0,
          `Expected build to fail for ${label}`,
        );
      }

      await rm(leakPath);
      const cleanBuild = await execa(
        "pnpm",
        ["--filter", "./packages/lib", "run", "build"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(cleanBuild.exitCode, 0);
    },
  );
});
