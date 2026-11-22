import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  delete environment.OXLINT_TSGOLINT_PATH;
  environment.PATH = [path.dirname(process.execPath), environment.PATH]
    .filter((entry) => entry !== undefined)
    .join(path.delimiter);
  return environment;
}

function runCommand(
  cwd: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 180_000,
  });
}

void describe("tsrs type-aware lint backend", () => {
  void it(
    "auto-discovers tsrs-lint in generated packages and tooling-config with quiet/warning semantics",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-tsrs-backend-"),
      );
      const targetRoot = path.join(workspace, "generated-ts");
      const preset = presetFor("@ykdz/preset-ts-lib");

      try {
        const initialized = await createDefaultGenerator({
          content: templateContent,
        }).init({
          targetRoot,
          selection: {
            presets: [{ contentIdentity: preset.identity }],
          },
          conventions: {
            repositoryName: "generated-ts",
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

        const env = childEnvironment();
        const libDir = path.join(targetRoot, "packages/lib");
        const toolingConfigDir = path.join(
          targetRoot,
          "packages/tooling-config",
        );

        // 1. Ordinary TS package: clean pass -> floating promise error under --quiet -> fix -> pass.
        const initialLibLint = runCommand(libDir, "pnpm", ["run", "lint"], env);
        assert.strictEqual(
          initialLibLint.status,
          0,
          `${initialLibLint.stdout}\n${initialLibLint.stderr}`,
        );

        const libProbePath = path.join(libDir, "src/floating-probe.ts");
        await writeFile(
          libProbePath,
          [
            "export function triggerFloatingPromise(): void {",
            '  Promise.resolve("unhandled");',
            "}",
            "",
          ].join("\n"),
        );
        const failedLibLint = runCommand(libDir, "pnpm", ["run", "lint"], env);
        const failedLibOutput = `${failedLibLint.stdout}\n${failedLibLint.stderr}`;
        assert.notStrictEqual(failedLibLint.status, 0, failedLibOutput);
        assert.match(failedLibOutput, /no-floating-promises/u);
        assert.match(failedLibOutput, /floating-probe\.ts/u);

        await writeFile(
          libProbePath,
          [
            "export async function triggerFloatingPromise(): Promise<void> {",
            '  await Promise.resolve("handled");',
            "}",
            "",
          ].join("\n"),
        );
        const fixedLibLint = runCommand(libDir, "pnpm", ["run", "lint"], env);
        assert.strictEqual(
          fixedLibLint.status,
          0,
          `${fixedLibLint.stdout}\n${fixedLibLint.stderr}`,
        );
        await rm(libProbePath, { force: true });

        // 2. Warning-only file: --quiet exits 0 silently; without --quiet prints warning and exits 0.
        const warningProbePath = path.join(libDir, "src/warning-probe.ts");
        await writeFile(
          warningProbePath,
          [
            "export function shadowProbe(value: number): number {",
            "  const inner = (() => {",
            "    const value = 2;",
            "    return value;",
            "  })();",
            "  return value + inner;",
            "}",
            "",
          ].join("\n"),
        );
        const quietWarningRun = runCommand(
          libDir,
          "pnpm",
          ["run", "lint"],
          env,
        );
        const quietWarningOutput = `${quietWarningRun.stdout}\n${quietWarningRun.stderr}`;
        assert.strictEqual(quietWarningRun.status, 0, quietWarningOutput);
        assert.doesNotMatch(quietWarningOutput, /warning-probe\.ts/u);
        assert.doesNotMatch(quietWarningOutput, /no-shadow/u);

        const libManifest = JSON.parse(
          await readFile(path.join(libDir, "package.json"), "utf8"),
        ) as { readonly scripts: Readonly<Record<string, string>> };
        const verboseCommand = libManifest.scripts.lint!.replace(
          /--quiet\s*/u,
          "",
        );
        const verboseWarningRun = runCommand(
          libDir,
          "sh",
          ["-c", `PATH="$PWD/node_modules/.bin:$PATH" exec ${verboseCommand}`],
          env,
        );
        const verboseWarningOutput = `${verboseWarningRun.stdout}\n${verboseWarningRun.stderr}`;
        assert.strictEqual(verboseWarningRun.status, 0, verboseWarningOutput);
        assert.match(verboseWarningOutput, /warning-probe\.ts/u);
        assert.match(verboseWarningOutput, /no-shadow/u);
        await rm(warningProbePath, { force: true });

        // 3. packages/tooling-config: both lint and lint:fix enable type-aware checking.
        const initialConfigLint = runCommand(
          toolingConfigDir,
          "pnpm",
          ["run", "lint"],
          env,
        );
        assert.strictEqual(
          initialConfigLint.status,
          0,
          `${initialConfigLint.stdout}\n${initialConfigLint.stderr}`,
        );

        const configProbePath = path.join(
          toolingConfigDir,
          "floating-probe.ts",
        );
        await writeFile(
          configProbePath,
          [
            "export function triggerToolingConfigFloatingPromise(): void {",
            '  Promise.resolve("unhandled");',
            "}",
            "",
          ].join("\n"),
        );

        const failedConfigLint = runCommand(
          toolingConfigDir,
          "pnpm",
          ["run", "lint"],
          env,
        );
        const failedConfigLintOutput = `${failedConfigLint.stdout}\n${failedConfigLint.stderr}`;
        assert.notStrictEqual(
          failedConfigLint.status,
          0,
          failedConfigLintOutput,
        );
        assert.match(failedConfigLintOutput, /no-floating-promises/u);

        const failedConfigLintFix = runCommand(
          toolingConfigDir,
          "pnpm",
          ["run", "lint:fix"],
          env,
        );
        const failedConfigLintFixOutput = `${failedConfigLintFix.stdout}\n${failedConfigLintFix.stderr}`;
        assert.notStrictEqual(
          failedConfigLintFix.status,
          0,
          failedConfigLintFixOutput,
        );
        assert.match(failedConfigLintFixOutput, /no-floating-promises/u);

        await writeFile(
          configProbePath,
          [
            "export async function triggerToolingConfigFloatingPromise(): Promise<void> {",
            '  await Promise.resolve("handled");',
            "}",
            "",
          ].join("\n"),
        );
        const fixedConfigLint = runCommand(
          toolingConfigDir,
          "pnpm",
          ["run", "lint"],
          env,
        );
        assert.strictEqual(
          fixedConfigLint.status,
          0,
          `${fixedConfigLint.stdout}\n${fixedConfigLint.stderr}`,
        );
        const fixedConfigLintFix = runCommand(
          toolingConfigDir,
          "pnpm",
          ["run", "lint:fix"],
          env,
        );
        assert.strictEqual(
          fixedConfigLintFix.status,
          0,
          `${fixedConfigLintFix.stdout}\n${fixedConfigLintFix.stderr}`,
        );
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
