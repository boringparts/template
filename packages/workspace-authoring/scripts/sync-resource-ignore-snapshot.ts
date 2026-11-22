import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function readInput(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  if (input.length === 0)
    throw new Error("Missing root resource ignore rules input.");
  return input;
}

const destination = new URL(
  "../src/resource-ignore-snapshot.ts",
  import.meta.url,
);
const expected = await readInput();
const current = await readFile(destination, "utf8").catch((error: unknown) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return undefined;
  throw error;
});

if (process.argv.includes("--check")) {
  if (current !== expected) {
    throw new Error(
      `${fileURLToPath(destination)} is out of sync with the root declaration; run pnpm run sync.`,
    );
  }
} else if (current !== expected) {
  await writeFile(destination, expected);
}
