import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";
import { runCli, type CliRuntime } from "../../src/main.ts";

const identity = cliCommandIdentity(
  createRequire(import.meta.url)("../../package.json"),
);

function testRuntime(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const runtime: CliRuntime = {
    argv: ["node", identity.commandName, ...args],
    identity,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  };
  return { runtime, stdout: () => stdout, stderr: () => stderr };
}

void describe("CLI contract", () => {
  void it("returns v3 structured data by default and English text with --output text", async () => {
    const output = testRuntime(["lookup", "ada"]);
    assert.equal(await runCli(output.runtime), 0);
    assert.deepStrictEqual(JSON.parse(output.stdout()), {
      schemaVersion: "3",
      command: "lookup",
      outputMode: "structured",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });
    assert.equal(output.stderr(), "");

    const human = testRuntime(["lookup", "ada", "--output", "text"]);
    assert.equal(await runCli(human.runtime), 0);
    assert.equal(human.stderr(), "");
    assert.equal(human.stdout(), "Found record: Ada Lovelace (ada)\n");
  });

  void it("returns declared failure for missing records and v3 usageFailure for invalid input", async () => {
    const missing = testRuntime(["lookup", "missing"]);
    assert.equal(await runCli(missing.runtime), 1);
    assert.equal(missing.stdout(), "");
    assert.deepStrictEqual(JSON.parse(missing.stderr()), {
      schemaVersion: "3",
      command: "lookup",
      outputMode: "structured",
      kind: "failure",
      variant: "notFound",
      data: { name: "missing" },
    });

    const missingText = testRuntime(["lookup", "missing", "--output", "text"]);
    assert.equal(await runCli(missingText.runtime), 1);
    assert.equal(missingText.stdout(), "");
    assert.equal(missingText.stderr(), "Record not found: missing.\n");

    for (const args of [["lookup"], ["lookup", "   "], ["unknown"]]) {
      const invalid = testRuntime([...args, "--output", "text"]);
      assert.equal(await runCli(invalid.runtime), 2);
      assert.equal(invalid.stdout(), "");
      assert.partialDeepStrictEqual(JSON.parse(invalid.stderr()), {
        schemaVersion: "3",
        kind: "usageFailure",
      });
    }
  });

  void it("exposes help, version, and native v5 contract discovery with replayable examples", async () => {
    const version = testRuntime(["--version"]);
    assert.equal(await runCli(version.runtime), 0);
    assert.equal(
      version.stdout(),
      `${identity.commandName} ${identity.version}\n`,
    );

    const help = testRuntime(["--help"]);
    assert.equal(await runCli(help.runtime), 0);
    assert.ok(help.stdout().includes(identity.commandName));
    assert.ok(help.stdout().includes("lookup"));
    assert.ok(help.stdout().includes("--schema"));

    const directory = testRuntime(["--schema"]);
    assert.equal(await runCli(directory.runtime), 0);
    assert.equal(directory.stderr(), "");
    const directoryDocument = JSON.parse(directory.stdout());
    assert.partialDeepStrictEqual(directoryDocument, {
      kind: "directory",
      schemaVersion: "5",
      command: "cli",
      name: identity.commandName,
      children: [
        {
          command: "lookup",
          kind: "command",
          name: "lookup",
          path: ["lookup"],
          nextArgv: ["lookup", "--schema"],
        },
      ],
    });

    const summary = testRuntime(["lookup", "--schema"]);
    assert.equal(await runCli(summary.runtime), 0);
    assert.equal(summary.stderr(), "");
    const summaryDocument = JSON.parse(summary.stdout()) as {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly command: string;
      readonly outputs: {
        readonly default: string;
        readonly modes: Readonly<
          Record<string, { readonly delivery: string; readonly format: string }>
        >;
      };
      readonly examples: readonly {
        readonly argv: readonly string[];
        readonly shell: string;
        readonly outputMode?: string;
      }[];
      readonly next: readonly {
        readonly target: string;
        readonly argv: readonly string[];
      }[];
    };
    assert.partialDeepStrictEqual(summaryDocument, {
      kind: "summary",
      schemaVersion: "5",
      command: "lookup",
      outputs: {
        default: "structured",
        modes: {
          structured: { delivery: "atomic", format: "structured" },
          text: { delivery: "atomic", format: "text" },
        },
      },
    });
    assert.ok(summaryDocument.examples.length >= 2);
    for (const example of summaryDocument.examples) {
      const replay = testRuntime(example.argv);
      assert.equal(await runCli(replay.runtime), 0, example.shell);
      assert.equal(replay.stderr(), "");
    }

    const inputQuery = testRuntime(["lookup", "--schema=input"]);
    assert.equal(await runCli(inputQuery.runtime), 0);
    assert.partialDeepStrictEqual(JSON.parse(inputQuery.stdout()), {
      kind: "input",
      schemaVersion: "5",
      command: "lookup",
      input: {
        inputSchema: {
          properties: { name: { pattern: "^[a-z]+$" } },
          required: ["name"],
        },
      },
    });

    const successQuery = testRuntime(["lookup", "--schema=success:structured"]);
    assert.equal(await runCli(successQuery.runtime), 0);
    assert.partialDeepStrictEqual(JSON.parse(successQuery.stdout()), {
      kind: "success",
      schemaVersion: "5",
      command: "lookup",
      mode: "structured",
      success: {
        kind: "data",
        variants: { found: { exitCode: 0 } },
      },
    });

    const failuresQuery = testRuntime([
      "lookup",
      "--schema=failures:structured",
    ]);
    assert.equal(await runCli(failuresQuery.runtime), 0);
    assert.partialDeepStrictEqual(JSON.parse(failuresQuery.stdout()), {
      kind: "failures",
      schemaVersion: "5",
      command: "lookup",
      mode: "structured",
      failures: { notFound: { exitCode: 1 } },
    });

    const wireQuery = testRuntime(["lookup", "--schema=wire:structured"]);
    assert.equal(await runCli(wireQuery.runtime), 0);
    assert.partialDeepStrictEqual(JSON.parse(wireQuery.stdout()), {
      kind: "wire",
      schemaVersion: "5",
      command: "lookup",
      mode: "structured",
    });
  });

  void it("awaits output completion and exits 0 only on stdout EPIPE", async () => {
    const output = testRuntime(["lookup", "ada"]);
    assert.equal(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      0,
    );
    assert.equal(
      await runCli({
        ...output.runtime,
        write: async () => {
          throw new Error("disk");
        },
      }),
      70,
    );
    const failure = testRuntime(["lookup", "missing"]);
    assert.equal(
      await runCli({
        ...failure.runtime,
        write: async () => {
          throw Object.assign(new Error("pipe"), { code: "EPIPE" });
        },
      }),
      70,
    );
    const argv = ["node", identity.commandName];
    Object.defineProperty(argv, "slice", {
      value() {
        throw new Error("internal detail");
      },
    });
    assert.equal(await runCli({ ...output.runtime, argv }), 70);
    assert.ok(output.stderr().includes("Command execution failed"));
    assert.ok(!output.stderr().includes("internal detail"));
  });
});
