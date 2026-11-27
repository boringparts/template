import { z } from "zod";

export const artifactInputSchema = z.object({
  baseName: z.string().trim().min(1),
  extension: z
    .string()
    .trim()
    .regex(/^\.[a-z0-9]+$/u)
    .optional(),
});

export type ArtifactInput = z.input<typeof artifactInputSchema>;
