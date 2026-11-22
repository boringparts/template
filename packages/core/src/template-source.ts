import path from "node:path";

const templateSourceHandleBrand: unique symbol = Symbol("template-source");

/** Opaque handle created by a resource owner to prevent arbitrary string path fabrication. */
export type TemplateSourceHandle = {
  readonly [templateSourceHandleBrand]: true;
};

const templateSourceRoots = new WeakMap<object, string>();

/** Binds a bounded resource root directory to an opaque TemplateSourceHandle. */
export function createTemplateSourceHandle(root: string): TemplateSourceHandle {
  const handle = Object.freeze({
    [templateSourceHandleBrand]: true as const,
  });
  templateSourceRoots.set(handle, path.resolve(root));
  return handle;
}

/** Resolves a relative resource path within the handle's root directory; throws if the path is absolute or escapes the root. */
export function resolveTemplateSource(
  source: TemplateSourceHandle,
  relativePath: string,
): string {
  const root =
    typeof source === "object" && source !== null
      ? templateSourceRoots.get(source)
      : undefined;
  if (root === undefined) {
    throw new Error("Invalid template source handle");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Template resource path must be relative: ${relativePath}`);
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  const insideRoot =
    resolvedPath === resolvedRoot ||
    resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);

  if (!insideRoot) {
    throw new Error(
      `Template resource path escapes its owning root: ${relativePath}`,
    );
  }

  return resolvedPath;
}
