import path from "node:path";

import { z } from "zod";

import {
  validateInitializationInput,
  validatePackageAdditionInput,
  type InitializationInputIssue,
  type PackageAdditionInputIssue,
} from "./input-validation.ts";
import { cliPresets } from "./preset-catalog.ts";

const initializationPresetChoices = cliPresets
  .filter((preset) => preset.definition.operations.includes("init"))
  .map((preset) => preset.alias);
const additionPresetChoices = cliPresets
  .filter((preset) => preset.definition.operations.includes("add"))
  .map((preset) => preset.alias);

const initializationMessages: Record<InitializationInputIssue["code"], string> =
  {
    PRESET_UNKNOWN: "Select a valid preset.",
    FIXED_TOPOLOGY_OVERRIDE:
      "Fixed-topology presets do not support overriding the initial package name or path.",
    INVALID_PACKAGE_NAME: "--name must be a valid unscoped package leaf name.",
    INVALID_PACKAGE_PATH: "--path must contain exactly two safe path segments.",
    RESERVED_PACKAGE_PATH: "--path cannot use a reserved workspace directory.",
    INVALID_PACKAGE_SCOPE:
      "--scope must be a valid npm scope without whitespace.",
    INVALID_REPOSITORY_SCOPE:
      "The target directory name cannot be used as the default scope; specify --scope.",
    CONFLICTING_PACKAGE_IDENTITY:
      "The initial package identity conflicts with the base tooling-config package.",
  };

/** Builds the Zod input schema for `init`, resolving relative target directories against `cwd`. */
export function initializationInputSchema(cwd: string) {
  return z
    .object({
      dir: z.string().min(1),
      preset: z.enum(initializationPresetChoices),
      name: z
        .string()
        .describe(
          "Unscoped npm package leaf name; allowed only for presets with a configurable primary package.",
        )
        .optional(),
      path: z
        .string()
        .describe(
          "Two safe path segments outside reserved directories; allowed only for presets with a configurable primary package.",
        )
        .optional(),
      scope: z
        .string()
        .describe("Valid npm scope; defaults to the target directory name.")
        .optional(),
      dryRun: z.boolean().default(false),
      todo: z.boolean().default(true),
    })
    .superRefine(({ dir, preset, name, path: packagePath, scope }, ctx) => {
      const result = validateInitializationInput({
        preset,
        targetDir: path.resolve(cwd, dir),
        overrides: {
          ...(name === undefined ? {} : { name }),
          ...(packagePath === undefined ? {} : { path: packagePath }),
          ...(scope === undefined ? {} : { scope }),
        },
      });
      if (result.status === "input-invalid") {
        for (const issue of result.issues)
          ctx.addIssue({
            code: "custom",
            message: initializationMessages[issue.code],
          });
      }
    });
}

const additionMessages: Record<PackageAdditionInputIssue["code"], string> = {
  PRESET_UNKNOWN: "Select a valid preset.",
  PRESET_NOT_ADDABLE: "This preset does not support package addition.",
  INVALID_PACKAGE_NAME: "--name must be a valid unscoped package leaf name.",
  INVALID_PACKAGE_PATH: "--path must contain exactly two safe path segments.",
  RESERVED_PACKAGE_PATH: "--path cannot use a reserved workspace directory.",
  INVALID_LINK_FROM: "--link-from must contain exactly two safe path segments.",
  RESERVED_LINK_FROM: "--link-from cannot use a reserved workspace directory.",
  UNKNOWN_LINK_FROM: "The specified consumer package does not exist.",
  UNSUPPORTED_LINK: "The specified package roles do not support this link.",
};

export const packageAdditionInputSchema = z
  .object({
    preset: z.enum(additionPresetChoices),
    name: z.string().describe("Unscoped npm package leaf name."),
    path: z
      .string()
      .describe("Two safe path segments outside reserved directories.")
      .optional(),
    linkFrom: z
      .array(
        z
          .string()
          .describe(
            "Consumer package path: two safe path segments outside reserved workspace directories.",
          ),
      )
      .default([]),
    dryRun: z.boolean().default(false),
  })
  .superRefine((input, ctx) => {
    const result = validatePackageAdditionInput({
      preset: input.preset,
      packageLeafName: input.name,
      linkFrom: input.linkFrom,
      ...(input.path === undefined ? {} : { packagePath: input.path }),
    });
    if (result.status === "input-invalid") {
      for (const issue of result.issues)
        ctx.addIssue({ code: "custom", message: additionMessages[issue.code] });
    }
  });
