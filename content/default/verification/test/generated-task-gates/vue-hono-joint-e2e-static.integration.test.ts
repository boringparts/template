import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { inspectTaskGate } from "@ykdz/reference-workspace-root/task-gates";
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

function gateTaskNames(
  gate: "check" | "check:heavy",
  repositoryRoot: string,
): Set<string> {
  const turboCommand = [
    process.execPath,
    fileURLToPath(import.meta.resolve("turbo")),
  ] as const;
  const inspection = inspectTaskGate(
    gate,
    repositoryRoot,
    undefined,
    turboCommand,
  );
  assert.deepStrictEqual(inspection.diagnostics, []);
  return new Set(
    inspection.plans.flatMap((plan) => plan.tasks.map((task) => task.fullName)),
  );
}

void describe("Vue-Hono joint E2E static checks", () => {
  void it(
    "catches and auto-fixes format and lint errors in root test/e2e during light check without starting a browser",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-vue-hono-e2e-static-"),
      );
      const targetRoot = path.join(workspace, "generated-vue-hono");
      const preset = presetFor("@ykdz/preset-vue-hono-app");

      try {
        const initialized = await createDefaultGenerator({
          content: templateContent,
        }).init({
          targetRoot,
          selection: {
            presets: [{ contentIdentity: preset.identity }],
          },
          conventions: {
            repositoryName: "generated-vue-hono",
            defaultPackageScope: "generated",
          },
        });
        assert.strictEqual(
          initialized.status,
          "success",
          JSON.stringify(initialized),
        );

        throwIfInstalledIntegrationWasCancelled();
        await execa("pnpm", ["install"], {
          cwd: targetRoot,
          cancelSignal: installedIntegrationSignal(),
        });

        const lightTasks = gateTaskNames("check", targetRoot);
        const heavyTasks = gateTaskNames("check:heavy", targetRoot);
        assert.ok(lightTasks.has("//#format:check"));
        assert.ok(lightTasks.has("//#lint"));
        assert.ok(lightTasks.has("//#typecheck"));
        assert.ok(!lightTasks.has("//#test:e2e"));
        assert.ok(heavyTasks.has("//#test:e2e"));

        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: path.join(workspace, "no-browsers"),
        };
        delete environment.NODE_TEST_CONTEXT;
        environment.PATH = [path.dirname(process.execPath), environment.PATH]
          .filter((entry) => entry !== undefined)
          .join(path.delimiter);

        const runRootCommand = (command: "check" | "fix") =>
          spawnSync("pnpm", ["run", command], {
            cwd: targetRoot,
            encoding: "utf8",
            env: environment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 180_000,
          });

        const initialCheck = runRootCommand("check");
        assert.strictEqual(
          initialCheck.status,
          0,
          `${initialCheck.stdout}\n${initialCheck.stderr}`,
        );

        const appSpecPath = path.join(targetRoot, "test/e2e/app.spec.ts");
        const originalAppSpec = await readFile(appSpecPath, "utf8");

        const unformattedAppSpec = originalAppSpec.replace(
          'import { expect, test } from "./fixtures.ts";',
          'import {   expect,   test   }   from   "./fixtures.ts";',
        );
        assert.notStrictEqual(unformattedAppSpec, originalAppSpec);
        await writeFile(appSpecPath, unformattedAppSpec);

        const formatFailure = runRootCommand("check");
        const formatFailureOutput = `${formatFailure.stdout}\n${formatFailure.stderr}`;
        assert.notStrictEqual(formatFailure.status, 0, formatFailureOutput);
        assert.ok(
          formatFailureOutput.includes("test/e2e/app.spec.ts"),
          formatFailureOutput,
        );

        const formatFix = runRootCommand("fix");
        assert.strictEqual(
          formatFix.status,
          0,
          `${formatFix.stdout}\n${formatFix.stderr}`,
        );
        assert.strictEqual(
          await readFile(appSpecPath, "utf8"),
          originalAppSpec,
        );

        const checkAfterFormatFix = runRootCommand("check");
        assert.strictEqual(
          checkAfterFormatFix.status,
          0,
          `${checkAfterFormatFix.stdout}\n${checkAfterFormatFix.stderr}`,
        );

        const lintInvalidAppSpec = `${originalAppSpec}export {};\n`;
        await writeFile(appSpecPath, lintInvalidAppSpec);

        const lintFailure = runRootCommand("check");
        const lintFailureOutput = `${lintFailure.stdout}\n${lintFailure.stderr}`;
        assert.notStrictEqual(lintFailure.status, 0, lintFailureOutput);
        assert.ok(
          lintFailureOutput.includes("test/e2e/app.spec.ts"),
          lintFailureOutput,
        );

        const lintFix = runRootCommand("fix");
        assert.strictEqual(
          lintFix.status,
          0,
          `${lintFix.stdout}\n${lintFix.stderr}`,
        );

        const checkAfterLintFix = runRootCommand("check");
        assert.strictEqual(
          checkAfterLintFix.status,
          0,
          `${checkAfterLintFix.stdout}\n${checkAfterLintFix.stderr}`,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
