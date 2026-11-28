import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normalizeRelativePackagePath } from "../sources/package-files.ts";
import { validateWorkspacePolicy } from "../sources/workspace-policy.ts";
import type { TemplateCatalog } from "./types.ts";

/** Metadata describing a persisted static template snapshot directory. */
export type TemplateSnapshot = {
  readonly targetDir: string;
  readonly sourceDirs: readonly string[];
  readonly workspacePolicyPath: string;
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Exports all template source files referenced by `catalog` (preserving executable bits)
 * together with `workspace-policy.json` into a clean static snapshot directory for
 * offline packaged execution via `createPackagedSourceContext`.
 */
export function writeTemplateSnapshot(
  targetDir: string,
  catalog: TemplateCatalog,
): TemplateSnapshot {
  const rawSourceDirs = [
    catalog.workspaceRoot.sourceDir,
    ...(catalog.singletonPackages ?? []).map(
      (singleton) => singleton.referencePackage.sourceDir,
    ),
    ...catalog.presets.flatMap((preset) =>
      preset.nodes.map((node) => node.referencePackage.sourceDir),
    ),
  ];

  const normalizedDirs = new Set<string>();
  for (const rawDir of rawSourceDirs) {
    const normalized = normalizeRelativePackagePath(rawDir);
    if (normalized === undefined) {
      throw new Error(`Invalid template source directory "${rawDir}".`);
    }
    normalizedDirs.add(normalized);
  }
  const sourceDirs = [...normalizedDirs].toSorted(compareStrings);
  const validatedPolicy = validateWorkspacePolicy(
    catalog.workspacePolicy,
    "TemplateCatalog.workspacePolicy",
  );

  const resolvedTargetDir = path.resolve(targetDir);
  rmSync(resolvedTargetDir, { recursive: true, force: true });
  mkdirSync(resolvedTargetDir, { recursive: true });

  for (const sourceDir of sourceDirs) {
    const files = catalog.source.listPackageFiles(sourceDir, {
      includeResources: true,
    });
    for (const file of files) {
      const outputPath = path.join(
        resolvedTargetDir,
        sourceDir,
        file.relativePath,
      );
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, file.content);
      if (process.platform !== "win32") {
        chmodSync(outputPath, file.mode);
      }
    }
  }

  const workspacePolicyPath = path.join(
    resolvedTargetDir,
    "workspace-policy.json",
  );
  writeFileSync(
    workspacePolicyPath,
    `${JSON.stringify(validatedPolicy, null, 2)}\n`,
  );

  return {
    targetDir: resolvedTargetDir,
    sourceDirs,
    workspacePolicyPath,
  };
}
