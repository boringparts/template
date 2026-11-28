import type { PresetDefinition } from "../../core/index.ts";
import {
  browserTestDevcontainerMeta,
  frontendVscodeMeta,
  type WorkspaceEnvironmentMeta,
} from "../environment-meta.ts";
import { resolvePackageDir } from "../roots.ts";

/**
 * Builds the fixed-topology `vue-hono-app` preset combining `apps/api`, `apps/web`,
 * and the private joint Playwright verification subpackage `packages/e2e`.
 */
export function createVueHonoAppPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
  const apiDir = resolvePackageDir(
    "@boringparts/reference-hono-api",
    import.meta.url,
    templatesRoot,
  );
  const webDir = resolvePackageDir(
    "@boringparts/reference-vue-hono-web",
    import.meta.url,
    templatesRoot,
  );
  const e2eDir = resolvePackageDir(
    "@boringparts/reference-vue-hono-e2e",
    import.meta.url,
    templatesRoot,
  );

  return {
    alias: "vue-hono-app",
    title: "Vue-Hono Full-Stack App",
    description:
      "Combines a Vue web app, a Hono API, and a joint Playwright verification package.",
    topology: "fixed",
    nodes: [
      {
        nodeId: "api",
        defaultName: "api",
        defaultCollection: "apps",
        defaultPath: "apps/api",
        definition: {
          packageName: "@boringparts/reference-hono-api",
          packageDir: apiDir,
          role: "runtime-service",
          publishable: false,
        },
      },
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        dependencyBindings: {
          "@boringparts/reference-hono-api": "api",
        },
        definition: {
          packageName: "@boringparts/reference-vue-hono-web",
          packageDir: webDir,
          role: "browser-app",
          publishable: false,
          meta: frontendVscodeMeta,
        },
      },
      {
        nodeId: "e2e",
        defaultName: "e2e",
        defaultCollection: "packages",
        defaultPath: "packages/e2e",
        dependencyBindings: {
          "@boringparts/reference-hono-api": "api",
          "@boringparts/reference-vue-hono-web": "web",
        },
        definition: {
          packageName: "@boringparts/reference-vue-hono-e2e",
          packageDir: e2eDir,
          role: "native-package",
          publishable: false,
          meta: browserTestDevcontainerMeta(templatesRoot),
        },
      },
    ],
  };
}
