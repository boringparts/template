import type { WriteCliOutput } from "@boringparts/cli-contract";

import type { CliCommandIdentity } from "./cli-command-identity.ts";
import { executeCliRuntime } from "./cli-runner.ts";

export type { CliCommandIdentity } from "./cli-command-identity.ts";

export type CliRuntime = {
  readonly argv: readonly string[];
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
  readonly cwd: string;
};

/**
 * Parses and executes a `@boringparts/template` CLI invocation and returns the process exit code.
 *
 * Exit codes: `0` on success or stdout `EPIPE`, `1` on operational failure, `2` on usage or
 * invalid request failure, and `70` on unexpected runtime or write failure.
 */
export function runCli(runtime: CliRuntime): Promise<number> {
  return executeCliRuntime(runtime);
}
