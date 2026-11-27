import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
      specifier: "@boringparts/reference-vike-web/template",
      load: () => import("@boringparts/reference-vike-web/template"),
    },
    {
      specifier: "@boringparts/reference-vike-db/template",
      load: () => import("@boringparts/reference-vike-db/template"),
    },
    {
      specifier: "@boringparts/reference-vike-migrations/template",
      load: () => import("@boringparts/reference-vike-migrations/template"),
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
      specifier: "@boringparts/preset-vike-app/template",
      load: () => import("@boringparts/preset-vike-app/template"),
    },
  ],
});
const preset = content.find(
  (member) =>
    member.kind === "preset" &&
    member.identity.packageName === "@boringparts/preset-vike-app",
);
assert.ok(preset);

void describe("Vike app public preset installation behavior", () => {
  void it(
    "prepares databases, verifies deployment, and resolves database exports in a generated repository",
    { timeout: 600_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-vike-db-export-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-vike");
      testContext.after(async () =>
        rm(workspace, { recursive: true, force: true }),
      );

      const initialized = await createDefaultGenerator({ content }).init({
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

      await execa("pnpm", ["install"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      for (const profile of ["dev", "test", "e2e"] as const) {
        await execa("pnpm", ["run", `database:prepare:${profile}`], {
          cwd: targetRoot,
          cancelSignal: testContext.signal,
        });
      }
      await execa(
        "pnpm",
        ["--filter", "./apps/web", "run", "browser:prepare"],
        {
          cwd: targetRoot,
          cancelSignal: testContext.signal,
        },
      );
      await execa("pnpm", ["run", "deployment"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      await execa("pnpm", ["--filter", "./packages/db", "run", "typecheck"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      for (const packagePath of [
        "apps/web",
        "packages/db-migrations",
      ] as const) {
        await assert.rejects(
          execa("pnpm", ["--filter", `./${packagePath}`, "run", "typecheck"], {
            cwd: targetRoot,
            cancelSignal: testContext.signal,
          }),
          (error: unknown) => {
            assert.ok(
              typeof error === "object" &&
                error !== null &&
                Object.hasOwn(error, "stdout"),
            );
            const stdout = (error as { readonly stdout: unknown }).stdout;
            assert.ok(typeof stdout === "string" && stdout.includes("TS2307"));
            return true;
          },
        );
      }

      await execa("pnpm", ["exec", "turbo", "run", "typecheck"], {
        cwd: targetRoot,
        cancelSignal: testContext.signal,
      });
      const resolveDatabaseStorage = (conditions: readonly string[] = []) =>
        execa(
          process.execPath,
          [
            ...conditions,
            "--input-type=module",
            "--eval",
            'console.log(import.meta.resolve("@demo/db/storage"));',
          ],
          {
            cwd: path.join(targetRoot, "apps/web"),
            cancelSignal: testContext.signal,
          },
        ).then(({ stdout }) => stdout);

      assert.match(await resolveDatabaseStorage(), /\/dist\/storage\.js$/u);
      assert.match(
        await resolveDatabaseStorage(["--conditions=source"]),
        /\/src\/storage\.ts$/u,
      );
    },
  );
});
