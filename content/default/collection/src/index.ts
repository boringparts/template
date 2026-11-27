import { loadContentSource } from "@boringparts/template-generator/content-source";
export { deriveContentMembers as deriveTemplateMembers } from "@boringparts/template-core/content-identity";

/** Registers all selectable content once and loads each member from its native public entry point. */
export const templateContent = await loadContentSource({
  namespace: "boringparts",
  resolve: (specifier) => import.meta.resolve(specifier),
  members: [
    {
      specifier: "@boringparts/reference-workspace-root/template",
      load: () => import("@boringparts/reference-workspace-root/template"),
    },
    {
      specifier: "@boringparts/reference-ts-lib/template",
      load: () => import("@boringparts/reference-ts-lib/template"),
    },
    {
      specifier: "@boringparts/reference-npm-publication/template",
      load: () => import("@boringparts/reference-npm-publication/template"),
    },
    {
      specifier: "@boringparts/reference-tooling-config/template",
      load: () => import("@boringparts/reference-tooling-config/template"),
    },
    {
      specifier: "@boringparts/preset-ts-lib/template",
      load: () => import("@boringparts/preset-ts-lib/template"),
    },
    {
      specifier: "@boringparts/reference-node-lib/template",
      load: () => import("@boringparts/reference-node-lib/template"),
    },
    {
      specifier: "@boringparts/preset-node-lib/template",
      load: () => import("@boringparts/preset-node-lib/template"),
    },
    {
      specifier: "@boringparts/reference-ts-cli/template",
      load: () => import("@boringparts/reference-ts-cli/template"),
    },
    {
      specifier: "@boringparts/preset-ts-cli/template",
      load: () => import("@boringparts/preset-ts-cli/template"),
    },
    {
      specifier: "@boringparts/reference-rust-bin/template",
      load: () => import("@boringparts/reference-rust-bin/template"),
    },
    {
      specifier: "@boringparts/preset-rust-bin/template",
      load: () => import("@boringparts/preset-rust-bin/template"),
    },
    {
      specifier: "@boringparts/reference-vue-app/template",
      load: () => import("@boringparts/reference-vue-app/template"),
    },
    {
      specifier: "@boringparts/preset-vue-app/template",
      load: () => import("@boringparts/preset-vue-app/template"),
    },
    {
      specifier: "@boringparts/reference-hono-api/template",
      load: () => import("@boringparts/reference-hono-api/template"),
    },
    {
      specifier: "@boringparts/reference-vue-hono-web/template",
      load: () => import("@boringparts/reference-vue-hono-web/template"),
    },
    {
      specifier: "@boringparts/preset-vue-hono-app/template",
      load: () => import("@boringparts/preset-vue-hono-app/template"),
    },
    {
      specifier: "@boringparts/reference-vike-web/template",
      load: () => import("@boringparts/reference-vike-web/template"),
    },
    {
      specifier: "@boringparts/reference-vike-db/template",
      load: () => import("@boringparts/reference-vike-db/template"),
    },
    {
      specifier: "@boringparts/reference-vike-migrations/template",
      load: () => import("@boringparts/reference-vike-migrations/template"),
    },
    {
      specifier: "@boringparts/preset-vike-app/template",
      load: () => import("@boringparts/preset-vike-app/template"),
    },
  ],
});

export type { ContentKind } from "@boringparts/template-core/content-identity";
export type TemplateContentMember = (typeof templateContent)[number];
export type TemplatePreset = Extract<
  TemplateContentMember,
  { readonly kind: "preset" }
>;
export type TemplateReferencePackage = Extract<
  TemplateContentMember,
  { readonly kind: "reference" }
>;

export const templatePresets: readonly TemplatePreset[] =
  templateContent.filter(
    (member): member is TemplatePreset => member.kind === "preset",
  );
export const templateReferencePackages: readonly TemplateReferencePackage[] =
  templateContent.filter(
    (member): member is TemplateReferencePackage => member.kind === "reference",
  );
