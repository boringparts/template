import {
  CliWriteError,
  type WriteCliOutput,
  defineCli,
  executeCli,
  helpCapability,
  parseCliInvocation,
  schemaCapability,
  text,
  versionCapability,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import { z } from "zod";

import {
  listPresetCatalog,
  runAddPackage,
  runInit,
  validateBlueprintFile,
  type ApplicationRuntime,
} from "./application.ts";
import {
  initializationInputSchema,
  packageAdditionInputSchema,
} from "./input-schemas.ts";
import { cliPresets } from "./preset-catalog.ts";
import {
  initializationSchema,
  packageAdditionSchema,
  packageConflictSchema,
} from "./result-schemas.ts";

export type CliRuntime = ApplicationRuntime & {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly commandName: string;
  readonly version: string;
};

const validateBlueprintInput = z.object({ path: z.string().min(1) });
const presetsInput = z.object({});

const initInvalidRequestSchema = z.object({
  issues: z.array(
    z.object({
      code: z.enum([
        "PRESET_UNKNOWN",
        "FIXED_TOPOLOGY_OVERRIDE",
        "INVALID_PACKAGE_NAME",
        "INVALID_PACKAGE_PATH",
        "RESERVED_PACKAGE_PATH",
        "INVALID_PACKAGE_SCOPE",
        "INVALID_REPOSITORY_SCOPE",
        "CONFLICTING_PACKAGE_IDENTITY",
      ]),
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

const addInvalidRequestSchema = z.object({
  issues: z.array(
    z.object({
      code: z.enum([
        "PRESET_UNKNOWN",
        "PRESET_NOT_ADDABLE",
        "INVALID_PACKAGE_NAME",
        "INVALID_PACKAGE_PATH",
        "RESERVED_PACKAGE_PATH",
        "INVALID_LINK_FROM",
        "RESERVED_LINK_FROM",
        "UNKNOWN_LINK_FROM",
        "UNSUPPORTED_LINK",
      ]),
    }),
  ),
});

const addOperationFailedSchema = z.object({
  error: z.object({
    message: z.string(),
    suggestion: z.string(),
  }),
});

const validBlueprintSchema = z.object({ path: z.string() });

const blueprintOperationFailedSchema = z.object({
  path: z.string(),
  reason: z.enum([
    "not-found",
    "permission-denied",
    "not-a-file",
    "unreadable",
    "invalid-json",
  ]),
  error: z.object({
    message: z.string(),
    suggestion: z.string(),
  }),
});

const invalidBlueprintSchema = z.object({
  path: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});

const presetsListSchema = z.object({
  presets: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  ),
});

function initializationDetails(
  result: NonNullable<
    (typeof initializationSchema)["~standard"]["types"]
  >["output"],
): string[] {
  return [
    `Preset: ${result.resolved.preset}`,
    `Scope: ${result.resolved.scope}`,
    ...result.resolved.packages.map(
      ({ name, path }) => `Package: ${name} (${path})`,
    ),
    `Toolchain: Node ${result.toolchain.nodeVersion}; ${result.toolchain.packageManagerPin}`,
    `Follow-up document: ${result.followUpDocument.enabled ? result.followUpDocument.path : "disabled"}`,
  ];
}

function formatPackageConflictText(
  conflicts: z.output<typeof packageConflictSchema>["conflicts"],
) {
  const lines = conflicts.flatMap((conflict) => {
    if ("kind" in conflict) {
      return [
        `Package identity conflict: requested ${conflict.requested.name} (${conflict.requested.path}) duplicates existing ${conflict.existing.name} (${conflict.existing.path}).`,
      ];
    }
    return [
      `${conflict.path} (${conflict.driver})`,
      ...(conflict.location === undefined
        ? []
        : [`Location: ${conflict.location || "<document root>"}`]),
      ...(conflict.region === undefined
        ? []
        : [
            `Region: before line ${conflict.region.before.startLine}; current line ${conflict.region.current.startLine}; after line ${conflict.region.after.startLine}`,
          ]),
      ...(conflict.attribute === undefined
        ? []
        : [`Attribute: ${conflict.attribute}`]),
      ...(conflict.sources === undefined
        ? []
        : [
            `Sources: ${conflict.sources.map((source) => source.label).join(", ")}`,
          ]),
      `Reason: ${conflict.reason}`,
      `Before: ${conflict.context.before}`,
      `Current: ${conflict.context.current}`,
      `After: ${conflict.context.after}`,
    ].flatMap((line) => line.replaceAll("\0", "\\0").split(/\r\n|\r|\n/u));
  });
  return text.lines([
    "Package addition has conflicts; no changes were written.",
    ...lines,
  ]);
}

function createCliContract(runtime: CliRuntime) {
  const define = defineCli<ApplicationRuntime>();
  const initInput = initializationInputSchema(runtime.cwd);

  const initSuccess = {
    kind: "data" as const,
    variants: {
      initialized: {
        description: "Repository initialized",
        schema: initializationSchema,
        exitCode: 0,
      },
      planned: {
        description: "Initialization preview",
        schema: initializationSchema,
        exitCode: 0,
      },
    },
  };
  const initFailures = {
    invalidRequest: {
      description:
        "Initial package identity conflicts with the base tooling-config package",
      exitCode: 2,
      schema: initInvalidRequestSchema,
    },
    operationFailed: {
      description: "Initialization operation failed",
      exitCode: 1,
      schema: initOperationFailedSchema,
    },
  };
  async function handleInit<
    Initialized,
    Planned,
    InvalidRequest,
    OperationFailed,
  >({
    input,
    dependencies,
    outcome,
  }: {
    readonly input: z.output<typeof initInput>;
    readonly dependencies: ApplicationRuntime;
    readonly outcome: {
      readonly data: {
        readonly initialized: (
          data: z.input<typeof initializationSchema>,
        ) => Initialized;
        readonly planned: (
          data: z.input<typeof initializationSchema>,
        ) => Planned;
      };
      readonly failure: {
        readonly invalidRequest: (
          data: z.input<typeof initInvalidRequestSchema>,
        ) => InvalidRequest;
        readonly operationFailed: (
          data: z.input<typeof initOperationFailedSchema>,
        ) => OperationFailed;
      };
    };
  }): Promise<Initialized | Planned | InvalidRequest | OperationFailed> {
    const result = await runInit(
      {
        dir: input.dir,
        preset: input.preset,
        dryRun: input.dryRun,
        todo: input.todo,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.scope === undefined ? {} : { scope: input.scope }),
      },
      dependencies,
    );
    if (result.status === "operation-failure") {
      return outcome.failure.operationFailed({
        targetDir: result.targetDir,
        error: result.error,
      });
    }
    if (result.status === "usage-error") {
      return outcome.failure.invalidRequest({
        issues: result.issues.map(({ code }) => ({ code })),
      });
    }
    if (result.status !== "success") {
      throw new Error(
        "Initialization result does not match the command contract",
      );
    }
    const { status: _status, ...data } = result;
    const payload = {
      ...data,
      resolved: {
        ...data.resolved,
        packages: [...data.resolved.packages],
      },
      nextSteps: [...data.nextSteps],
      blueprint: {
        schemaVersion: data.blueprint.schemaVersion,
        packages: [...data.blueprint.packages],
        packageLinkIntents: [...data.blueprint.packageLinkIntents],
      },
      generationRecord: {
        ...data.generationRecord,
        packages: [...data.generationRecord.packages],
        selections: [...data.generationRecord.selections],
      },
    };
    return input.dryRun
      ? outcome.data.planned(payload)
      : outcome.data.initialized(payload);
  }

  const addPackageSuccess = {
    kind: "data" as const,
    variants: {
      planned: {
        description: "Package addition preview",
        schema: packageAdditionSchema,
        exitCode: 0,
      },
      added: {
        description: "Package added",
        schema: packageAdditionSchema,
        exitCode: 0,
      },
      unchanged: {
        description: "Request already satisfied; no changes needed",
        schema: packageAdditionSchema,
        exitCode: 0,
      },
    },
  };
  const addPackageFailures = {
    invalidRequest: {
      description: "Invalid package addition request",
      exitCode: 1,
      schema: addInvalidRequestSchema,
    },
    operationFailed: {
      description: "Package addition operation failed",
      exitCode: 1,
      schema: addOperationFailedSchema,
    },
    conflict: {
      description: "Package addition conflicts; no changes written",
      exitCode: 1,
      schema: packageConflictSchema,
    },
  };
  async function handleAddPackage<
    Planned,
    Added,
    Unchanged,
    InvalidRequest,
    OperationFailed,
    Conflict,
  >({
    input,
    dependencies,
    outcome,
  }: {
    readonly input: z.output<typeof packageAdditionInputSchema>;
    readonly dependencies: ApplicationRuntime;
    readonly outcome: {
      readonly data: {
        readonly planned: (
          data: z.input<typeof packageAdditionSchema>,
        ) => Planned;
        readonly added: (data: z.input<typeof packageAdditionSchema>) => Added;
        readonly unchanged: (
          data: z.input<typeof packageAdditionSchema>,
        ) => Unchanged;
      };
      readonly failure: {
        readonly invalidRequest: (
          data: z.input<typeof addInvalidRequestSchema>,
        ) => InvalidRequest;
        readonly operationFailed: (
          data: z.input<typeof addOperationFailedSchema>,
        ) => OperationFailed;
        readonly conflict: (
          data: z.input<typeof packageConflictSchema>,
        ) => Conflict;
      };
    };
  }): Promise<
    Planned | Added | Unchanged | InvalidRequest | OperationFailed | Conflict
  > {
    const result = await runAddPackage(
      {
        preset: input.preset,
        name: input.name,
        linkFrom: input.linkFrom,
        dryRun: input.dryRun,
        ...(input.path === undefined ? {} : { path: input.path }),
      },
      dependencies,
    );
    if (result.status === "operation-failure")
      return outcome.failure.operationFailed({ error: result.error });
    if (result.status === "conflict") {
      return outcome.failure.conflict({
        dryRun: result.dryRun,
        actions: [],
        conflicts: [...result.conflicts],
      });
    }
    if (result.status === "usage-error") {
      return outcome.failure.invalidRequest({
        issues: result.issues.map(({ code }) => ({ code })),
      });
    }
    const data = { dryRun: result.dryRun, actions: [...result.actions] };
    return result.dryRun
      ? outcome.data.planned(data)
      : result.actions.length === 0
        ? outcome.data.unchanged(data)
        : outcome.data.added(data);
  }

  const blueprintSuccess = {
    kind: "data" as const,
    variants: {
      valid: {
        description: "Blueprint is valid",
        schema: validBlueprintSchema,
        exitCode: 0,
      },
    },
  };
  const blueprintFailures = {
    operationFailed: {
      description: "Failed to read or parse blueprint",
      schema: blueprintOperationFailedSchema,
      exitCode: 1,
    },
    invalid: {
      description: "Blueprint is invalid",
      schema: invalidBlueprintSchema,
      exitCode: 1,
    },
  };
  async function handleValidateBlueprint<Valid, OperationFailed, Invalid>({
    input,
    dependencies,
    outcome,
  }: {
    readonly input: z.output<typeof validateBlueprintInput>;
    readonly dependencies: ApplicationRuntime;
    readonly outcome: {
      readonly data: {
        readonly valid: (data: z.input<typeof validBlueprintSchema>) => Valid;
      };
      readonly failure: {
        readonly operationFailed: (
          data: z.input<typeof blueprintOperationFailedSchema>,
        ) => OperationFailed;
        readonly invalid: (
          data: z.input<typeof invalidBlueprintSchema>,
        ) => Invalid;
      };
    };
  }): Promise<Valid | OperationFailed | Invalid> {
    const result = await validateBlueprintFile(input.path, dependencies);
    if (result.status === "invalid") {
      return outcome.failure.invalid({
        path: result.path,
        issues: [...result.issues],
      });
    }
    if (result.status === "operation-failure") {
      return outcome.failure.operationFailed({
        path: result.path,
        reason: result.reason,
        error: result.error,
      });
    }
    return outcome.data.valid({ path: result.path });
  }

  const presetsSuccess = {
    kind: "data" as const,
    variants: {
      listed: {
        description: "Built-in preset list",
        schema: presetsListSchema,
        exitCode: 0,
      },
    },
  };
  function handlePresets<Result>({
    outcome,
  }: {
    readonly outcome: {
      readonly data: {
        readonly listed: (data: z.input<typeof presetsListSchema>) => Result;
      };
    };
  }): Result {
    return outcome.data.listed({
      presets: [...listPresetCatalog().presets],
    });
  }

  return define({
    root: "template",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "Usage",
        commands: "Commands",
        arguments: "Arguments",
        options: "Options",
        constraints: "Constraints",
        schema: "Contract Discovery",
        examples: "Examples",
      },
      wording: {
        commandPlaceholder: "command",
        choices: "(choices: {choices})",
        default: "(default: {value})",
        whenOnMatch: "When {facts}, {onMatch}",
        forbid: "forbid {fields}",
        equals: "{field} is {value}",
      },
    }),
    version: versionCapability({
      value: text.line(`${runtime.commandName} ${runtime.version}`),
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
        name: runtime.commandName,
        description: "Generate and maintain project repositories.",
      },
      ...define.command("init")({
        kind: "command",
        parent: "template",
        name: "init",
        description: "Initialize a project repository.",
        input: initInput,
        examples: [
          { input: { dir: "my-app", preset: "ts-lib", dryRun: true } },
          {
            input: { dir: "my-app", preset: "ts-lib", dryRun: true },
            outputMode: "text",
          },
        ],
        usageConstraints: cliPresets
          .filter((preset) => Object.keys(preset.definition.nodes).length !== 1)
          .map(
            (definition) =>
              ({
                kind: "when",
                all: [
                  {
                    kind: "equals",
                    field: "preset",
                    value: definition.alias,
                  },
                ],
                onMatch: { forbid: ["name", "path"] },
              }) as const,
          ),
        fields: {
          dir: { kind: "positional", description: "Target directory" },
          preset: {
            kind: "valueOption",
            longOption: "--preset",
            description: "Project preset",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description:
              "Unscoped npm package leaf name; supported only for presets with a configurable primary package",
          },
          path: {
            kind: "valueOption",
            longOption: "--path",
            description:
              "Two safe path segments outside reserved workspace directories; supported only for presets with a configurable primary package",
          },
          scope: {
            kind: "valueOption",
            longOption: "--scope",
            description:
              "Valid npm scope; defaults to the target directory name when omitted",
          },
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "Preview the generation plan without writing files",
          },
          todo: {
            kind: "flag",
            longOption: "--todo",
            negatedLongOption: "--no-todo",
            description: "Generate the follow-up TODO.md document",
          },
        },
        outputs: define.outputModes("init", initInput, (mode) => ({
          default: "structured",
          modes: {
            structured: mode.atomic({
              description: "Machine-readable structured result",
              format: "structured",
              success: initSuccess,
              failures: initFailures,
              handler: handleInit,
            }),
            text: mode.atomic({
              description: "Human-readable English text",
              format: "text",
              success: {
                kind: "data",
                variants: {
                  initialized: {
                    ...initSuccess.variants.initialized,
                    text: (data) =>
                      text.lines([
                        `Initialized project: ${data.targetDir}`,
                        ...initializationDetails(data),
                        "Next steps",
                        ...data.nextSteps.map(({ display }) => display),
                      ]),
                  },
                  planned: {
                    ...initSuccess.variants.planned,
                    text: (data) =>
                      text.lines([
                        `Project generation preview: ${data.targetDir}`,
                        ...initializationDetails(data),
                      ]),
                  },
                },
              },
              failures: {
                invalidRequest: {
                  ...initFailures.invalidRequest,
                  text: ({ issues }) =>
                    text.lines([
                      "Invalid initialization request.",
                      ...issues.map(({ code }) =>
                        code === "CONFLICTING_PACKAGE_IDENTITY"
                          ? "The initial package identity conflicts with the base tooling-config package."
                          : "Check the preset, package name, path, and scope options.",
                      ),
                    ]),
                },
                operationFailed: {
                  ...initFailures.operationFailed,
                  text: ({ targetDir, error }) =>
                    text.lines([
                      error.message,
                      `Directory: ${targetDir}`,
                      `Suggestion: ${error.suggestion}`,
                    ]),
                },
              },
              handler: handleInit,
            }),
          },
        })),
      }),
      add: {
        kind: "commandGroup",
        parent: "template",
        name: "add",
        description: "Extend an existing generated repository.",
      },
      ...define.command("addPackage")({
        kind: "command",
        parent: "add",
        name: "package",
        description: "Non-destructively add a workspace package.",
        input: packageAdditionInputSchema,
        examples: [
          {
            input: {
              preset: "ts-lib",
              name: "shared-utils",
              path: "packages/shared-utils",
              dryRun: true,
            },
          },
          {
            input: {
              preset: "ts-lib",
              name: "shared-utils",
              path: "packages/shared-utils",
              dryRun: true,
            },
            outputMode: "text",
          },
        ],
        fields: {
          preset: {
            kind: "valueOption",
            longOption: "--preset",
            description: "Preset that supports package addition",
          },
          name: {
            kind: "valueOption",
            longOption: "--name",
            description: "Unscoped npm package leaf name",
          },
          path: {
            kind: "valueOption",
            longOption: "--path",
            description:
              "Two safe path segments outside reserved workspace directories",
          },
          linkFrom: {
            kind: "repeatableOption",
            longOption: "--link-from",
            description:
              "Consumer package path (two safe segments outside reserved directories); repeatable",
          },
          dryRun: {
            kind: "flag",
            longOption: "--dry-run",
            description: "Preview planned file changes without writing",
          },
        },
        outputs: define.outputModes(
          "addPackage",
          packageAdditionInputSchema,
          (mode) => ({
            default: "structured",
            modes: {
              structured: mode.atomic({
                description: "Machine-readable structured result",
                format: "structured",
                success: addPackageSuccess,
                failures: addPackageFailures,
                handler: handleAddPackage,
              }),
              text: mode.atomic({
                description: "Human-readable English text",
                format: "text",
                success: {
                  kind: "data",
                  variants: {
                    planned: {
                      ...addPackageSuccess.variants.planned,
                      text: ({ actions }) =>
                        text.lines([
                          "Package addition preview",
                          ...actions.map(
                            ({ path, action }) => `${action}: ${path}`,
                          ),
                        ]),
                    },
                    added: {
                      ...addPackageSuccess.variants.added,
                      text: ({ actions }) =>
                        text.lines([
                          "Package added",
                          ...actions.map(
                            ({ path, action }) => `${action}: ${path}`,
                          ),
                        ]),
                    },
                    unchanged: {
                      ...addPackageSuccess.variants.unchanged,
                      text: () =>
                        text.line(
                          "Request is already satisfied; no changes needed.",
                        ),
                    },
                  },
                },
                failures: {
                  invalidRequest: {
                    ...addPackageFailures.invalidRequest,
                    text: ({ issues }) =>
                      text.lines([
                        "Invalid add-package request.",
                        ...issues.map(({ code }) => {
                          const messages: Record<typeof code, string> = {
                            PRESET_UNKNOWN: "Select a valid preset.",
                            PRESET_NOT_ADDABLE:
                              "This preset does not support package addition.",
                            INVALID_PACKAGE_NAME:
                              "--name combined with the workspace scope is not a valid npm package name.",
                            INVALID_PACKAGE_PATH:
                              "--path must contain exactly two safe path segments.",
                            RESERVED_PACKAGE_PATH:
                              "--path cannot use a reserved workspace directory.",
                            INVALID_LINK_FROM:
                              "--link-from must contain exactly two safe path segments.",
                            RESERVED_LINK_FROM:
                              "--link-from cannot use a reserved workspace directory.",
                            UNKNOWN_LINK_FROM:
                              "The specified consumer package does not exist; check --link-from.",
                            UNSUPPORTED_LINK:
                              "The specified package roles do not support this link; adjust --link-from.",
                          };
                          return messages[code];
                        }),
                      ]),
                  },
                  operationFailed: {
                    ...addPackageFailures.operationFailed,
                    text: ({ error }) =>
                      text.lines([
                        error.message,
                        `Suggestion: ${error.suggestion}`,
                      ]),
                  },
                  conflict: {
                    ...addPackageFailures.conflict,
                    text: ({ conflicts }) =>
                      formatPackageConflictText(conflicts),
                  },
                },
                handler: handleAddPackage,
              }),
            },
          }),
        ),
      }),
      blueprint: {
        kind: "commandGroup",
        parent: "template",
        name: "blueprint",
        description: "Work with project blueprints.",
      },
      ...define.command("validateBlueprint")({
        kind: "command",
        parent: "blueprint",
        name: "validate",
        description: "Validate a project blueprint without modifying files.",
        fields: {
          path: { kind: "positional", description: "Blueprint file path" },
        },
        input: validateBlueprintInput,
        examples: [
          { input: { path: ".template/blueprint.json" } },
          { input: { path: ".template/blueprint.json" }, outputMode: "text" },
        ],
        outputs: define.outputModes(
          "validateBlueprint",
          validateBlueprintInput,
          (mode) => ({
            default: "structured",
            modes: {
              structured: mode.atomic({
                description: "Machine-readable structured result",
                format: "structured",
                success: blueprintSuccess,
                failures: blueprintFailures,
                handler: handleValidateBlueprint,
              }),
              text: mode.atomic({
                description: "Human-readable English text",
                format: "text",
                success: {
                  kind: "data",
                  variants: {
                    valid: {
                      ...blueprintSuccess.variants.valid,
                      text: () => text.line("Blueprint is valid."),
                    },
                  },
                },
                failures: {
                  operationFailed: {
                    ...blueprintFailures.operationFailed,
                    text: ({ path, error }) =>
                      text.lines([
                        error.message,
                        `Path: ${path}`,
                        `Suggestion: ${error.suggestion}`,
                      ]),
                  },
                  invalid: {
                    ...blueprintFailures.invalid,
                    text: ({ path, issues }) =>
                      text.lines([
                        "Blueprint is invalid.",
                        `Path: ${path}`,
                        ...issues.map(
                          (issue) =>
                            `${issue.path}: Blueprint definition at this location is invalid.`,
                        ),
                        "Suggestion: Fix the blueprint and validate again.",
                      ]),
                  },
                },
                handler: handleValidateBlueprint,
              }),
            },
          }),
        ),
      }),
      ...define.command("presets")({
        kind: "command",
        parent: "template",
        name: "presets",
        description: "List built-in presets.",
        fields: {},
        input: presetsInput,
        examples: [{ input: {} }, { input: {}, outputMode: "text" }],
        outputs: define.outputModes("presets", presetsInput, (mode) => ({
          default: "structured",
          modes: {
            structured: mode.atomic({
              description: "Machine-readable structured result",
              format: "structured",
              success: presetsSuccess,
              failures: {},
              handler: handlePresets,
            }),
            text: mode.atomic({
              description: "Human-readable English text",
              format: "text",
              success: {
                kind: "data",
                variants: {
                  listed: {
                    ...presetsSuccess.variants.listed,
                    text: ({ presets }) =>
                      text.lines([
                        "Built-in presets",
                        ...presets.map(
                          (preset) =>
                            `  ${preset.name}: ${preset.title} - ${preset.description}`,
                        ),
                      ]),
                  },
                },
              },
              failures: {},
              handler: handlePresets,
            }),
          },
        })),
      }),
    },
  });
}

/**
 * Parses and executes a `template` CLI invocation and returns the process exit code.
 *
 * Exit codes: `0` on success or stdout `EPIPE`, `1` on declared operational or conflict failure,
 * `2` on usage failure or invalid initialization request, and `70` on unexpected runtime or write failure.
 */
export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime);
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const result =
      invocation.kind === "parsed"
        ? await executeCli(contract, {
            invocation,
            dependencies: runtime,
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
