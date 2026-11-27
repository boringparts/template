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
import { z } from "zod";

import type { CliCommandIdentity } from "./cli-command-identity.ts";

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
};

const records = [
  { name: "ada", title: "Ada Lovelace" },
  { name: "grace", title: "Grace Hopper" },
];

const lookupInput = z.object({
  name: z
    .string()
    .regex(/^[a-z]+$/, "Name must contain only lowercase ASCII letters."),
});

const foundRecordSchema = z.object({
  name: z.string(),
  title: z.string(),
});

const missingRecordSchema = z.object({
  name: z.string(),
});

function findRecord(name: string) {
  return records.find((candidate) => candidate.name === name);
}

function handleLookup<Found, NotFound>({
  input,
  outcome,
}: {
  readonly input: z.output<typeof lookupInput>;
  readonly outcome: {
    readonly data: {
      readonly found: (data: z.input<typeof foundRecordSchema>) => Found;
    };
    readonly failure: {
      readonly notFound: (
        data: z.input<typeof missingRecordSchema>,
      ) => NotFound;
    };
  };
}): Found | NotFound {
  const record = findRecord(input.name);
  return record === undefined
    ? outcome.failure.notFound({ name: input.name })
    : outcome.data.found(record);
}

function createCliContract(identity: CliCommandIdentity) {
  const define = defineCli();
  const lookupSuccess = {
    kind: "data" as const,
    variants: {
      found: {
        description: "Matching record found",
        exitCode: 0,
        schema: foundRecordSchema,
      },
    },
  };
  const lookupFailures = {
    notFound: {
      description: "Record not found",
      exitCode: 1,
      schema: missingRecordSchema,
    },
  };

  return define({
    root: "cli",
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
      cli: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "Look up built-in example records.",
      },
      ...define.command("lookup")({
        kind: "command",
        parent: "cli",
        name: "lookup",
        description: "Look up an in-memory record by name.",
        fields: {
          name: {
            kind: "positional",
            description: "Lowercase ASCII record name",
          },
        },
        input: lookupInput,
        examples: [
          { input: { name: "ada" } },
          { input: { name: "ada" }, outputMode: "text" },
        ],
        outputs: (mode) => {
          const execution = mode.atomic({
            success: lookupSuccess,
            failures: lookupFailures,
            handler: handleLookup,
          });
          return {
            default: "structured",
            modes: {
              structured: execution.structured({
                description: "Machine-readable structured result",
              }),
              text: execution.text({
                description: "Human-readable English text",
                success: {
                  found: ({ name, title }) =>
                    text.line(`Found record: ${title} (${name})`),
                },
                failures: {
                  notFound: ({ name }) =>
                    text.line(`Record not found: ${name}.`),
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
 * Parses and executes a CLI invocation against the contract and returns the process exit code.
 *
 * Exit codes: `0` on success or stdout `EPIPE`, `1` on declared failure, `2` on usage failure,
 * and `70` on unexpected runtime or write failure.
 */
export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const contract = createCliContract(runtime.identity);
    const invocation = parseCliInvocation(contract, runtime.argv.slice(2));
    const result =
      invocation.kind === "parsed"
        ? await executeCli(contract, {
            invocation,
            dependencies: undefined,
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
