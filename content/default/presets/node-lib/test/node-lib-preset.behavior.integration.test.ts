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

void describe("Node.js library public preset installation behavior", () => {
  void it(
    "executes source and built-output tests under Node 24.0.0 and enforces the @types/node@~24.0.0 surface",
    { timeout: 300_000 },
    async (testContext) => {
      const workspace = await mkdtemp(
        path.join(tmpdir(), "template-node-lib-integration-"),
      );
      const targetRoot = path.join(workspace, "demo-node-library");
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
          repositoryName: "demo-node-library",
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

      const nodeVersion = await execa(
        "pnpm",
        ["--filter", "./packages/node-lib", "exec", "node", "-v"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(nodeVersion.stdout.trim(), "v24.0.0");

      const sourceTest = await execa(
        "pnpm",
        ["--filter", "./packages/node-lib", "run", "test"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(sourceTest.exitCode, 0);

      const distTest = await execa(
        "pnpm",
        ["exec", "turbo", "run", "test:dist", "--filter=./packages/node-lib"],
        {
          cwd: targetRoot,
          env: environment,
          cancelSignal: testContext.signal,
        },
      );
      assert.strictEqual(distTest.exitCode, 0);

      const libraryRoot = path.join(targetRoot, "packages/node-lib");
      const builtJs = await readFile(
        path.join(libraryRoot, "dist/index.js"),
        "utf8",
      );
      const builtDts = await readFile(
        path.join(libraryRoot, "dist/index.d.ts"),
        "utf8",
      );
      assert.match(builtJs, /from "\.\/artifact-schema\.js"/u);
      assert.doesNotMatch(builtJs, /#\/artifact-schema|\.ts/u);
      assert.match(builtDts, /declare function createArtifactKey/u);
      assert.doesNotMatch(builtDts, /#\/artifact-schema/u);

      // Prove skipLibCheck: true is genuinely required under exactOptionalPropertyTypes + @types/node@~24.0.0:
      // @types/node@24.0.x https.d.ts extends http.AgentOptions and tls.ConnectionOptions with mismatched port optionality.
      const strictLibCheckFailure = await execa(
        "pnpm",
        [
          "exec",
          "tsc",
          "-p",
          "tsconfig.node.json",
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
        /https\.d\.ts.*AgentOptions/u,
      );

      const leakPath = path.join(libraryRoot, "src/compat-leak.ts");
      for (const [label, code] of [
        [
          "post-24.0 Node API",
          'import { convertProcessSignalToExitCode } from "node:util";\nexport const leak = convertProcessSignalToExitCode;\n',
        ],
        ["DOM global window", "export const leak = window.location;\n"],
      ] as const) {
        await writeFile(leakPath, code);
        const buildFailure = await execa(
          "pnpm",
          ["--filter", "./packages/node-lib", "run", "build"],
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
        ["--filter", "./packages/node-lib", "run", "build"],
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
