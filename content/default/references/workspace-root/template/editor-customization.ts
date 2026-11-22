import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

/** Editor capability identifier declared by the root environment and selected by content owners. */
export type EditorCustomizationCapability = string;

export type EditorCustomization = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

type CapabilityProjection = {
  readonly extensions: readonly string[];
  readonly settings: Record<string, unknown>;
};

export type EditorCustomizationDeclarations = {
  readonly source: string;
  readonly capabilityOrder: readonly EditorCustomizationCapability[];
  readonly capabilities: Readonly<
    Record<EditorCustomizationCapability, CapabilityProjection>
  >;
};

const capabilityProjectionSchema = z.object({
  extensions: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
});
const editorCustomizationDeclarationsSchema = z.object({
  capabilityOrder: z.array(z.string()),
  capabilities: z.record(z.string(), capabilityProjectionSchema),
});

function editorCustomizationDeclarationIssuePath(
  issue: z.core.$ZodIssue,
): string {
  return issue.path.length === 0
    ? "$"
    : `$.${issue.path.map(String).join(".")}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function editorCustomizationSharedResourceLabel(resourcePath: string): string {
  return `editor customization resource ${resourcePath}`;
}

/** Loads and validates editor capability declarations from a JSON resource file. */
export function loadEditorCustomizationDeclarations(
  resourcePath: string,
  sourceLabel: string,
): EditorCustomizationDeclarations {
  const resourceLabel = editorCustomizationSharedResourceLabel(resourcePath);
  let resourceText: string;

  try {
    resourceText = readFileSync(resourcePath, "utf8");
  } catch (error) {
    throw new Error(`Failed to read ${resourceLabel}: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  let parsedSource: unknown;
  try {
    parsedSource = JSON.parse(resourceText) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid ${resourceLabel}: JSON syntax error: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const result = editorCustomizationDeclarationsSchema.safeParse(parsedSource);

  if (!result.success) {
    throw new Error(
      `Invalid ${resourceLabel}: ${result.error.issues
        .map(
          (issue) =>
            `${editorCustomizationDeclarationIssuePath(issue)}: ${issue.message}`,
        )
        .join("; ")}`,
    );
  }

  return { ...result.data, source: sourceLabel };
}

function jsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Composes VS Code extensions and settings for the selected capabilities in declared order.
 *
 * Throws if an enabled capability is missing from `declarations.capabilities` or if two
 * capabilities assign conflicting values to the same setting key.
 */
export function editorCustomizationForCapabilities(
  capabilities: readonly EditorCustomizationCapability[],
  declarations: EditorCustomizationDeclarations,
): EditorCustomization {
  const selected = new Set(capabilities);
  const extensions = new Set<string>();
  const settings: Record<string, unknown> = {};
  const settingSources = new Map<
    string,
    { readonly source: string; readonly value: unknown }
  >();

  for (const capability of declarations.capabilityOrder) {
    if (!selected.has(capability)) {
      continue;
    }

    const projection = declarations.capabilities[capability];
    if (projection === undefined) {
      throw new Error(
        `Editor customization policy references an undeclared capability: ${capability}`,
      );
    }
    for (const extension of projection.extensions) {
      extensions.add(extension);
    }
    for (const [setting, value] of Object.entries(projection.settings)) {
      const source = `${declarations.source}#/capabilities/${jsonPointerToken(capability)}/settings/${jsonPointerToken(setting)}`;
      const previous = settingSources.get(setting);
      if (previous !== undefined && !isDeepStrictEqual(previous.value, value)) {
        throw new Error(
          `Conflicting editor setting /settings/${jsonPointerToken(setting)}: ${previous.source} vs ${source}`,
        );
      }
      settingSources.set(setting, { source, value });
      settings[setting] = value;
    }
  }

  return {
    extensions: [...extensions],
    settings,
  };
}
