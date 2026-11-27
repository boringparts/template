import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { cliCommandIdentity } from "../../../src/cli-command-identity.ts";
import type { CliJourney } from "../journey.ts";

const journey: CliJourney = {
  name: "lookup",
  modes: ["source", "packed"],
  async setup() {},
  commands() {
    return [
      { name: "structured lookup", args: ["lookup", "ada"] },
      { name: "text lookup", args: ["lookup", "ada", "--output", "text"] },
      { name: "missing record", args: ["lookup", "missing"] },
      {
        name: "text failure",
        args: ["lookup", "missing", "--output", "text"],
      },
      { name: "invalid input", args: ["lookup", "   ", "--output", "text"] },
      { name: "root schema directory", args: ["--schema"] },
      { name: "lookup schema summary", args: ["lookup", "--schema"] },
      { name: "lookup input schema", args: ["lookup", "--schema=input"] },
      {
        name: "lookup success schema",
        args: ["lookup", "--schema=success:structured"],
      },
      {
        name: "lookup failures schema",
        args: ["lookup", "--schema=failures:structured"],
      },
      {
        name: "lookup wire schema",
        args: ["lookup", "--schema=wire:structured"],
      },
      { name: "help", args: ["--help"] },
      { name: "lookup help", args: ["lookup", "--help"] },
      { name: "version", args: ["--version"] },
      { name: "replay structured example", args: ["lookup", "--", "ada"] },
      {
        name: "replay text example",
        args: ["lookup", "--output=text", "--", "ada"],
      },
    ];
  },
  async assertions({ context, results }) {
    const identity = cliCommandIdentity(
      JSON.parse(
        await readFile(path.join(context.packageRoot, "package.json"), "utf8"),
      ),
    );
    assert.equal(results[0]?.exitCode, 0);
    assert.equal(results[0]?.stderr, "");
    assert.deepEqual(JSON.parse(results[0]?.stdout ?? ""), {
      schemaVersion: "3",
      command: "lookup",
      outputMode: "structured",
      kind: "data",
      variant: "found",
      data: { name: "ada", title: "Ada Lovelace" },
    });

    assert.equal(results[1]?.exitCode, 0);
    assert.equal(results[1]?.stderr, "");
    assert.equal(results[1]?.stdout, "Found record: Ada Lovelace (ada)\n");

    for (const result of results.slice(2, 4)) {
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
    }
    assert.deepEqual(JSON.parse(results[2]?.stderr ?? ""), {
      schemaVersion: "3",
      command: "lookup",
      outputMode: "structured",
      kind: "failure",
      variant: "notFound",
      data: { name: "missing" },
    });
    assert.equal(results[3]?.stderr, "Record not found: missing.\n");

    assert.equal(results[4]?.exitCode, 2);
    assert.equal(results[4]?.stdout, "");
    assert.partialDeepStrictEqual(JSON.parse(results[4]?.stderr ?? ""), {
      schemaVersion: "3",
      kind: "usageFailure",
      helpArgv: [identity.commandName, "lookup", "--help"],
    });

    for (const result of results.slice(5)) {
      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
    }
    assert.partialDeepStrictEqual(JSON.parse(results[5]?.stdout ?? ""), {
      kind: "directory",
      schemaVersion: "6",
      command: "cli",
      name: identity.commandName,
      children: [{ command: "lookup", name: "lookup" }],
    });
    const summary = JSON.parse(results[6]?.stdout ?? "") as {
      readonly kind: string;
      readonly schemaVersion: string;
      readonly command: string;
      readonly examples: readonly { readonly argv: readonly string[] }[];
    };
    assert.partialDeepStrictEqual(summary, {
      kind: "summary",
      schemaVersion: "6",
      command: "lookup",
    });
    assert.deepEqual(
      summary.examples.map((example) => example.argv),
      [
        ["lookup", "--", "ada"],
        ["lookup", "--output=text", "--", "ada"],
      ],
    );
    assert.deepEqual(
      JSON.parse(results[14]?.stdout ?? ""),
      JSON.parse(results[0]?.stdout ?? ""),
    );
    assert.equal(results[15]?.stdout, results[1]?.stdout);
    assert.partialDeepStrictEqual(JSON.parse(results[7]?.stdout ?? ""), {
      kind: "input",
      schemaVersion: "6",
      command: "lookup",
    });
    assert.partialDeepStrictEqual(JSON.parse(results[8]?.stdout ?? ""), {
      kind: "success",
      schemaVersion: "6",
      command: "lookup",
      mode: "structured",
      success: { kind: "data", variants: { found: { exitCode: 0 } } },
    });
    assert.partialDeepStrictEqual(JSON.parse(results[9]?.stdout ?? ""), {
      kind: "failures",
      schemaVersion: "6",
      command: "lookup",
      mode: "structured",
      failures: { notFound: { exitCode: 1 } },
    });
    assert.partialDeepStrictEqual(JSON.parse(results[10]?.stdout ?? ""), {
      kind: "wire",
      schemaVersion: "6",
      command: "lookup",
      mode: "structured",
    });

    assert.match(results[11]?.stdout ?? "", /lookup/u);
    assert.ok(results[11]?.stdout.includes(identity.commandName));
    assert.match(results[12]?.stdout ?? "", /--output <mode>/u);
    assert.match(results[12]?.stdout ?? "", /Examples/u);
    assert.equal(
      results[13]?.stdout,
      `${identity.commandName} ${identity.version}\n`,
    );
  },
};

export default journey;
