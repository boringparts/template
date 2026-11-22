import type { ContentIdentity } from "./content-identity.ts";

export type PresetOperation = "init" | "add";

/** Owning native package export that declares a preset's project behavior. */
export type PresetOwnerDeclaration = {
  readonly packageName: string;
  readonly exportPath: string;
};

/** Persisted preset selection represented by its full canonical content identity. */
export type PresetOwnerSelection = ContentIdentity;

/** Derives a preset's owner declaration from an export path published in its package.json manifest. */
export function presetOwnerFromManifest(
  manifest: unknown,
  exportPath: string,
): PresetOwnerDeclaration {
  if (!isRecord(manifest) || typeof manifest.name !== "string") {
    throw new Error("Preset owner package manifest is missing a name");
  }
  requireText(manifest.name, "owner package name");
  if (!isRecord(manifest.exports)) {
    throw new Error("Preset owner package manifest is missing an exports map");
  }
  if (
    (exportPath !== "." && !exportPath.startsWith("./")) ||
    !Object.hasOwn(manifest.exports, exportPath)
  ) {
    throw new Error(
      "Preset owner package manifest does not publish the selected preset entry",
    );
  }
  return { packageName: manifest.name, exportPath };
}

export type PresetReference = {
  readonly alias: string;
  readonly instance: "shared" | "independent";
};

export type PresetNode<
  Reference extends PresetReference,
  Layout = never,
  CreationInput = never,
> = {
  readonly reference: Reference;
  /** Explicitly binds this node's dependency requirement keys to sibling nodes in the same preset selection. */
  readonly dependencyBindings?: Readonly<Record<string, string>>;
  /** Node layout override interpreted by the workspace composition policy. */
  readonly layout?: Layout;
  /** Default creation input per operation, overridable by individual invocations. */
  readonly creationInput?: Partial<Record<PresetOperation, CreationInput>>;
};

type PresetNodeMap = Readonly<
  Record<
    string,
    {
      readonly reference: PresetReference;
      readonly dependencyBindings?: Readonly<Record<string, string>>;
      readonly layout?: unknown;
      readonly creationInput?: Partial<Record<PresetOperation, unknown>>;
    }
  >
>;

type NodeReference<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes]["reference"];

type NodeLayout<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes] extends infer Node
    ? Node extends { readonly layout: infer Layout }
      ? Layout
      : never
    : never;

type NodeCreationInput<Nodes extends PresetNodeMap> =
  Nodes[keyof Nodes] extends infer Node
    ? Node extends { readonly creationInput: infer Inputs }
      ? Inputs extends object
        ? Inputs[keyof Inputs]
        : never
      : never
    : never;

export type PresetDefinition<
  Reference extends PresetReference,
  Layout = never,
  CreationInput = never,
