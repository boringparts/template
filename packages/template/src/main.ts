import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  parseCliInvocation,
  schemaCapability,
  text,
  versionCapability,
  type WriteCliOutput,
} from "@boringparts/cli-contract";
import { isNodeBrokenPipe } from "@boringparts/cli-contract/node";
import {
  buildProjectProjection,
  planProject,
  summarizePresets,
  writeProjectProjection,
  type PresetDefinition,
  type WorkspaceTemplateRoots,
} from "@boringparts/template-engine";
import {
  loadBuiltInPresets,
  resolveTemplateWorkspaceRoots,
} from "@boringparts/template-presets";
import { z } from "zod";

import type { CliCommandIdentity } from "./cli-command-identity.ts";

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
  readonly cwd: string;
  readonly presets?: readonly PresetDefinition[];
  readonly workspaceRoots?: WorkspaceTemplateRoots;
};

type ResolvedRuntime = {
  readonly cwd: string;
  readonly presets: readonly PresetDefinition[];
  readonly workspaceRoots: WorkspaceTemplateRoots;
};

const packageRoleSchema = z.enum([
  "cli-tool",
  "runtime-service",
  "browser-app",
  "shared-library",
  "node-library",
  "native-package",
]);

const presetsInputSchema = z.object({});

const presetsListSchema = z.object({
  presets: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
      topology: z.enum(["configurable-primary-package", "fixed"]),
      roles: z.array(packageRoleSchema),
    }),
  ),
});

const initInputSchema = z.object({
  dir: z.string().min(1),
  preset: z.array(z.string().min(1)).min(1),
  link: z.array(z.string().min(1)).default([]),
  scope: z.string().min(1).optional(),
  dryRun: z.boolean().default(false),
});

const initSuccessSchema = z.object({
  dryRun: z.boolean(),
  targetDir: z.string(),
  repositoryName: z.string(),
  scope: z.string(),
  packages: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      role: packageRoleSchema,
      preset: z.string(),
    }),
  ),
  links: z.array(
    z.object({
      consumer: z.string(),
      provider: z.string(),
    }),
  ),
  files: z.array(z.string()),
  toolchain: z.object({
    nodeVersion: z.string(),
    packageManagerPin: z.string(),
  }),
});

const invalidRequestCodeSchema = z.enum([
  "PRESET_UNKNOWN",
  "FIXED_TOPOLOGY_OVERRIDE",
  "INVALID_PRESET_SPEC",
  "INVALID_PACKAGE_NAME",
  "INVALID_PACKAGE_PATH",
  "RESERVED_PACKAGE_PATH",
  "INVALID_PACKAGE_SCOPE",
  "INVALID_REPOSITORY_SCOPE",
  "CONFLICTING_PACKAGE_IDENTITY",
  "INVALID_LINK_SPEC",
  "UNSUPPORTED_LINK",
]);

const initInvalidRequestSchema = z.object({
  issues: z.array(
    z.object({
      code: invalidRequestCodeSchema,
      message: z.string(),
    }),
  ),
});

const initOperationFailedSchema = z.object({
  targetDir: z.string(),
  error: z.object({
    message: z.string(),
    suggestion: z.string(),
  }),
});

