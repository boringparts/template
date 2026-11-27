import databaseManifest from "@boringparts/reference-vike-db/package.json" with { type: "json" };
import telefunc from "telefunc/vite";
import vike from "vike/plugin";
import { defineConfig, type PluginOption } from "vite";

import vueConfig from "./tooling/vite.ts";

// telefunc/vite does not yet export exact types for its Vite plugin factory.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const telefuncPlugin = telefunc() as PluginOption;

export default defineConfig({
  plugins: [vike(), telefuncPlugin, ...(vueConfig.plugins ?? [])],
  resolve: { conditions: ["source"] },
  ssr: { external: [databaseManifest.name] },
});
