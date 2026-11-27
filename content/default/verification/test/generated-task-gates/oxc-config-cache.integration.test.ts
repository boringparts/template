import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  templateContent,
  templatePresets,
} from "@boringparts/template-content";
import { createDefaultGenerator } from "@boringparts/template-workspace/default-generation";
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

function assertFullTurboHit(output: string): void {
  assert.match(output, /FULL TURBO/u, output);
  assert.match(output, /Cached:\s+(\d+) cached, \1 total/u, output);
}

void describe("generated Oxc config cache invalidation", () => {
  void it(
    "invalidates subpackage lint and format:check caches when root or shared Oxc config changes while preserving untouched cache hits",
    { timeout: 180_000 },
    async () => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-oxc-config-cache-"),
      );
      const targetRoot = path.join(workspace, "generated-oxc-cache");
      const preset = presetFor("@boringparts/preset-ts-lib");
      const currentGenerator = createDefaultGenerator({
        content: templateContent,
      });

      try {
        const initialized = await currentGenerator.init({
          targetRoot,
          selection: {
            presets: [{ contentIdentity: preset.identity }],
          },
          conventions: {
            repositoryName: "generated-oxc-cache",
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

        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        environment.PATH = [path.dirname(process.execPath), environment.PATH]
          .filter((entry) => entry !== undefined)
          .join(path.delimiter);

        const runCheck = () => {
          const result = spawnSync("pnpm", ["run", "check"], {
            cwd: targetRoot,
            encoding: "utf8",
            env: environment,
            maxBuffer: 16 * 1024 * 1024,
            timeout: 180_000,
          });
          return {
            status: result.status,
            output: `${result.stdout}\n${result.stderr}`,
          };
        };

        // 1. Warm cache and verify untouched rerun hits FULL TURBO.
        const initialRun = runCheck();
        assert.strictEqual(initialRun.status, 0, initialRun.output);
        const warmCacheHitRun = runCheck();
        assert.strictEqual(warmCacheHitRun.status, 0, warmCacheHitRun.output);
        assertFullTurboHit(warmCacheHitRun.output);

        const rootLintPath = path.join(targetRoot, "oxlint.config.ts");
        const sharedLintPath = path.join(
          targetRoot,
          "packages/tooling-config/oxlint.config.ts",
        );
        const rootFormatPath = path.join(targetRoot, "oxfmt.config.ts");
        const sharedFormatPath = path.join(
          targetRoot,
          "packages/tooling-config/oxfmt.config.ts",
        );
        const nameSchemaPath = path.join(
          targetRoot,
          "packages/lib/src/name-schema.ts",
        );

        const originalRootLint = await readFile(rootLintPath, "utf8");
        const originalSharedLint = await readFile(sharedLintPath, "utf8");
        const originalRootFormat = await readFile(rootFormatPath, "utf8");
        const originalSharedFormat = await readFile(sharedFormatPath, "utf8");

        // 2(a). Modify only root oxlint.config.ts so existing subpackage code violates an error rule.
        await writeFile(
          rootLintPath,
          [
            'import lintConfiguration from "@generated/tooling-config/oxlint";',
            'import { defineConfig } from "oxlint";',
            "",
            "export default defineConfig({",
            "  extends: [lintConfiguration],",
            "  options: { typeAware: true },",
            '  rules: { "no-restricted-imports": ["error", "zod"] },',
            "});",
            "",
          ].join("\n"),
        );
        const rootLintFail = runCheck();
        assert.notStrictEqual(rootLintFail.status, 0, rootLintFail.output);
        assert.match(
          rootLintFail.output,
          /@generated\/lib:lint:/u,
          rootLintFail.output,
        );
        assert.match(
          rootLintFail.output,
          /no-restricted-imports/u,
          rootLintFail.output,
        );
        assert.doesNotMatch(
          rootLintFail.output,
          /\/\/#lint:/u,
          rootLintFail.output,
        );

        await writeFile(rootLintPath, originalRootLint);
        const afterRootLintRestore = runCheck();
        assert.strictEqual(
          afterRootLintRestore.status,
          0,
          afterRootLintRestore.output,
        );

        // 2(b). Modify only shared tooling-config oxlint.config.ts so subpackage code violates an error rule.
        await writeFile(
          sharedLintPath,
          [
            'import { defineConfig } from "oxlint";',
            "",
            "export default defineConfig({",
            '  categories: { correctness: "error", suspicious: "warn" },',
            '  rules: { "no-restricted-imports": ["error", "zod"] },',
            "});",
            "",
          ].join("\n"),
        );
        const sharedLintFail = runCheck();
        assert.notStrictEqual(sharedLintFail.status, 0, sharedLintFail.output);
        assert.match(
          sharedLintFail.output,
          /@generated\/lib:lint:/u,
          sharedLintFail.output,
        );
        assert.match(
          sharedLintFail.output,
          /no-restricted-imports/u,
          sharedLintFail.output,
        );

        // Fix the business file so it complies with the updated shared lint rule.
        await writeFile(
          nameSchemaPath,
          [
            "export const nameSchema = {",
            "  parse(value: string): string {",
            "    const trimmed = value.trim();",
            '    if (trimmed.length === 0) throw new Error("Empty name");',
            "    return trimmed;",
            "  },",
            "};",
            "",
          ].join("\n"),
        );
        const afterBusinessFix = runCheck();
        assert.strictEqual(afterBusinessFix.status, 0, afterBusinessFix.output);

        await writeFile(sharedLintPath, originalSharedLint);
        const afterSharedLintRestore = runCheck();
        assert.strictEqual(
          afterSharedLintRestore.status,
          0,
          afterSharedLintRestore.output,
        );

        // 2(c). Modify root oxfmt.config.ts and verify subpackage format:check reruns and fails.
        await writeFile(
          rootFormatPath,
          [
            'import formatConfiguration from "@generated/tooling-config/oxfmt";',
            'import { defineConfig } from "oxfmt";',
            "",
            "export default defineConfig({",
            "  ...formatConfiguration,",
            "  singleQuote: true,",
            "});",
            "",
          ].join("\n"),
        );
        const rootFormatFail = runCheck();
        assert.notStrictEqual(rootFormatFail.status, 0, rootFormatFail.output);
        assert.match(
          rootFormatFail.output,
          /@generated\/lib:format:check:/u,
          rootFormatFail.output,
        );

        await writeFile(rootFormatPath, originalRootFormat);
        const afterRootFormatRestore = runCheck();
        assert.strictEqual(
          afterRootFormatRestore.status,
          0,
          afterRootFormatRestore.output,
        );

        // Modify shared tooling-config oxfmt.config.ts and verify subpackage format:check reruns and fails.
        await writeFile(
          sharedFormatPath,
          [
            'import { defineConfig } from "oxfmt";',
            "",
            "export default defineConfig({",
            "  printWidth: 80,",
            "  sortImports: true,",
            "  singleQuote: true,",
            "});",
            "",
          ].join("\n"),
        );
        const sharedFormatFail = runCheck();
        assert.notStrictEqual(
          sharedFormatFail.status,
          0,
          sharedFormatFail.output,
        );
        assert.match(
          sharedFormatFail.output,
          /@generated\/lib:format:check:/u,
          sharedFormatFail.output,
        );

        // 2(d). Restore compliance and verify pnpm check passes and untouched rerun hits cache.
        await writeFile(sharedFormatPath, originalSharedFormat);
        const restoredPass = runCheck();
        assert.strictEqual(restoredPass.status, 0, restoredPass.output);
        const finalCacheHitRun = runCheck();
        assert.strictEqual(finalCacheHitRun.status, 0, finalCacheHitRun.output);
        assertFullTurboHit(finalCacheHitRun.output);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
