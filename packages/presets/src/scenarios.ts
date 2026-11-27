export type PresetVerificationScenario = {
  readonly id: string;
  readonly args: readonly string[];
};

/**
 * Standard preset and multi-package verification scenarios shared between
 * distribution dry-run checks and full devcontainer matrix verification.
 */
export const standardPresetVerificationScenarios: readonly PresetVerificationScenario[] =
  [
    { id: "ts-lib", args: ["--preset", "ts-lib"] },
    { id: "node-lib", args: ["--preset", "node-lib"] },
    { id: "ts-cli", args: ["--preset", "ts-cli"] },
    { id: "rust-bin", args: ["--preset", "rust-bin"] },
    { id: "vue-app", args: ["--preset", "vue-app"] },
    { id: "vue-hono-app", args: ["--preset", "vue-hono-app"] },
    { id: "vike-app", args: ["--preset", "vike-app"] },
    {
      id: "vue-hono-fullstack",
      args: [
        "--preset",
        "vue-hono-app",
        "--preset",
        "ts-lib:shared",
        "--preset",
        "node-lib:server-kit",
        "--link",
        "apps/web:packages/shared",
        "--link",
        "apps/api:packages/shared",
        "--link",
        "apps/api:packages/server-kit",
      ],
    },
    {
      id: "polyglot-cli",
      args: [
        "--preset",
        "ts-cli:tool",
        "--preset",
        "ts-lib:core",
        "--preset",
        "rust-bin:worker",
        "--link",
        "packages/tool:packages/core",
      ],
    },
  ];
