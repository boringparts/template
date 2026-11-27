import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const externalReadinessTimeoutMs = 30_000;
const stateFile = fileURLToPath(
  new URL("./node_modules/.tmp/playwright-port", import.meta.url),
);

function externalBaseUrl(): string | undefined {
  const configured = process.env.PLAYWRIGHT_EXTERNAL_BASE_URL;
  if (configured === undefined || configured.length === 0) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `PLAYWRIGHT_EXTERNAL_BASE_URL must be an http(s) URL, received: ${configured}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `PLAYWRIGHT_EXTERNAL_BASE_URL must use http or https, received: ${configured}`,
    );
  }
  return configured;
}

function availablePort(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address !== "object" || address === null) {
        server.close(() => {
          reject(new Error("Could not allocate a Playwright web port"));
        });
        return;
      }

      const port = String(address.port);
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function awaitExternalService(baseUrl: string): Promise<void> {
  const deadline = Date.now() + externalReadinessTimeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(baseUrl, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The externally managed service may still be starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `External Playwright service at ${baseUrl} was not ready within ${externalReadinessTimeoutMs}ms`,
  );
}

async function sharedPort(envName: string): Promise<string> {
  const envPort = process.env[envName];
  if (envPort !== undefined) {
    return envPort;
  }
  try {
    return await readFile(stateFile, "utf8");
  } catch {
    const port = await availablePort();
    mkdirSync(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, port, "utf8");
    return port;
  }
}

const externalServiceUrl = externalBaseUrl();
const usesExternalService = externalServiceUrl !== undefined;
let previewUrl: string;

if (externalServiceUrl === undefined) {
  const port = await sharedPort("PLAYWRIGHT_WEB_PORT");
  previewUrl = `http://127.0.0.1:${port}`;
  process.env.PORT = port;
} else {
  previewUrl = externalServiceUrl;
  await awaitExternalService(externalServiceUrl);
}

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  outputDir: usesExternalService
    ? "test-results/deployment"
    : "test-results/e2e",
  use: {
    baseURL: previewUrl,
    trace: "retain-on-failure",
  },
  reporter: [
    ["list"],
    [
      "html",
      {
        outputFolder: usesExternalService
          ? "playwright-report/deployment"
          : "playwright-report/e2e",
      },
    ],
  ],
  ...(usesExternalService
    ? {}
    : { globalTeardown: "./test/playwright-teardown.ts" }),
  ...(externalServiceUrl === undefined
    ? {
        webServer: {
          command: "node dist/server/index.mjs",
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          url: previewUrl,
        },
      }
    : {}),
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
