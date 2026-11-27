import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./tooling/vite.ts";

export default defineConfig(({ command }) =>
  mergeConfig(viteConfig, {
    ...(command === "serve" ? { resolve: { conditions: ["source"] } } : {}),
    test: {
      attachmentsDir: ".vitest/attachments",
      exclude: ["test/e2e/**", "node_modules/**", "dist/**"],
      projects: [
        {
          extends: true,
          test: {
            name: "node",
            include: ["test/**/*.node.test.ts"],
            environment: "node",
          },
        },
        {
          extends: true,
          test: {
            name: "browser",
            include: ["test/**/*.browser.test.ts"],
            browser: {
              enabled: true,
              provider: playwright(),
              headless: true,
              screenshotFailures: true,
              instances: [{ browser: "chromium" }],
            },
          },
        },
      ],
    },
  }),
);
