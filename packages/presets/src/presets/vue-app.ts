import path from "node:path";

import type { PresetDefinition } from "@boringparts/template-engine";

import {
  frontendVscodeMeta,
  type WorkspaceEnvironmentMeta,
} from "../environment-meta.ts";
import { resolvePackageDir, resolvePlaywrightVersion } from "../roots.ts";

/** Builds the `vue-app` preset backed by `@boringparts/reference-vue-app`. */
export function createVueAppPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
  const packageDir = resolvePackageDir(
    "@boringparts/reference-vue-app",
    import.meta.url,
    templatesRoot,
  );
  const workspaceRootRefDir = resolvePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );
  const playwrightVersion = resolvePlaywrightVersion(templatesRoot);

  return {
    alias: "vue-app",
    title: "Vue App",
    description:
      "Vue application workspace with Vite, Tailwind CSS, Pinia, and testing tools.",
    topology: "configurable-primary-package",
    nodes: [
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        definition: {
          packageName: "@boringparts/reference-vue-app",
          packageDir,
          role: "browser-app",
          publishable: false,
          meta: {
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
            ...frontendVscodeMeta,
          },
        },
      },
    ],
  };
}
