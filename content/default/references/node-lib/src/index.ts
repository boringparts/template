import { createHash } from "node:crypto";
import path from "node:path";

import { artifactInputSchema } from "./artifact-schema.ts";
import type { ArtifactInput } from "./artifact-schema.ts";

export type { ArtifactInput } from "./artifact-schema.ts";

export type ArtifactKey = {
  readonly fileName: string;
  readonly digest: string;
};

/** Computes a deterministic file name and SHA-256 digest for a validated artifact input. */
export function createArtifactKey(input: ArtifactInput): ArtifactKey {
  const parsed = artifactInputSchema.parse(input);
  const baseName = path.posix.basename(parsed.baseName);
  const extension = parsed.extension ?? ".json";
  const fileName = `${baseName}${extension}`;
  const digest = createHash("sha256").update(fileName).digest("hex");
  return { fileName, digest };
}
