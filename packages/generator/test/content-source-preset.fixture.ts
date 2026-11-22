export const preset = {
  kind: "preset" as const,
  metadata: {
    alias: "typed-preset",
    title: "Typed Preset",
    description:
      "Test content for verifying preset definition type preservation.",
  },
  operations: ["init"] as const,
  nodes: {
    library: {
      reference: { alias: "typed-reference", instance: "independent" as const },
      creationInput: { init: { seed: "preset" } },
    },
  },
  externalPresetField: 42 as const,
};
