#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { projectTomlStringValues } from "@ykdz/template-core/toml";
import ts from "typescript";

import { repositoryDevelopmentEnvironment } from "./repository-environment.ts";
import {
  deriveTemplateToolchain,
  readTemplateToolchainDeclarations,
} from "./template-toolchain-declarations.ts";

type Replacement = {
  readonly start: number;
  readonly end: number;
  readonly value: string;
};
type Target = {
  readonly label: string;
  readonly before: string | undefined;
  readonly after: string;
  readonly write: (contents: string) => Promise<void>;
};
type PreparedOwnerTarget = {
  readonly label: string;
  readonly before: string;
  readonly write: (contents: string) => Promise<void>;
};

function replaceStrings(
  source: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  values: Readonly<Record<string, string>>,
): string {
  const edits: Replacement[] = [];
  for (const [name, value] of Object.entries(values)) {
    const properties = object.properties.filter(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name,
    );
    const property = properties[0];
    if (
      properties.length !== 1 ||
      property === undefined ||
      !ts.isStringLiteral(property.initializer)
    )
      throw new Error(
        `${source.fileName}: could not identify unique string field ${name}`,
      );
    edits.push({
      start: property.initializer.getStart(source),
      end: property.initializer.end,
      value: JSON.stringify(value),
    });
  }
  let contents = source.text;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    contents =
      contents.slice(0, edit.start) + edit.value + contents.slice(edit.end);
  return contents;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPreparedOwnerTarget(value: unknown): value is PreparedOwnerTarget {
  return (
    isRecord(value) &&
    typeof value.label === "string" &&
    typeof value.before === "string" &&
    typeof value.write === "function"
  );
}

async function prepareOwnerTarget(
  resolve: ReturnType<typeof createRequire>,
  specifier: string,
): Promise<PreparedOwnerTarget> {
  const entry = resolve.resolve(specifier);
  const ownerModule: unknown = await import(pathToFileURL(entry).href);
  if (!isRecord(ownerModule))
    throw new Error(`${specifier}: could not read public configuration entry`);
  const prepare: unknown = Reflect.get(
    ownerModule,
    "prepareRepositoryConfigurationTarget",
  );
  if (typeof prepare !== "function")
    throw new Error(
      `${specifier}: missing prepareRepositoryConfigurationTarget export`,
    );
  const target: unknown = await Reflect.apply(prepare, undefined, []);
  if (!isPreparedOwnerTarget(target))
    throw new Error(
      `${specifier}: prepared configuration target violates host contract`,
    );
  return target;
}

function projectCli(file: string, contents: string, value: string): string {
  const source = ts.parseJsonText(file, contents);
  JSON.parse(contents);
  const statement = source.statements[0];
  const object =
    statement !== undefined &&
    ts.isExpressionStatement(statement) &&
    ts.isObjectLiteralExpression(statement.expression)
      ? statement.expression
      : undefined;
  const engines = object?.properties.filter(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      ts.isStringLiteral(property.name) &&
      property.name.text === "engines",
  );
  const initializer = engines?.[0]?.initializer;
  if (
    engines?.length !== 1 ||
    initializer === undefined ||
    !ts.isObjectLiteralExpression(initializer)
  )
    throw new Error(`${file}: could not identify engines object`);
  return replaceStrings(source, initializer, { node: value });
}

async function replaceFile(file: string, contents: string): Promise<void> {
  const temporary = `${file}.repository-config-${process.pid}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Computes the full repository configuration projection without modifying any
 * targets; shared by sync and read-only check.
 */
export async function planRepositoryConfiguration(
  repositoryRoot: string,
): Promise<readonly Target[]> {
  const declarations = await readTemplateToolchainDeclarations(repositoryRoot);
  const derived = deriveTemplateToolchain(declarations);
  if (derived.diagnostics.length > 0)
    throw new Error(derived.diagnostics.join("\n"));
  const resolve = createRequire(path.join(repositoryRoot, "package.json"));
  const ownerTargets = await Promise.all([
    prepareOwnerTarget(resolve, "@ykdz/template/repository-configuration"),
    prepareOwnerTarget(
      resolve,
      "@ykdz/reference-ts-cli/repository-configuration",
    ),
    prepareOwnerTarget(
      resolve,
      "@ykdz/reference-rust-bin/repository-configuration",
    ),
  ]);
  const partialOutputs = [
    ...ownerTargets
      .slice(0, 2)
      .map((target) =>
        projectCli(target.label, target.before, derived.cliNodeEngine),
      ),
    projectTomlStringValues(ownerTargets[2]!.before, [
      {
        path: ["toolchain", "channel"],
        value: declarations.rustToolchainChannel.trim(),
      },
    ]),
  ];
  const environment = await repositoryDevelopmentEnvironment(declarations);
  const targets: Target[] = ownerTargets.map((target, index) => ({
    label: target.label,
    before: target.before,
    after: partialOutputs[index]!,
    write: target.write,
  }));
  for (const [file, after] of Object.entries(environment.files)) {
    const before = await readFile(
      path.join(repositoryRoot, file),
      "utf8",
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw error;
    });
    targets.push({
      label: file,
      before,
      after,
      write: async (contents) => {
        const destination = path.join(repositoryRoot, file);
        await mkdir(path.dirname(destination), { recursive: true });
        await replaceFile(destination, contents);
      },
    });
  }
  return targets;
}

/** Returns drift diagnostics for managed repository configuration targets without modifying files. */
export async function checkRepositoryConfiguration(
  repositoryRoot: string,
): Promise<readonly string[]> {
  return (await planRepositoryConfiguration(repositoryRoot))
    .filter(({ before, after }) => before !== after)
    .map(
      ({ label, before }) =>
        `${label}: ${before === undefined ? "missing managed projection" : "configuration projection drifted"}; run pnpm run sync`,
    );
}

/**
 * Applies drifted repository configuration targets and returns updated labels.
 * The optional `replace` hook exists only for fault-injection tests at the write boundary.
 */
export async function syncRepositoryConfiguration(
  repositoryRoot: string,
  replace: (label: string, write: () => Promise<void>) => Promise<void> = (
    _label,
    write,
  ) => write(),
): Promise<string[]> {
  const targets = await planRepositoryConfiguration(repositoryRoot);
  const updated: string[] = [];
  try {
    for (const target of targets) {
      if (target.before === target.after) continue;
      await replace(target.label, () => target.write(target.after));
      updated.push(target.label);
    }
  } catch (error) {
    throw new Error(
      `Repository configuration sync failed while writing; updated files: ${updated.length === 0 ? "none" : updated.join(", ")}; fix the environment and re-run sync:repository`,
      { cause: error },
    );
  }
  return updated;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const index = process.argv.indexOf("--repository-root");
    const root =
      index === -1
        ? path.resolve(import.meta.dirname, "..")
        : process.argv[index + 1];
    if (root === undefined)
      throw new Error("--repository-root requires a path");
    if (process.argv.includes("--check")) {
      const diagnostics = await checkRepositoryConfiguration(
        path.resolve(root),
      );
      if (diagnostics.length > 0) {
        console.error(diagnostics.join("\n"));
        process.exitCode = 1;
      } else console.log("Repository configuration projections are up to date");
    } else {
      const updated = await syncRepositoryConfiguration(path.resolve(root));
      console.log(
        updated.length === 0
          ? "Repository configuration projections are up to date; no changes needed"
          : `Synchronized repository configuration: ${updated.join(", ")}`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
