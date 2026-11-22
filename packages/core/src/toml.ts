import { parseTOML, type AST } from "toml-eslint-parser";

export type TomlStringProjection = {
  readonly path: readonly (string | number)[];
  readonly value: string;
};

/** Updates existing TOML string values in place while preserving comments and surrounding formatting; throws if a target path is missing or not a string. */
export function projectTomlStringValues(
  source: string,
  projections: readonly TomlStringProjection[],
): string {
  const values = new Map<string, AST.TOMLKeyValue>();
  for (const entry of parseTOML(source, { tomlVersion: "1.0" }).body[0].body) {
    const prefix = entry.type === "TOMLTable" ? entry.resolvedKey : [];
    const properties = entry.type === "TOMLTable" ? entry.body : [entry];
    for (const property of properties) {
      const keys = property.key.keys.map((key) =>
        key.type === "TOMLBare" ? key.name : key.value,
      );
      values.set(JSON.stringify([...prefix, ...keys]), property);
    }
  }
  const replacements = projections.flatMap((projection) => {
    const property = values.get(JSON.stringify(projection.path));
    const node = property?.value;
    if (node?.type !== "TOMLValue" || node.kind !== "string") {
      throw new Error(
        `TOML projection requires an existing string field at ${JSON.stringify(projection.path)}`,
      );
    }
    if (node.value === projection.value) return [];
    return [{ range: node.range, text: JSON.stringify(projection.value) }];
  });
  let result = source;
  for (const replacement of replacements.toSorted(
    (left, right) => right.range[0] - left.range[0],
  )) {
    result =
      result.slice(0, replacement.range[0]) +
      replacement.text +
      result.slice(replacement.range[1]);
  }
  return result;
}
