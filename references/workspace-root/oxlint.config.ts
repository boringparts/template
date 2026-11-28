import lintConfiguration from "@boringparts/reference-tooling-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [lintConfiguration],
  options: { typeAware: true },
});
