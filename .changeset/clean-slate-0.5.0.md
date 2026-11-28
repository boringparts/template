---
"@boringparts/template": minor
---

Converge `@boringparts/template` into a pure-Node (`>=24.0.0`) composable meta-framework library with zero built-in presets, reference packages, or CLI coupling:

- **Explicit source context & template snapshot primitives**: Expose `createWorkspaceSourceContext`, `createPackagedSourceContext`, `writeTemplateSnapshot`, `readPnpmWorkspaceCatalog`, and `validateWorkspacePolicy` with zero `import.meta.url` / `process.cwd()` path guessing or `pnpm` subprocesses.
- **Composable planning, synthesis & materialization primitives**: Expose `definePreset`, `summarizePresets`, `planProject`, `buildProjectProjection`, `writeProjectProjection`, and `bindTemplateCatalog` with explicit `SourceContext`, `WorkspaceRoot`, `SingletonPackage`, `PresetDefinition`, and `WorkspacePolicy` inputs.
- **Minimal runtime footprint**: Compile pure JS and `.d.ts` declarations via `tsc`, keeping only `yaml` as an external runtime dependency.
