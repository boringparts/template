import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { summarizeNativeArtifacts } from "../native-artifact-summary.ts";

const targetRoot = process.argv[2];
const mode = process.argv[3];
const packedBin = process.argv[4];
if (targetRoot === undefined || mode === undefined) {
  throw new Error("Target directory for direct reference project is required");
}

let packedRequire: NodeJS.Require | undefined;
if (mode === "packed") {
  if (packedBin === undefined) {
    throw new Error(
      "Packed direct reference initialization requires the installed CLI entry point",
    );
  }
  packedRequire = createRequire(await realpath(packedBin));
}

async function loadPublicModule(specifier: string): Promise<{
  readonly module: Record<string, unknown>;
  readonly entry: string;
}> {
  if (packedRequire !== undefined) {
    const entry = await realpath(packedRequire.resolve(specifier));
    return {
      module: (await import(pathToFileURL(entry).href)) as Record<
        string,
        unknown
      >,
      entry,
    };
  }
  const resolvedUrl = import.meta.resolve(specifier);
  return {
    module: (await import(resolvedUrl)) as Record<string, unknown>,
    entry: fileURLToPath(resolvedUrl),
  };
}

const contentEntry = await loadPublicModule("@ykdz/template-content");
const contentModule =
  contentEntry.module as typeof import("@ykdz/template-content");
const generationEntry = await loadPublicModule(
  "@ykdz/template-workspace/default-generation",
);
const generationModule =
  generationEntry.module as typeof import("@ykdz/template-workspace/default-generation");
const { templateContent } = contentModule;
const preparedArtifacts = summarizeNativeArtifacts(templateContent);
const library = templateContent.find(
  (member) => member.identity.packageName === "@ykdz/reference-ts-lib",
);
const configuration = templateContent.find(
  (member) => member.identity.packageName === "@ykdz/reference-tooling-config",
);
if (library?.kind !== "reference" || configuration?.kind !== "reference") {
  throw new Error(
    "The content collection is missing required reference packages for direct reference initialization",
  );
}
const generator = generationModule.createDefaultGenerator({
  content: templateContent,
});
const result = await generator.init({
  targetRoot: path.resolve(targetRoot),
  selection: {
    roots: [
      {
        nodeIdentity: "library",
        contentIdentity: library.identity,
      },
      {
        nodeIdentity: "tooling-configuration",
        contentIdentity: configuration.identity,
      },
    ],
  },
  conventions: {
    repositoryName: "direct-references",
    defaultPackageScope: "acme",
    todo: false,
  },
});

if (result.status !== "success") {
  throw new Error(
    `Direct reference initialization failed: ${JSON.stringify(result)}`,
  );
}

const libraryRecord = result.generationRecord.packages.find(
  ({ contentIdentity }) =>
    contentIdentity.packageName === library.identity.packageName &&
    contentIdentity.namespace === library.identity.namespace &&
    contentIdentity.exportPath === library.identity.exportPath,
);
const libraryDefinition = result.blueprint.packages.find(
  ({ packageDefinitionId }) =>
    packageDefinitionId === libraryRecord?.packageDefinitionId,
);
const libraryArtifact = library.definition.prepareArtifact();
for (const { resourcePath, targetPath } of [
  { resourcePath: "resources/gitignore", targetPath: ".gitignore" },
  { resourcePath: "resources/npmignore", targetPath: ".npmignore" },
]) {
  const resource = libraryArtifact.resources.find(
    ({ path: itemPath }) => itemPath === resourcePath,
  );
  const projected = result.projection.entries.find(
    ({ path: itemPath }) =>
      itemPath === `${libraryDefinition?.path}/${targetPath}`,
  );
  if (
    resource === undefined ||
    projected === undefined ||
    !Buffer.from(projected.content).equals(Buffer.from(resource.data))
  ) {
    throw new Error(
      `Reference resource ${resourcePath} did not project to expected target file ${targetPath}`,
    );
  }
}

console.log(
  JSON.stringify({
    mode,
    preparedArtifacts,
    modules: {
      content: contentEntry.entry,
      defaultGeneration: generationEntry.entry,
    },
  }),
);
