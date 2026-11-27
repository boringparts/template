import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PlaywrightTestConfig } from "@playwright/test";

import configuration from "../resources/joint-e2e/playwright.config.ts";

void describe("Vue-Hono joint browser E2E config", () => {
  void it("starts web and API using actual package identities and retains browser failure diagnostics", () => {
    const config: PlaywrightTestConfig = configuration;
    const webServers = config.webServer;
    assert.ok(Array.isArray(webServers));

    assert.deepStrictEqual(
      webServers.map((server: { command: string }) => server.command),
      [
        "pnpm --filter @boringparts/reference-hono-api --fail-if-no-match run start",
        "pnpm --filter @boringparts/reference-vue-hono-web --fail-if-no-match run preview --host 127.0.0.1 --strictPort",
      ],
    );
    assert.strictEqual(config.use?.trace, "retain-on-failure");
    const reporters = config.reporter;
    assert.ok(Array.isArray(reporters));
    assert.deepStrictEqual(
      reporters.map((reporter) =>
        Array.isArray(reporter) ? reporter[0] : reporter,
      ),
      ["list", "html"],
    );
  });
});
