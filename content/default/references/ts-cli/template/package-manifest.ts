function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Projects a reference CLI package manifest to the target command name and tested Node baseline.
 *
 * Does not mutate `options.manifest`; throws if the command name is invalid or the manifest lacks
 * a single string `bin` entry.
 */
export function projectCliPackageManifest(options: {
  readonly manifest: unknown;
  readonly commandName: string;
  readonly nodeDeclaration: string;
}): Readonly<Record<string, unknown>> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(options.commandName)) {
    throw new Error(
      "CLI command name must use lowercase ASCII letters, digits, and single hyphens.",
    );
  }
  if (!isRecord(options.manifest)) {
    throw new Error("CLI package manifest must be an object.");
  }
  const bin = options.manifest.bin;
  if (!isRecord(bin)) {
    throw new Error(
      "CLI package manifest must declare exactly one bin command entry.",
    );
  }
  const entries = Object.entries(bin);
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    typeof entry[1] !== "string"
  ) {
    throw new Error(
      "CLI package manifest must declare exactly one bin command entry.",
    );
  }
  return {
    ...options.manifest,
    bin: { [options.commandName]: entry[1] },
    engines: { node: `^${options.nodeDeclaration}` },
  };
}
