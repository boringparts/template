import { isDeepStrictEqual } from "node:util";

import type { SharedRootContribution } from "@ykdz/default-content-authoring/contracts";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

function isYamlMapStep(value: unknown): value is YAMLMap {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    readonly items?: unknown;
    readonly get?: unknown;
    readonly clone?: unknown;
  };
  return (
    Array.isArray(candidate.items) &&
    typeof candidate.get === "function" &&
    typeof candidate.clone === "function"
  );
}

function pointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function conflict(location: string, left: string, right: string): never {
  throw new Error(
    `Conflicting shared root file declaration at ${location} between ${left} and ${right}`,
  );
}

/** Each dictionary uses deep structural equality on complete entries without override precedence. */
function composeEntries<T>(
  location: string,
  declarations: readonly {
    readonly source: string;
    readonly values: Readonly<Record<string, T>>;
  }[],
): Record<string, T> {
  const values: Record<string, T> = {};
  const owners = new Map<string, string>();
  for (const declaration of declarations) {
    for (const [key, value] of Object.entries(declaration.values)) {
      const owner = owners.get(key);
      if (owner !== undefined && !isDeepStrictEqual(values[key], value)) {
        conflict(`${location}/${pointer(key)}`, owner, declaration.source);
      }
      if (owner === undefined) {
        owners.set(key, declaration.source);
        values[key] = value;
      }
    }
  }
  return values;
}

export function composeSharedRootFiles(options: {
  readonly source: string;
  readonly manifest: Readonly<Record<string, unknown>>;
  readonly turboTasks: Readonly<Record<string, unknown>>;
  readonly typescript: {
    readonly compilerOptions: Readonly<Record<string, unknown>>;
    readonly include: readonly string[];
  };
  readonly declarations: readonly SharedRootContribution[];
}) {
  const declarations = options.declarations;
  const manifest = { ...options.manifest };
  for (const field of ["scripts", "imports", "devDependencies"] as const) {
    const values = composeEntries(`package.json#/${field}`, [
      {
        source: options.source,
        values: (manifest[field] ?? {}) as Readonly<Record<string, string>>,
      },
      ...declarations.map((declaration) => ({
        source: declaration.source,
        values: declaration.manifest?.[field] ?? {},
      })),
    ]);
    if (Object.keys(values).length > 0) manifest[field] = values;
  }
  const turboTasks = composeEntries("turbo.json#/tasks", [
    { source: options.source, values: options.turboTasks },
    ...declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.turboTasks ?? {},
    })),
  ]);
  const compilerOptions = composeEntries("tsconfig.json#/compilerOptions", [
    { source: options.source, values: options.typescript.compilerOptions },
    ...declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.typescript?.compilerOptions ?? {},
    })),
  ]);
  const include = [
    ...new Set([
      ...options.typescript.include,
      ...declarations.flatMap(
        (declaration) => declaration.typescript?.include ?? [],
      ),
    ]),
  ];
  const ciJob = composeEntries(
    ".github/workflows/check.yml#/jobs/check",
    declarations.map((declaration) => ({
      source: declaration.source,
      values: declaration.ciJob ?? {},
    })),
  ) as NonNullable<SharedRootContribution["ciJob"]>;
  return {
    manifest,
    turboTasks,
    typescript: { compilerOptions, include },
    ciSteps: declarations.flatMap((declaration) =>
      (declaration.ciSteps ?? []).map((insertion) => ({
        ...insertion,
        source: declaration.source,
      })),
    ),
    ciJob,
    environmentNeeds: {
      check: declarations.flatMap(
        (declaration) => declaration.environmentNeeds?.check ?? [],
      ),
      deployment: declarations.flatMap(
        (declaration) => declaration.environmentNeeds?.deployment ?? [],
      ),
    },
    dependencyMaintenance: declarations.flatMap((declaration) =>
      declaration.dependencyMaintenance === undefined
        ? []
        : [declaration.dependencyMaintenance],
    ),
  };
}

/** Inserts CI steps by anchor and declaration order; step IDs are exclusive and are neither deduplicated nor reordered. */
export function composeCheckWorkflow(
  template: string,
  source: string,
  insertions: ReturnType<typeof composeSharedRootFiles>["ciSteps"],
): string {
  if (insertions.length === 0) return template;
  const workflow = parseDocument(template);
  const steps = workflow.getIn(["jobs", "check", "steps"]) as YAMLSeq<YAMLMap>;
  const owners = new Map<string, string>();
  for (const step of steps.items) {
    const id = step.get("id");
    if (typeof id === "string") owners.set(id, source);
  }
  for (const insertion of insertions) {
    const index =
      insertion.before === undefined
        ? steps.items.length
        : steps.items.findIndex((step) => step.get("id") === insertion.before);
    if (index === -1)
      throw new Error(
        `CI step anchor not found for ${insertion.source}: ${insertion.before}`,
      );
    for (const step of insertion.steps) {
      const id = isYamlMapStep(step) ? step.get("id") : step.id;
      if (typeof id !== "string") {
        throw new Error(
          `CI step from ${insertion.source} must declare a string id`,
        );
      }
      const owner = owners.get(id);
      if (owner !== undefined)
        conflict(
          `.github/workflows/check.yml#/jobs/check/steps/${pointer(id)}`,
          owner,
          insertion.source,
        );
      owners.set(id, insertion.source);
    }
    steps.items.splice(
      index,
      0,
      ...insertion.steps.map((step) =>
        isYamlMapStep(step)
          ? (step.clone() as YAMLMap)
          : (workflow.createNode(step) as unknown as YAMLMap),
      ),
    );
  }
  return workflow.toString();
}
