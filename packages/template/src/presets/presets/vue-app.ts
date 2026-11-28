import type { PresetDefinition } from "../../core/index.ts";
import { resolveReferencePackageDir } from "../../sources/index.ts";
import {
  browserTestDevcontainerMeta,
  frontendVscodeMeta,
} from "../environment-meta.ts";

/** Builds the `vue-app` preset backed by `@boringparts/reference-vue-app`. */
export function createVueAppPreset(templatesRoot?: string): PresetDefinition {
  const packageDir = resolveReferencePackageDir(
    "@boringparts/reference-vue-app",
    import.meta.url,
    templatesRoot,
  );

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
        defaultPath: "apps/web",
        referencePackage: {
          packageName: "@boringparts/reference-vue-app",
          packageDir,
          role: "browser-app",
          publishable: false,
          environment: {
            ...browserTestDevcontainerMeta(templatesRoot),
            ...frontendVscodeMeta,
          },
        },
      },
    ],
  };
}
