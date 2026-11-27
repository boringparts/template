import lintConfiguration from "@boringparts/tooling-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [lintConfiguration],
  options: { typeAware: true },
});
