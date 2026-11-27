import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { templateReferencePackages } from "@boringparts/template-content";
import ts from "typescript";

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  return object.properties.flatMap((member) => {
    if (
      !ts.isPropertyAssignment(member) ||
      !ts.isIdentifier(member.name) ||
      member.name.text !== name
    ) {
      return [];
    }
    return [member.initializer];
  })[0];
}

async function loadMaintainedConfig(
  sourcePath: string,
  sourceText: string,
): Promise<ts.ObjectLiteralExpression> {
  const source = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  let config: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "defineConfig" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      config = node.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (config === undefined)
    throw new Error(`Missing defineConfig in ${sourcePath}`);
  return config;
}

function maintainedPlaywrightConfiguration(name: string) {
  const reference = templateReferencePackages.find(
    (item) => item.identity.packageName === name,
  );
  assert.ok(
    reference,
    `Content collection is missing reference package: ${name}`,
  );
  const prepared = reference.definition.prepare({
    excludedPackagePaths: [],
  });
  const resource = prepared.resources.find(
    ({ path: resourcePath }) => resourcePath === "playwright.config.ts",
  );
  assert.ok(
    resource,
    `${name} prepare did not return the Playwright config resource`,
  );
  return {
    sourcePath: `${name}/playwright.config.ts`,
    sourceText: new TextDecoder("utf-8", { fatal: true }).decode(
      resource.content,
    ),
  };
}

void describe("maintained Playwright diagnostic configuration", () => {
  for (const configuration of [
    maintainedPlaywrightConfiguration("@boringparts/reference-vue-app"),
    maintainedPlaywrightConfiguration("@boringparts/reference-vike-web"),
  ]) {
    void it("uses native failure diagnostics in the prepared resource", async () => {
      const { sourcePath, sourceText } = configuration;
      const config = await loadMaintainedConfig(sourcePath, sourceText);
      const use = property(config, "use");

      assert.strictEqual(
        use !== undefined && ts.isObjectLiteralExpression(use),
        true,
      );
      if (use === undefined || !ts.isObjectLiteralExpression(use)) return;
      const trace = property(use, "trace");
      const reporter = property(config, "reporter");

      assert.strictEqual(
        trace !== undefined && ts.isStringLiteral(trace) && trace.text,
        "retain-on-failure",
      );
      assert.strictEqual(
        reporter !== undefined && ts.isArrayLiteralExpression(reporter),
        true,
      );
      if (reporter === undefined || !ts.isArrayLiteralExpression(reporter))
        return;
      assert.deepStrictEqual(
        reporter.elements.map((entry) =>
          ts.isArrayLiteralExpression(entry) &&
          entry.elements[0] !== undefined &&
          ts.isStringLiteral(entry.elements[0])
            ? entry.elements[0].text
            : undefined,
        ),
        ["list", "html"],
      );
      assert.strictEqual(property(config, "retries"), undefined);
      assert.strictEqual(property(use, "video"), undefined);
    });
  }
});
