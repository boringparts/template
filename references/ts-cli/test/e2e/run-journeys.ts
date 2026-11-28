import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type {
  CliJourney,
  CliJourneyCommand,
  CliJourneyMode,
  CliJourneyResult,
} from "./journey.ts";

const e2eRoot = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(e2eRoot, "..", "..");

function assertNever(value: never): never {
  throw new Error(`Unsupported journey mode: ${String(value)}`);
}

async function discoverJourneys(): Promise<readonly CliJourney[]> {
  const journeyRoot = path.join(e2eRoot, "journeys");
  const entries = await readdir(journeyRoot, { withFileTypes: true });
  const journeyFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".journey.ts") ||
          entry.name.endsWith(".journey.js")),
    )
    .map((entry) => entry.name)
    .toSorted();
  return await Promise.all(
    journeyFiles.map(async (fileName) => {
      const loaded = (await import(
        pathToFileURL(path.join(journeyRoot, fileName)).href
      )) as { default: CliJourney };
      return loaded.default;
    }),
  );
}

function invocation(
  mode: CliJourneyMode,
  packedBin: string | undefined,
): { readonly executable: string; readonly prefix: readonly string[] } {
  switch (mode) {
    case "source":
      return {
        executable: process.execPath,
        prefix: [
          "--disable-warning=ExperimentalWarning",
          "--conditions=source",
          path.join(packageRoot, "src", "cli.ts"),
        ],
      };
    case "packed":
      if (packedBin === undefined) {
        throw new Error(
          "packed mode requires the installed executable path from the package manager.",
        );
      }
      return { executable: packedBin, prefix: [] };
    default:
      return assertNever(mode);
  }
}

async function runCommand(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin: string | undefined;
  readonly command: CliJourneyCommand;
  readonly cwd: string;
}): Promise<CliJourneyResult> {
  const target = invocation(options.mode, options.packedBin);
  return await new Promise((resolve, reject) => {
    const child = spawn(
      target.executable,
      [...target.prefix, ...options.command.args],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.command.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        commandName: options.command.name,
        exitCode: exitCode ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

/** Runs all discovered CLI journeys matching `options.mode` in isolated temporary workspaces. */
export async function runJourneys(options: {
  readonly mode: CliJourneyMode;
  readonly packedBin?: string;
}): Promise<readonly string[]> {
  const passed: string[] = [];
  for (const journey of await discoverJourneys()) {
    if (!journey.modes.includes(options.mode)) continue;
    const workDir = await mkdtemp(
      path.join(tmpdir(), `cli-${journey.name}-${options.mode}-`),
    );
    const context = { mode: options.mode, packageRoot, workDir };
    try {
      await journey.setup(context);
      const results: CliJourneyResult[] = [];
      for (const command of journey.commands(context)) {
        results.push(
          await runCommand({
            mode: options.mode,
            packedBin: options.packedBin,
            command,
            cwd: workDir,
          }),
        );
      }
      await journey.assertions({ context, results });
      passed.push(`${options.mode}:${journey.name}:passed`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
  return passed;
}
