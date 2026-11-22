import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type RepositoryConfigurationTarget = {
  readonly label: string;
  readonly before: string;
  readonly write: (contents: string) => Promise<void>;
};

async function replaceFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.repository-config-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Prepares the public CLI package manifest as a repository configuration sync target. */
export async function prepareRepositoryConfigurationTarget(): Promise<RepositoryConfigurationTarget> {
  const file = fileURLToPath(new URL("../package.json", import.meta.url));
  return {
    label: "public CLI package manifest",
    before: await readFile(file, "utf8"),
    write: (contents) => replaceFile(file, contents),
  };
}