function detectBundledTemplatesRoot(): string | undefined {
  const candidate = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "templates",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function resolveRuntimeDependencies(runtime: CliRuntime): ResolvedRuntime {
  const templatesRoot = detectBundledTemplatesRoot();
  return {
    cwd: runtime.cwd,
    presets: runtime.presets ?? loadBuiltInPresets(templatesRoot),
    workspaceRoots:
      runtime.workspaceRoots ?? resolveTemplateWorkspaceRoots(templatesRoot),
  };
}

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli<ResolvedRuntime>();

  const presetsSuccess = {
    kind: "data" as const,
    variants: {
      listed: {
        description: "Available repository presets",
        exitCode: 0,
        schema: presetsListSchema,
      },
    },
  };

  const initSuccess = {
    kind: "data" as const,
    variants: {
      initialized: {
        description: "Repository initialized",
        exitCode: 0,
        schema: initSuccessSchema,
      },
      planned: {
        description: "Initialization preview",
        exitCode: 0,
        schema: initSuccessSchema,
      },
    },
  };

  const initFailures = {
    invalidRequest: {
      description: "Invalid initialization request",
      exitCode: 2,
      schema: initInvalidRequestSchema,
    },
    operationFailed: {
      description: "Initialization operation failed",
      exitCode: 1,
      schema: initOperationFailedSchema,
    },
  };

  return define({
    root: "template",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "Usage",
        commands: "Commands",
        arguments: "Arguments",
        options: "Options",
        schema: "Contract Discovery",
        examples: "Examples",
      },
      wording: {
        commandPlaceholder: "command",
        outputModePlaceholder: "mode",
        choices: "{usage} (choices: {choices})",
        default: "{usage} (default: {value})",
        choicesAndDefault: "{usage} (choices: {choices}, default: {value})",
        list: "{left}, {right}",
      },
    }),
    version: versionCapability({
      value: text.line(`${identity.commandName} ${identity.version}`),
      description: "Print the CLI version.",
      shortAlias: "-V",
    }),
    schema: schemaCapability({
      description: text.line("Inspect command contracts and wire schemas."),
    }),
    usageFailureExitCode: 2,
    commands: {
      template: {
        kind: "rootGroup",
        name: identity.commandName,
        description:
          "Initialize clean pnpm and Turborepo monorepos from reference packages.",
      },
      ...define.command("presets")({
        kind: "command",
        parent: "template",
        name: "presets",
        description: "List built-in repository presets.",
        fields: {},
        input: presetsInputSchema,
        examples: [{ input: {} }, { input: {}, outputMode: "text" }],
        outputs: (mode) => {
          const execution = mode.atomic({
            success: presetsSuccess,
            failures: {},
            handler: ({ dependencies, outcome }) =>
              outcome.data.listed({
                presets: summarizePresets(dependencies.presets).map(
                  (preset) => ({
                    ...preset,
                    roles: [...preset.roles],
                  }),
                ),
              }),
          });
          return {
            default: "structured",
            modes: {
              structured: execution.structured({
                description: "Machine-readable structured preset catalog",
              }),
              text: execution.text({
                description: "Human-readable preset summary",
                success: {
                  listed: ({ presets }) =>
                    text.lines([
                      "Built-in presets",
                      ...presets.map(
                        (preset) =>
                          `  ${preset.name} (${preset.topology}; roles: ${preset.roles.join(", ")}): ${preset.title} - ${preset.description}`,
                      ),
                    ]),
                },
                failures: {},
              }),
            },
          };
        },
      }),
      ...define.command("init")({
        kind: "command",
        parent: "template",
        name: "init",
        description:
          "Initialize a new monorepo from one or more preset specifications.",
        fields: {
          dir: {
            kind: "positional",
            placeholder: "dir",
            description: "Target directory for the new repository",
          },
          preset: {
            kind: "repeatableOption",
            longOption: "--preset",
            placeholder: "preset[:name[:path]]",
            description: "Preset specification to include (repeatable)",
          },
          link: {
            kind: "repeatableOption",
            longOption: "--link",
            placeholder: "consumer:provider",
            description:
              "Explicit workspace dependency link by package path (repeatable)",
          },
          scope: {
            kind: "valueOption",
            longOption: "--scope",
            placeholder: "scope",
            description:
              "Default npm package scope (defaults to target directory name)",
          },
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description:
              "Validate and plan the repository without writing files",
          },
        },
        input: initInputSchema,
        examples: [
          {
            input: {
              dir: "my-workspace",
              preset: ["ts-lib"],
              dryRun: true,
            },
          },
          {
            input: {
              dir: "my-workspace",
              preset: ["ts-lib"],
              dryRun: true,
            },
            outputMode: "text",
          },
        ],
        outputs: (mode) => {
          const execution = mode.atomic({
            success: initSuccess,
            failures: initFailures,
            handler: ({ input, dependencies, outcome }) => {
              const planned = planProject({
                cwd: dependencies.cwd,
                dir: input.dir,
                presetSpecs: input.preset,
                linkSpecs: input.link,
                ...(input.scope === undefined ? {} : { scope: input.scope }),
                presets: dependencies.presets,
              });
              if (!planned.ok) {
                return outcome.failure.invalidRequest({
                  issues: [...planned.issues],
                });
              }

              const projection = buildProjectProjection(
                planned.blueprint,
                dependencies.workspaceRoots,
              );

              if (!input.dryRun) {
                const materialized = writeProjectProjection(projection);
                if (!materialized.ok) {
                  return outcome.failure.operationFailed({
                    targetDir: materialized.targetDir,
                    error: materialized.error,
                  });
                }
              }

              const payload = {
                dryRun: input.dryRun,
                targetDir: projection.blueprint.targetDir,
                repositoryName: projection.blueprint.repositoryName,
                scope: projection.blueprint.scope,
                packages: projection.blueprint.instances.map((instance) => ({
                  name: instance.packageName,
                  path: instance.path,
                  role: instance.reference.role,
                  preset: instance.presetAlias,
                })),
                links: projection.blueprint.links.map((link) => ({
                  consumer: link.consumerPath,
                  provider: link.providerPath,
                })),
                files: projection.entries.map((entry) => entry.path),
                toolchain: projection.toolchain,
              };

              return input.dryRun
                ? outcome.data.planned(payload)
                : outcome.data.initialized(payload);
            },
          });
          return {
            default: "structured",
            modes: {
              structured: execution.structured({
                description: "Machine-readable initialization result",
              }),
              text: execution.text({
                description: "Human-readable initialization summary",
                success: {
                  initialized: (data) =>
                    text.lines([
                      `Initialized ${data.repositoryName} in ${data.targetDir}`,
                      `Scope: @${data.scope}`,
                      ...data.packages.map(
                        (pkg) => `Package: ${pkg.name} (${pkg.path})`,
                      ),
                    ]),
                  planned: (data) =>
                    text.lines([
                      `Planned ${data.repositoryName} in ${data.targetDir} (dry run)`,
                      `Scope: @${data.scope}`,
                      ...data.packages.map(
                        (pkg) => `Package: ${pkg.name} (${pkg.path})`,
                      ),
                    ]),
                },
                failures: {
                  invalidRequest: ({ issues }) =>
                    text.lines([
                      "Invalid initialization request:",
                      ...issues.map(
                        (issue) => `  [${issue.code}] ${issue.message}`,
                      ),
                    ]),
                  operationFailed: ({ targetDir, error }) =>
                    text.lines([
                      error.message,
                      `Target: ${targetDir}`,
                      `Suggestion: ${error.suggestion}`,
                    ]),
                },
              }),
            },
          };
        },
      }),
    },
  });
}

/**
 * Parses and executes a `@boringparts/template` CLI invocation and returns the process exit code.
 *
 * Exit codes: `0` on success or stdout `EPIPE`, `1` on operational failure, `2` on usage or
 * invalid request failure, and `70` on unexpected runtime or write failure.
 */
export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const result =
      invocation.kind === "parsed"
        ? await executeCli(contract, {
            invocation,
            dependencies: resolveRuntimeDependencies(runtime),
            write: runtime.write,
          })
        : await executeCli(contract, {
            invocation,
            write: runtime.write,
          });
    return result.exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    try {
      await runtime.write({
        destination: "stderr",
        chunk:
          "Command execution failed; check your runtime environment or report this issue.\n",
      });
    } catch {
      // Preserve the original failure exit code even when the diagnostic stream cannot be written.
    }
    return 70;
  }
}
