import path from "node:path";

import type { PresetDefinition } from "@boringparts/template-engine";

import {
  frontendVscodeMeta,
  type WorkspaceEnvironmentMeta,
} from "../environment-meta.ts";
import { resolvePackageDir, resolvePlaywrightVersion } from "../roots.ts";

/** Builds the fixed-topology `vike-app` preset backed by the four Vike reference packages. */
export function createVikeAppPreset(
  templatesRoot?: string,
): PresetDefinition<WorkspaceEnvironmentMeta> {
  const webDir = resolvePackageDir(
    "@boringparts/reference-vike-web",
    import.meta.url,
    templatesRoot,
  );
  const dbDir = resolvePackageDir(
    "@boringparts/reference-vike-db",
    import.meta.url,
    templatesRoot,
  );
  const migrationsDir = resolvePackageDir(
    "@boringparts/reference-vike-migrations",
    import.meta.url,
    templatesRoot,
  );
  const deploymentDir = resolvePackageDir(
    "@boringparts/reference-vike-deployment",
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
    alias: "vike-app",
    title: "Vike App",
    description:
      "Full-stack Vike, Hono, Telefunc, Drizzle SQLite, and dual-target Docker deployment monorepo.",
    topology: "fixed",
    nodes: [
      {
        nodeId: "web",
        defaultName: "web",
        defaultCollection: "apps",
        defaultPath: "apps/web",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-deployment": "deployment",
        },
        definition: {
          packageName: "@boringparts/reference-vike-web",
          packageDir: webDir,
          role: "runtime-service",
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
      {
        nodeId: "db",
        defaultName: "db",
        defaultCollection: "packages",
        defaultPath: "packages/db",
        dependencyBindings: {
          "@boringparts/reference-vike-deployment": "deployment",
        },
        definition: {
          packageName: "@boringparts/reference-vike-db",
          packageDir: dbDir,
          role: "node-library",
          publishable: false,
          meta: {
            dependabot: {
              npmGroups: {
                drizzle: {
                  patterns: ["drizzle-*", "drizzle-orm"],
                },
              },
            },
          },
        },
      },
      {
        nodeId: "migrations",
        defaultName: "migrations",
        defaultCollection: "packages",
        defaultPath: "packages/migrations",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
        },
        definition: {
          packageName: "@boringparts/reference-vike-migrations",
          packageDir: migrationsDir,
          role: "node-library",
          publishable: false,
        },
      },
      {
        nodeId: "deployment",
        defaultName: "deployment",
        defaultCollection: "packages",
        defaultPath: "packages/deployment",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-migrations": "migrations",
          "@boringparts/reference-vike-web": "web",
        },
        definition: {
          packageName: "@boringparts/reference-vike-deployment",
          packageDir: deploymentDir,
          role: "native-package",
          publishable: false,
          meta: {
            devcontainer: {
              layers: [
                {
                  id: "shellcheck",
                  dockerfilePath: path.join(
                    workspaceRootRefDir,
                    "resources",
                    "environment",
                    "devcontainer",
                    "shellcheck.Dockerfile",
                  ),
                },
              ],
            },
            dependabot: {
              updates: [
                {
                  packageEcosystem: "docker",
                  directory: "/packages/deployment",
                  interval: "weekly",
                },
              ],
            },
          },
        },
      },
    ],
  };
}
