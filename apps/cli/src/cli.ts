#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import type { CliRuntime } from "#main";

const require = createRequire(import.meta.url);
const runtime: CliRuntime = {
  argv: process.argv,
  // Keep process metadata access inside runCli's unexpected-failure boundary.
  get commandName() {
    const manifest = require("../package.json") as {
      bin: Record<string, string>;
    };
    const names = Object.keys(manifest.bin);
    if (names.length !== 1) {
      throw new Error("CLI package must declare exactly one command in bin.");
    }
    return names[0]!;
  },
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  get cwd() {
    return process.cwd();
  },
  env: process.env,
  get version() {
    return (require("../package.json") as { version: string }).version;
  },
};

const { runCli } = await import("#main");
process.exitCode = await runCli(runtime);
