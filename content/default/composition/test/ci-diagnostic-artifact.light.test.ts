import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CiDiagnosticArtifactDeclaration } from "@boringparts/default-content-authoring/contracts";
import {
  prepareProjectGithubTemplates,
  projectCheckWorkflow,
} from "@boringparts/reference-workspace-root/project-github";

import { composeCiDiagnosticArtifacts } from "../src/ci-diagnostic-artifact.ts";

const checkWorkflowTemplate = prepareProjectGithubTemplates().checkWorkflow;

const playwright = (path: string): CiDiagnosticArtifactDeclaration => ({
  kind: "playwright",
  owner: { kind: "package-boundary", path },
});

const vitestBrowser = (path: string): CiDiagnosticArtifactDeclaration => ({
  kind: "vitest-browser",
  owner: { kind: "package-boundary", path },
});

function projectWorkflow(options: {
  readonly packagePaths: readonly string[];
  readonly diagnosticArtifacts?: readonly unknown[];
  readonly job?: { readonly name?: string; readonly timeoutMinutes?: number };
}): string {
  const diagnostics = composeCiDiagnosticArtifacts({
    packagePaths: options.packagePaths,
    declarations: options.diagnosticArtifacts ?? [],
  });
  return projectCheckWorkflow(
    {
      diagnostics,
      ...(options.job === undefined ? {} : { job: options.job }),
    },
    checkWorkflowTemplate,
  );
}

void describe("CI diagnostic artifact contract", () => {
  void it("returns only sorted, deduplicated closed declarations", () => {
    assert.deepStrictEqual(
      composeCiDiagnosticArtifacts({
        packagePaths: ["apps/web", "apps/admin"],
        declarations: [
          playwright("apps/web"),
          playwright("apps/admin"),
          playwright("apps/web"),
        ],
      }),
      [
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/admin" },
        },
        {
          kind: "playwright",
          owner: { kind: "package-boundary", path: "apps/web" },
        },
      ],
    );
  });

  void it("rejects unknown kinds, unsafe paths, unknown owners, and extra upload fields", () => {
    const packagePaths = ["apps/web"];
    for (const declaration of [
      {
        kind: "coverage",
        owner: { kind: "package-boundary", path: "apps/web" },
      },
      playwright("../secrets"),
      playwright("apps/admin"),
      {
        ...playwright("apps/web"),
        path: "**/*",
      },
    ]) {
      assert.throws(() =>
        composeCiDiagnosticArtifacts({
          packagePaths,
          declarations: [declaration],
        }),
      );
    }
  });

  void it("projects only diagnostic owners from actual package boundaries into the workflow", () => {
    const packagePaths = ["apps/web"];
    const workflow = projectWorkflow({
      packagePaths,
      diagnosticArtifacts: [playwright("apps/web"), vitestBrowser("apps/web")],
    });
    assert.match(workflow, /PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS/u);
    assert.match(workflow, /VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS/u);
    assert.match(workflow, /apps\/web/u);
  });

  void it("requires declared workflow diagnostic owners to belong to real package boundaries", () => {
    for (const declaration of [
      playwright("apps/admin"),
      playwright("services/private"),
    ]) {
      assert.throws(
        () =>
          projectWorkflow({
            packagePaths: ["apps/web"],
            diagnosticArtifacts: [declaration],
          }),
        (error) =>
          error instanceof Error &&
          error.message.includes(
            "CI diagnostic artifact owner is not a declared package boundary",
          ),
      );
    }
  });

  void it("populates workflow job configuration from shared root declarations", () => {
    const packagePaths = ["apps/web"];
    assert.match(
      projectWorkflow({
        packagePaths,
        job: { name: "Full Check", timeoutMinutes: 45 },
      }),
      /name: Full Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 45/u,
    );
    assert.match(
      projectWorkflow({ packagePaths }),
      /name: Root Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 30/u,
    );
    assert.match(
      projectWorkflow({ packagePaths, job: { name: "Full Check" } }),
      /name: Full Check\n    runs-on: ubuntu-latest\n    timeout-minutes: 30/u,
    );
  });

  void it("rejects unsafe diagnostic owners", () => {
    const declarationWithPath = {
      ...playwright("apps/web"),
      paths: [".env", "**/*"],
    };

    assert.throws(() =>
      projectWorkflow({
        packagePaths: ["apps/web"],
        diagnosticArtifacts: [declarationWithPath],
      }),
    );
    assert.throws(() =>
      projectWorkflow({
        packagePaths: ["node_modules/private"],
        diagnosticArtifacts: [playwright("node_modules/private")],
      }),
    );
  });
});
