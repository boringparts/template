import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { templateContent, templatePresets } from "@ykdz/template-content";
import { createDefaultGenerator } from "@ykdz/template-workspace/default-generation";
import { execa } from "execa";

import {
  installedIntegrationSignal,
  throwIfInstalledIntegrationWasCancelled,
} from "../../test-support/installed-integration-signal.ts";

function presetFor(packageName: string) {
  const preset = templatePresets.find(
    (candidate) => candidate.identity.packageName === packageName,
  );
  assert.ok(preset, `Missing public preset: ${packageName}`);
  return preset;
}

function createChildEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  environment.PATH = [path.dirname(process.execPath), environment.PATH]
    .filter((entry) => entry !== undefined)
    .join(path.delimiter);
  return environment;
}

function combinedOutput(result: {
  readonly stdout: string;
  readonly stderr: string;
}): string {
  return `${result.stdout}\n${result.stderr}`;
}

void describe("Upstream type declarations and cross-package lint cache invalidation", () => {
  void it(
    "resolves database declarations in clean Vike lint/lint:fix and invalidates downstream lint when upstream returns Promise<void>",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-upstream-types-vike-"),
      );
      const targetRoot = path.join(workspace, "demo-vike");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const preset = presetFor("@ykdz/preset-vike-app");
      const initialized = await createDefaultGenerator({
        content: templateContent,
      }).init({
        targetRoot,
        selection: { presets: [{ contentIdentity: preset.identity }] },
        conventions: {
          repositoryName: "demo-vike",
          defaultPackageScope: "demo",
        },
      });
      assert.strictEqual(
        initialized.status,
        "success",
        JSON.stringify(initialized),
      );

      throwIfInstalledIntegrationWasCancelled();
      const childEnvironment = createChildEnvironment();
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        env: childEnvironment,
        cancelSignal: installedIntegrationSignal(),
      });

      const webTelefuncPath = path.join(
        targetRoot,
        "apps/web/pages/index/+Page.telefunc.ts",
      );
      const migrationsConfigPath = path.join(
        targetRoot,
        "packages/db-migrations/drizzle.config.ts",
      );
      const dbDistDir = path.join(targetRoot, "packages/db/dist");

      const originalWebTelefunc = await readFile(webTelefuncPath, "utf8");
      const originalMigrationsConfig = await readFile(
        migrationsConfigPath,
        "utf8",
      );

      await writeFile(
        webTelefuncPath,
        [
          originalWebTelefunc.trimEnd(),
          "",
          "export async function onCheckFloatingPromise() {",
          "  const { db } = getContext();",
          "  listTodos(db);",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        migrationsConfigPath,
        [
          'import { listTodos } from "@demo/db/queries/todos";',
          "",
          originalMigrationsConfig.trimEnd(),
          "",
          "export function verifyAsyncCall() {",
          "  listTodos(null as never);",
          "}",
          "",
        ].join("\n"),
      );

      const runTurbo = (args: readonly string[]) =>
        execa("pnpm", ["exec", "turbo", "run", ...args], {
          cwd: targetRoot,
          env: childEnvironment,
          cancelSignal: installedIntegrationSignal(),
          reject: false,
        });

      const cleanOutputs = new Map<string, string>();
      for (const [label, filter, task] of [
        ["web-lint", "@demo/web", "lint"],
        ["web-lint:fix", "@demo/web", "lint:fix"],
        ["migrations-lint", "@demo/db-migrations", "lint"],
        ["migrations-lint:fix", "@demo/db-migrations", "lint:fix"],
      ] as const) {
        await rm(dbDistDir, { recursive: true, force: true });
        await assert.rejects(stat(dbDistDir), { code: "ENOENT" });
        const result = await runTurbo([task, `--filter=${filter}`]);
        const output = combinedOutput(result);
        assert.notStrictEqual(result.exitCode, 0, output);
        assert.match(output, /no-floating-promises/u, output);
        cleanOutputs.set(label, output);
      }

      // Database dist is now present from the previous run; forced lint must report the same diagnostic.
      await stat(dbDistDir);
      const prebuiltWebLint = await runTurbo([
        "lint",
        "--filter=@demo/web",
        "--force",
      ]);
      const prebuiltWebOutput = combinedOutput(prebuiltWebLint);
      assert.notStrictEqual(prebuiltWebLint.exitCode, 0, prebuiltWebOutput);
      assert.match(
        prebuiltWebOutput,
        /no-floating-promises/u,
        prebuiltWebOutput,
      );
      const cleanWebLocation = (cleanOutputs.get("web-lint") ?? "").match(
        /\+Page\.telefunc\.ts:\d+:\d+/u,
      )?.[0];
      if (cleanWebLocation === undefined) {
        assert.fail(cleanOutputs.get("web-lint"));
      }
      assert.ok(
        prebuiltWebOutput.includes(cleanWebLocation),
        prebuiltWebOutput,
      );

      const prebuiltMigrationsLint = await runTurbo([
        "lint",
        "--filter=@demo/db-migrations",
        "--force",
      ]);
      const prebuiltMigrationsOutput = combinedOutput(prebuiltMigrationsLint);
      assert.notStrictEqual(
        prebuiltMigrationsLint.exitCode,
        0,
        prebuiltMigrationsOutput,
      );
      assert.match(
        prebuiltMigrationsOutput,
        /no-floating-promises/u,
        prebuiltMigrationsOutput,
      );
      const cleanMigrationsLocation = (
        cleanOutputs.get("migrations-lint") ?? ""
      ).match(/drizzle\.config\.ts:\d+:\d+/u)?.[0];
      if (cleanMigrationsLocation === undefined) {
        assert.fail(cleanOutputs.get("migrations-lint"));
      }
      assert.ok(
        prebuiltMigrationsOutput.includes(cleanMigrationsLocation),
        prebuiltMigrationsOutput,
      );

      // Restore clean migrations config and prepare sync -> async incremental check on @demo/db -> @demo/web.
      await writeFile(migrationsConfigPath, originalMigrationsConfig);
      const dbTodosPath = path.join(
        targetRoot,
        "packages/db/src/queries/todos.ts",
      );
      const originalDbTodos = await readFile(dbTodosPath, "utf8");
      await writeFile(
        dbTodosPath,
        [
          originalDbTodos.trimEnd(),
          "",
          "export function notifyTodo(): void {}",
          "",
        ].join("\n"),
      );
      await writeFile(
        webTelefuncPath,
        [
          'import { createTodo, listTodos, notifyTodo } from "@demo/db/queries/todos";',
          'import { getContext } from "telefunc";',
          "",
          "export async function onLoadTodos() {",
          "  const { db } = getContext();",
          "  notifyTodo();",
          "  return listTodos(db);",
          "}",
          "",
          "export async function onAddTodo(title: string) {",
          "  const { db } = getContext();",
          "  return createTodo(db, { title });",
          "}",
          "",
        ].join("\n"),
      );

      const runCheck = () =>
        execa("pnpm", ["run", "check"], {
          cwd: targetRoot,
          env: childEnvironment,
          cancelSignal: installedIntegrationSignal(),
          reject: false,
        });

      const initialPass = await runCheck();
      assert.strictEqual(initialPass.exitCode, 0, combinedOutput(initialPass));

      // Change only upstream return type from void to Promise<void>; do not touch apps/web or clear cache.
      await writeFile(
        dbTodosPath,
        [
          originalDbTodos.trimEnd(),
          "",
          "export async function notifyTodo(): Promise<void> {}",
          "",
        ].join("\n"),
      );

      const invalidatedFail = await runCheck();
      const invalidatedOutput = combinedOutput(invalidatedFail);
      assert.notStrictEqual(invalidatedFail.exitCode, 0, invalidatedOutput);
      assert.match(
        invalidatedOutput,
        /no-floating-promises/u,
        invalidatedOutput,
      );
      assert.match(
        invalidatedOutput,
        /\+Page\.telefunc\.ts/u,
        invalidatedOutput,
      );

      // Handle the returned Promise and verify pnpm check passes and caches cleanly.
      await writeFile(
        webTelefuncPath,
        (await readFile(webTelefuncPath, "utf8")).replace(
          "  notifyTodo();",
          "  await notifyTodo();",
        ),
      );
      const fixedPass = await runCheck();
      assert.strictEqual(fixedPass.exitCode, 0, combinedOutput(fixedPass));

      const cachedRerun = await runCheck();
      const cachedOutput = combinedOutput(cachedRerun);
      assert.strictEqual(cachedRerun.exitCode, 0, cachedOutput);
      assert.match(cachedOutput, /Cached:\s+[1-9]\d* cached/u, cachedOutput);

      const cachedLintRerun = await runTurbo(["lint"]);
      const cachedLintOutput = combinedOutput(cachedLintRerun);
      assert.strictEqual(cachedLintRerun.exitCode, 0, cachedLintOutput);
      assert.match(cachedLintOutput, /FULL TURBO/u, cachedLintOutput);
    },
  );

  void it(
    "invalidates downstream lint cache in source-linked ts-lib packages when upstream changes void to Promise<void>",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-upstream-types-ts-lib-"),
      );
      const targetRoot = path.join(workspace, "demo-library");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const preset = presetFor("@ykdz/preset-ts-lib");
      const generator = createDefaultGenerator({ content: templateContent });
      const initialized = await generator.init({
        targetRoot,
        selection: { presets: [{ contentIdentity: preset.identity }] },
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

      throwIfInstalledIntegrationWasCancelled();
      const childEnvironment = createChildEnvironment();
      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        env: childEnvironment,
        cancelSignal: installedIntegrationSignal(),
      });

      const providerIndexPath = path.join(
        targetRoot,
        "packages/provider/src/index.ts",
      );
      const consumerIndexPath = path.join(
        targetRoot,
        "packages/lib/src/index.ts",
      );
      const originalProviderIndex = await readFile(providerIndexPath, "utf8");
      const originalConsumerIndex = await readFile(consumerIndexPath, "utf8");

      await writeFile(
        providerIndexPath,
        [
          originalProviderIndex.trimEnd(),
          "",
          "export function ping(): void {}",
          "",
        ].join("\n"),
      );
      await writeFile(
        consumerIndexPath,
        [
          'import { ping } from "@demo/provider";',
          "",
          originalConsumerIndex.trimEnd(),
          "",
          "export function runPing(): void {",
          "  ping();",
          "}",
          "",
        ].join("\n"),
      );

      const runCheck = () =>
        execa("pnpm", ["run", "check"], {
          cwd: targetRoot,
          env: childEnvironment,
          cancelSignal: installedIntegrationSignal(),
          reject: false,
        });

      const initialPass = await runCheck();
      assert.strictEqual(initialPass.exitCode, 0, combinedOutput(initialPass));

      // Change only upstream return type from void to Promise<void>.
      await writeFile(
        providerIndexPath,
        [
          originalProviderIndex.trimEnd(),
          "",
          "export async function ping(): Promise<void> {}",
          "",
        ].join("\n"),
      );

      const invalidatedFail = await runCheck();
      const invalidatedOutput = combinedOutput(invalidatedFail);
      assert.notStrictEqual(invalidatedFail.exitCode, 0, invalidatedOutput);
      assert.match(
        invalidatedOutput,
        /no-floating-promises/u,
        invalidatedOutput,
      );
      assert.match(invalidatedOutput, /src\/index\.ts/u, invalidatedOutput);

      // Handle the returned Promise and verify check passes and subsequent run hits cache.
      await writeFile(
        consumerIndexPath,
        [
          'import { ping } from "@demo/provider";',
          "",
          originalConsumerIndex.trimEnd(),
          "",
          "export async function runPing(): Promise<void> {",
          "  await ping();",
          "}",
          "",
        ].join("\n"),
      );

      const fixedPass = await runCheck();
      assert.strictEqual(fixedPass.exitCode, 0, combinedOutput(fixedPass));

      const cachedRerun = await runCheck();
      const cachedOutput = combinedOutput(cachedRerun);
      assert.strictEqual(cachedRerun.exitCode, 0, cachedOutput);
      assert.match(cachedOutput, /FULL TURBO/u, cachedOutput);
    },
  );
});
