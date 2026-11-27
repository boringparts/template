import { readFileSync } from "node:fs";

import type {
  CiDiagnosticArtifactDeclaration,
  DependencyMaintenancePolicy,
} from "@boringparts/default-content-authoring/contracts";
import { parseDocument, type YAMLMap, type YAMLSeq } from "yaml";

export type ProjectCheckWorkflowDiagnosticOptions = {
  readonly diagnostics: readonly CiDiagnosticArtifactDeclaration[];
  readonly job?: ProjectCheckWorkflowJobOptions;
};

export type ProjectCheckWorkflowJobOptions = {
  readonly name?: string;
  readonly timeoutMinutes?: number;
};

export type ProjectCheckWorkflowJob = {
  readonly name: string;
  readonly timeoutMinutes: number;
};

export type PreparedProjectGithubTemplates = {
  readonly checkWorkflow: string;
  readonly dependabot: string;
  readonly nextSteps: string;
};

/** Normalizes root check workflow job options with the shared default name and timeout. */
export function normalizeProjectCheckWorkflowJob(
  options?: ProjectCheckWorkflowJobOptions,
): ProjectCheckWorkflowJob {
  return {
    name: options?.name ?? "Root Check",
    timeoutMinutes: options?.timeoutMinutes ?? 30,
  };
}

/** Reads the GitHub workflow, Dependabot, and next-steps templates owned by workspace-root during preparation. */
export function prepareProjectGithubTemplates(): PreparedProjectGithubTemplates {
  const read = (file: string): string => {
    try {
      return readFileSync(
        new URL(`../resources/${file}`, import.meta.url),
        "utf8",
      );
    } catch (cause) {
      throw new Error(
        `Failed to read ${file} while preparing @boringparts/reference-workspace-root#./project-github`,
        { cause },
      );
    }
  };
  return {
    checkWorkflow: read("github/check.yml"),
    dependabot: read("github/dependabot.yml"),
    nextSteps: read("next-steps.md"),
  };
}

/** Projects the check workflow YAML by configuring job settings and keeping diagnostic steps only when declared. */
export function projectCheckWorkflow(
  options: ProjectCheckWorkflowDiagnosticOptions,
  template: string,
): string {
  const diagnostics = options.diagnostics;
  const workflow = parseDocument(template);
  const job = normalizeProjectCheckWorkflowJob(options.job);
  workflow.setIn(["jobs", "check", "name"], job.name);
  workflow.setIn(["jobs", "check", "timeout-minutes"], job.timeoutMinutes);
  const steps = workflow.getIn(["jobs", "check", "steps"]) as YAMLSeq<
    YAMLMap<string>
  >;
  steps.items = steps.items.filter((step) => {
    const identity = step.get("id");
    if (identity === "stage-diagnostics" || identity === "upload-diagnostics")
      return diagnostics.length > 0;
    return true;
  });
  if (options.job === undefined) {
    for (const step of steps.items) {
      if (step.get("id") === "stage-diagnostics")
        step.set("name", "Stage Root Check diagnostics");
      if (step.get("id") === "upload-diagnostics") {
        step.set("name", "Upload Root Check diagnostics");
        step.setIn(["with", "name"], "root-check-diagnostics");
      }
    }
  }
  const staging = steps.items.find(
    (step) => step.get("id") === "stage-diagnostics",
  );
  if (staging !== undefined) {
    const owners = (kind: "playwright" | "vitest-browser"): string =>
      diagnostics
        .filter((declaration) => declaration.kind === kind)
        .map((declaration) => declaration.owner.path)
        .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .join("\n");
    staging.setIn(
      ["env", "PLAYWRIGHT_DIAGNOSTIC_OWNER_PATHS"],
      owners("playwright"),
    );
    staging.setIn(
      ["env", "VITEST_BROWSER_DIAGNOSTIC_OWNER_PATHS"],
      owners("vitest-browser"),
    );
  }
  return workflow.toString({ lineWidth: 0 });
}

type DependabotUpdate = Readonly<Record<string, unknown>> & {
  readonly "package-ecosystem": string;
  readonly directory: `/${string}`;
  readonly schedule: Readonly<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDependabotUpdates(value: unknown): readonly DependabotUpdate[] {
  if (!isRecord(value) || !Array.isArray(value.updates)) {
    throw new Error("Dependabot template must contain an updates array");
  }
  return value.updates.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Dependabot update entry at index ${index} must be an object`);
    }
    const ecosystem = entry["package-ecosystem"];
    if (typeof ecosystem !== "string" || ecosystem.length === 0) {
      throw new Error(
        `Dependabot update entry at index ${index} must declare package-ecosystem`,
      );
    }
    const directory = entry.directory;
    if (typeof directory !== "string" || !directory.startsWith("/")) {
      throw new Error(
        `Dependabot update entry at index ${index} must declare a /-prefixed directory`,
      );
    }
    if (!isRecord(entry.schedule)) {
      throw new Error(
        `Dependabot update entry at index ${index} must declare a schedule object`,
      );
    }
    return {
      ...entry,
      "package-ecosystem": ecosystem,
      directory: `/${directory.slice(1)}`,
      schedule: entry.schedule,
    };
  });
}

/** Projects the Dependabot YAML by selecting declared ecosystems and applying policy directories and schedule interval. */
export function projectDependabotConfig(
  policy: DependencyMaintenancePolicy,
  template: string,
): string {
  const document = parseDocument(template);
  const declarations = parseDependabotUpdates(document.toJS());
  const updates = policy.ecosystems.flatMap((ecosystem) => {
    const candidates = declarations.filter(
      (update) => update["package-ecosystem"] === ecosystem,
    );
    const defaultUpdate = candidates[0];
    if (defaultUpdate === undefined)
      throw new Error(
        `Native Dependabot configuration does not declare ecosystem: ${ecosystem}`,
      );
    return [
      policy.directories?.[ecosystem] ?? defaultUpdate.directory,
      ...(policy.extraDirectories?.[ecosystem] ?? []),
    ].map((directory) => {
      const declaration =
        candidates.find((candidate) => candidate.directory === directory) ??
        candidates.find((candidate) => candidate.directory === "/") ??
        defaultUpdate;
      return {
        ...declaration,
        directory,
        schedule: { ...declaration.schedule, interval: policy.interval },
      };
    });
  });
  document.set("updates", updates);
  return document.toString({ lineWidth: 0 });
}

/** Appends numbered next-step commands to the Markdown introduction template. */
export function projectNextStepsDocument(
  instructions: readonly { readonly display: string }[],
  template: string,
): string {
  const introduction = template.trimEnd();
  const steps = instructions.map(
    (instruction, index) => `${index + 1}. \`${instruction.display}\``,
  );
  return `${introduction}\n\n${steps.join("\n")}\n`;
}
