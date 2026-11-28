import path from "node:path";

import type { WorkspaceEnvironment } from "../core/index.ts";
import { resolvePackageDir, resolvePlaywrightVersion } from "./roots.ts";

/** Shared devcontainer Playwright browser layer and build argument for browser-tested packages. */
export function browserTestDevcontainerMeta(
  templatesRoot?: string,
): WorkspaceEnvironment {
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  const playwrightVersion = resolvePlaywrightVersion(templatesRoot);

  return {
    devcontainer: {
      layers: [
        {
          id: "browser-test",
          dockerfilePath: path.join(
            workspaceRootRefDir,
            "resources",
            "environment",
            "devcontainer",
            "browser-test.Dockerfile",
          ),
        },
      ],
      buildArgs: {
        PLAYWRIGHT_CLI_PACKAGE: `@playwright/test@${playwrightVersion}`,
      },
    },
  };
}

/** Shared VS Code extension set for Vue + Tailwind + Vitest frontend packages. */
export const frontendVscodeMeta: WorkspaceEnvironment = {
  vscode: {
    extensions: ["Vue.volar", "bradlc.vscode-tailwindcss", "vitest.explorer"],
  },
};
