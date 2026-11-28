import path from "node:path";

import type { PresetDefinition } from "../../core/index.ts";
import { resolveReferencePackageDir } from "../../sources/index.ts";
import {
  browserTestDevcontainerMeta,
  frontendVscodeMeta,
} from "../environment-meta.ts";

/** Builds the fixed-topology `vike-app` preset backed by the four Vike reference packages. */
export function createVikeAppPreset(templatesRoot?: string): PresetDefinition {
  const webDir = resolveReferencePackageDir(
    "@boringparts/reference-vike-web",
    import.meta.url,
    templatesRoot,
  );
  const dbDir = resolveReferencePackageDir(
    "@boringparts/reference-vike-db",
    import.meta.url,
    templatesRoot,
  );
  const migrationsDir = resolveReferencePackageDir(
    "@boringparts/reference-vike-migrations",
    import.meta.url,
    templatesRoot,
  );
  const deploymentDir = resolveReferencePackageDir(
    "@boringparts/reference-vike-deployment",
    import.meta.url,
    templatesRoot,
  );
  const workspaceRootRefDir = resolveReferencePackageDir(
    "@boringparts/reference-workspace-root",
    import.meta.url,
    templatesRoot,
  );

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
        defaultPath: "apps/web",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-deployment": "deployment",
        },
        referencePackage: {
          packageName: "@boringparts/reference-vike-web",
          packageDir: webDir,
          role: "runtime-service",
          publishable: false,
          environment: {
            ...browserTestDevcontainerMeta(templatesRoot),
            ...frontendVscodeMeta,
          },
        },
      },
      {
        nodeId: "db",
        defaultName: "db",
        defaultPath: "packages/db",
        dependencyBindings: {
          "@boringparts/reference-vike-deployment": "deployment",
        },
        referencePackage: {
          packageName: "@boringparts/reference-vike-db",
          packageDir: dbDir,
          role: "node-library",
          publishable: false,
          environment: {
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
        defaultPath: "packages/migrations",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
        },
        referencePackage: {
          packageName: "@boringparts/reference-vike-migrations",
          packageDir: migrationsDir,
          role: "node-library",
          publishable: false,
        },
      },
      {
        nodeId: "deployment",
        defaultName: "deployment",
        defaultPath: "packages/deployment",
        dependencyBindings: {
          "@boringparts/reference-vike-db": "db",
          "@boringparts/reference-vike-migrations": "migrations",
          "@boringparts/reference-vike-web": "web",
        },
        referencePackage: {
          packageName: "@boringparts/reference-vike-deployment",
          packageDir: deploymentDir,
          role: "native-package",
          publishable: false,
          environment: {
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