> = {
  readonly kind: "preset";
  readonly metadata: {
    readonly alias: string;
    readonly title: string;
    readonly description: string;
  };
  readonly operations: readonly PresetOperation[];
  readonly nodes: Readonly<
    Record<string, PresetNode<Reference, Layout, CreationInput>>
  >;
  readonly owner?: PresetOwnerDeclaration;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Preset ${label} must not be empty`);
  }
}

type PresetBaseOptions<Nodes extends PresetNodeMap> = {
  readonly metadata: PresetDefinition<NodeReference<Nodes>>["metadata"];
  readonly operations: readonly PresetOperation[];
  readonly nodes: Nodes;
};

/** Validates and freezes a declarative preset definition without reading resources or running planning. */
export function definePreset<const Nodes extends PresetNodeMap>(
  options: PresetBaseOptions<Nodes> & {
    readonly owner?: PresetOwnerDeclaration;
  },
): PresetDefinition<
  NodeReference<Nodes>,
  NodeLayout<Nodes>,
  NodeCreationInput<Nodes>
> & { readonly nodes: Nodes };
export function definePreset<const Nodes extends PresetNodeMap>(
  options: PresetBaseOptions<Nodes> & {
    readonly owner?: PresetOwnerDeclaration;
  },
): unknown {
  requireText(options.metadata.alias, "alias");
  requireText(options.metadata.title, "title");
  requireText(options.metadata.description, "description");
  if (options.owner !== undefined) {
    if (!isRecord(options.owner)) {
      throw new Error("Preset owner declaration is invalid");
    }
    requireText(options.owner.packageName, "owner package name");
    requireText(options.owner.exportPath, "public export path");
    if (
      options.owner.exportPath !== "." &&
      !options.owner.exportPath.startsWith("./")
    ) {
      throw new Error(
        "Preset public export path must be '.' or start with './'",
      );
    }
  }
  if (!Array.isArray(options.operations) || options.operations.length === 0) {
    throw new Error("Preset must allow at least one operation");
  }
  const operations: PresetOperation[] = [];
  for (const operation of options.operations) {
    if (operation !== "init" && operation !== "add") {
      throw new Error(`Invalid preset operation: ${String(operation)}`);
    }
    if (operations.includes(operation)) {
      throw new Error(`Duplicate preset operation: ${operation}`);
    }
    operations.push(operation);
  }
  const nodeEntries = Object.entries(options.nodes);
  if (nodeEntries.length === 0) {
    throw new Error("Preset must declare at least one node");
  }
  const independentReferences = new Set<PresetReference>();
  const nodeIdentities = new Set(nodeEntries.map(([identity]) => identity));
  const nodes: Record<
    string,
    PresetNode<NodeReference<Nodes>, unknown, unknown>
  > = {};
  for (const [identity, value] of nodeEntries) {
    if (!/^[a-z][a-z0-9-]*$/u.test(identity)) {
      throw new Error(`Invalid preset node identity: ${identity}`);
    }
    if (
      !isRecord(value) ||
      !isRecord(value.reference) ||
      typeof value.reference.alias !== "string" ||
      value.reference.alias.trim().length === 0 ||
      !["shared", "independent"].includes(String(value.reference.instance))
    ) {
      throw new Error(`Preset node is missing a valid reference: ${identity}`);
    }
    const reference = value.reference as NodeReference<Nodes>;
    if (reference.instance === "independent") {
      if (independentReferences.has(reference)) {
        throw new Error(
          `Preset selects independent reference more than once: ${reference.alias}`,
        );
      }
      independentReferences.add(reference);
    }
    if (value.creationInput !== undefined) {
      if (!isRecord(value.creationInput)) {
        throw new Error(`Invalid preset node creationInput: ${identity}`);
      }
      for (const operation of Object.keys(value.creationInput)) {
        if (
          (operation !== "init" && operation !== "add") ||
          !options.operations.includes(operation)
        ) {
          throw new Error(
            `Invalid preset node creationInput operation: ${identity}/${operation}`,
          );
        }
        if (!isRecord(value.creationInput[operation])) {
          throw new Error(
            `Preset node creationInput must be an object: ${identity}/${operation}`,
          );
        }
      }
    }
    if (value.dependencyBindings !== undefined) {
      if (!isRecord(value.dependencyBindings)) {
        throw new Error(`Invalid preset node dependencyBindings: ${identity}`);
      }
      for (const [key, target] of Object.entries(value.dependencyBindings)) {
        if (
          key.trim().length === 0 ||
          typeof target !== "string" ||
          target.trim().length === 0
        ) {
          throw new Error(
            `Invalid preset node dependency binding: ${identity}/${key}`,
          );
        }
        if (!nodeIdentities.has(target)) {
          throw new Error(
            `Preset node dependency binding target does not exist: ${identity}/${key}`,
          );
        }
      }
    }
    nodes[identity] = Object.freeze({
      ...value,
      reference,
      ...(value.dependencyBindings === undefined
        ? {}
        : {
            dependencyBindings: Object.freeze({ ...value.dependencyBindings }),
          }),
    });
  }
  return Object.freeze({
    kind: "preset",
    metadata: Object.freeze({ ...options.metadata }),
    operations: Object.freeze(operations),
    nodes: Object.freeze(nodes) as Nodes,
    ...(options.owner === undefined
      ? {}
      : { owner: Object.freeze({ ...options.owner }) }),
  }) as unknown as PresetDefinition<
    NodeReference<Nodes>,
    NodeLayout<Nodes>,
    NodeCreationInput<Nodes>
  > & { readonly nodes: Nodes };
}
