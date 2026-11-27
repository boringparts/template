import assert from "node:assert/strict";
import { it } from "node:test";

import type { SharedRootContribution } from "@boringparts/default-content-authoring/contracts";
import {
  composeCheckWorkflow,
  composeSharedRootFiles,
} from "@boringparts/template-workspace/shared-root-files";
import { parse as parseYaml } from "yaml";

function compose(declarations: readonly SharedRootContribution[]) {
  return composeSharedRootFiles({
    source: "base-workspace",
    manifest: { scripts: { "base:check": "node --version" } },
    turboTasks: {},
    typescript: { compilerOptions: {}, include: [] },
    declarations,
  });
}

void it("merges shared root scripts and reuses equivalent declarations", () => {
  const result = compose([
    {
      kind: "shared-root-files",
      source: "docs-owner",
      manifest: { scripts: { "docs:check": "node --version" } },
    },
    {
      kind: "shared-root-files",
      source: "check-owner",
      manifest: {
        scripts: {
          "docs:check": "node --version",
          "assets:check": "pnpm --version",
        },
      },
    },
  ]);

  assert.deepEqual(result.manifest.scripts, {
    "base:check": "node --version",
    "docs:check": "node --version",
    "assets:check": "pnpm --version",
  });
});

void it("reports field location and both sources on shared declaration conflicts", () => {
  assert.throws(
    () =>
      compose([
        {
          kind: "shared-root-files",
          source: "docs-owner",
          manifest: { scripts: { "docs:check": "node --version" } },
        },
        {
          kind: "shared-root-files",
          source: "check-owner",
          manifest: { scripts: { "docs:check": "pnpm --version" } },
        },
      ]),
    /package\.json#\/scripts\/docs:check.*docs-owner.*check-owner/u,
  );
});

void it("composes exclusive CI steps and partial job settings", () => {
  const result = compose([
    {
      kind: "shared-root-files",
      source: "docs-owner",
      ciJob: { name: "Check" },
      ciSteps: [{ steps: [{ id: "docs-check", run: "pnpm run docs:check" }] }],
    },
    {
      kind: "shared-root-files",
      source: "check-owner",
      ciJob: { timeoutMinutes: 30 },
      ciSteps: [
        { steps: [{ id: "assets-check", run: "pnpm run assets:check" }] },
      ],
    },
  ]);

  assert.deepEqual(result.ciJob, { name: "Check", timeoutMinutes: 30 });
  assert.deepEqual(
    result.ciSteps.map(({ source, steps }) => ({
      source,
      ids: steps.map((step) => ("id" in step ? step.id : undefined)),
    })),
    [
      { source: "docs-owner", ids: ["docs-check"] },
      { source: "check-owner", ids: ["assets-check"] },
    ],
  );

  const workflow = parseYaml(
    composeCheckWorkflow(
      [
        "name: Check",
        "jobs:",
        "  check:",
        "    steps:",
        "      - id: default-check",
        "        run: pnpm run check",
      ].join("\n"),
      "base-workspace",
      result.ciSteps,
    ),
  ) as {
    readonly jobs: {
      readonly check: {
        readonly steps: readonly { readonly id: string }[];
      };
    };
  };
  assert.deepEqual(
    workflow.jobs.check.steps.map(({ id }) => id),
    ["default-check", "docs-check", "assets-check"],
  );
});

void it("rejects conflicting shared CI step IDs", () => {
  const duplicateStep = compose([
    {
      kind: "shared-root-files",
      source: "docs-owner",
      ciSteps: [{ steps: [{ id: "same-step", run: "node --version" }] }],
    },
    {
      kind: "shared-root-files",
      source: "check-owner",
      ciSteps: [{ steps: [{ id: "same-step", run: "pnpm --version" }] }],
    },
  ]);
  assert.throws(
    () =>
      composeCheckWorkflow(
        "jobs:\n  check:\n    steps: []\n",
        "base-workspace",
        duplicateStep.ciSteps,
      ),
    /same-step.*docs-owner.*check-owner/u,
  );
});
