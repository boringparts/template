import {
  dependencyCatalogSnapshot,
  namedDependencyCatalogsSnapshot,
  workspaceInstallPolicySnapshot,
} from "./workspace-policy-snapshot.ts";

export type TemplateDependencyCatalog = Record<string, string>;
export type NamedTemplateDependencyCatalogs = Record<
  string,
  TemplateDependencyCatalog
>;

export type GeneratedCatalogReferences = {
  readonly defaultDependencies: readonly string[];
  readonly namedDependencies: Readonly<Record<string, readonly string[]>>;
};

export type GeneratedDependencyCatalogOptions = {
  readonly dependencies: readonly string[];
  readonly packages?: readonly string[];
  readonly allowBuilds?: Record<string, boolean>;
  readonly dependencyLinker?:
    | { readonly kind: "isolated" }
    | { readonly kind: "hoisted"; readonly evidence: string };
  readonly minimumReleaseAgeExclude?: readonly string[];
  readonly overrides?: Readonly<Record<string, string>>;
};

export type GeneratedPackageManifestDependencies = {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
};

const exactNpmPackageIdentityPattern =
  /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function assertMinimumReleaseAgeExclusions(
  exclusions: readonly string[],
): void {
  if (exclusions.some((dependency) => dependency.length === 0)) {
    throw new Error("Dependency maturity exclusions must be non-empty");
  }

  if (new Set(exclusions).size !== exclusions.length) {
    throw new Error("Dependency maturity exclusions must be unique");
  }

  const invalid = exclusions.find(
    (dependency) =>
      dependency.length > 214 ||
      !exactNpmPackageIdentityPattern.test(dependency),
  );
  if (invalid !== undefined) {
    throw new Error(
      `Dependency maturity exclusions must be exact npm package identities: ${JSON.stringify(invalid)}`,
    );
  }
}

function parseMinimumReleaseAgeExclusions(
  exclusions: unknown,
  sourceLabel: string,
): readonly string[] {
  if (
    !Array.isArray(exclusions) ||
    exclusions.some((item) => typeof item !== "string")
  ) {
    throw new Error(
      `${sourceLabel} must be an array of exact npm package identities`,
    );
  }
  assertMinimumReleaseAgeExclusions(exclusions);
  return exclusions;
}

/** Validates and filters release-age exclusions down to exact package names present in the selected catalog. */
export function selectMinimumReleaseAgeExclusions(
  exclusions: unknown,
  selectedPackageNames: ReadonlySet<string>,
): string[] {
  return parseMinimumReleaseAgeExclusions(
    exclusions,
    "Dependency maturity exclusions",
  ).filter((dependency) => selectedPackageNames.has(dependency));
}

/** Returns the validated release-age exclusions configured in the workspace policy snapshot. */
export function loadTemplateMinimumReleaseAgeExclusions(): string[] {
  const configured = (
    workspaceInstallPolicySnapshot as {
      readonly minimumReleaseAgeExclude?: unknown;
    }
  ).minimumReleaseAgeExclude;
  if (configured === undefined) {
    return [];
  }
  return [
    ...parseMinimumReleaseAgeExclusions(
      configured,
      "Workspace install policy minimumReleaseAgeExclude",
    ),
  ];
}

export function loadTemplateDependencyCatalog(): TemplateDependencyCatalog {
  return { ...dependencyCatalogSnapshot };
}

export function loadTemplateNamedDependencyCatalogs(): NamedTemplateDependencyCatalogs {
  return Object.fromEntries(
    Object.entries(namedDependencyCatalogsSnapshot).map(
      ([catalogName, entries]) => [catalogName, { ...entries }],
    ),
  );
}

export function selectTemplateDependencyCatalogEntries(
  dependencies: readonly string[],
  catalog: TemplateDependencyCatalog = loadTemplateDependencyCatalog(),
): TemplateDependencyCatalog {
  const selected: TemplateDependencyCatalog = {};

  for (const dependency of dependencies.toSorted()) {
    const version = catalog[dependency];
    if (version === undefined) {
      throw new Error(
        `Template Dependency Catalog is missing dependency: ${dependency}`,
      );
    }

    selected[dependency] = version;
  }

  return selected;
}

export function selectTemplateNamedDependencyCatalogEntries(
  namedDependencies: Readonly<Record<string, readonly string[]>>,
  namedCatalogs: Readonly<
    Record<string, Readonly<Record<string, string>>>
  > = loadTemplateNamedDependencyCatalogs(),
): NamedTemplateDependencyCatalogs {
  const selected: NamedTemplateDependencyCatalogs = {};

  for (const [catalogName, dependencies] of Object.entries(
    namedDependencies,
  ).toSorted(([left], [right]) => left.localeCompare(right))) {
    if (dependencies.length === 0) {
      continue;
    }

    const catalog = namedCatalogs[catalogName];
    if (catalog === undefined) {
      throw new Error(
        `Template Named Dependency Catalog is missing catalog: ${catalogName}`,
      );
    }

    selected[catalogName] = selectTemplateDependencyCatalogEntries(
      dependencies,
      catalog,
    );
  }

  return selected;
}

export function collectGeneratedManifestCatalogSelections(
  manifests: readonly GeneratedPackageManifestDependencies[],
): GeneratedCatalogReferences {
  const defaultDependencies = new Set<string>();
  const namedDependencies = new Map<string, Set<string>>();

  for (const manifest of manifests) {
    for (const dependencyMap of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [dependency, specifier] of Object.entries(
        dependencyMap ?? {},
      )) {
        if (specifier === "catalog:" || specifier === "catalog:default") {
          defaultDependencies.add(dependency);
          continue;
        }
        if (specifier.startsWith("catalog:")) {
          const catalogName = specifier.slice("catalog:".length);
          if (catalogName.length === 0 || catalogName.trim() !== catalogName) {
            throw new Error(
              `Invalid dependency catalog specifier ${JSON.stringify(specifier)} for ${dependency}`,
            );
          }
          const entries =
            namedDependencies.get(catalogName) ?? new Set<string>();
          entries.add(dependency);
          namedDependencies.set(catalogName, entries);
        }
      }
    }
  }

  return {
    defaultDependencies: [...defaultDependencies].toSorted(),
    namedDependencies: Object.fromEntries(
      [...namedDependencies.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([catalogName, dependencies]) => [
          catalogName,
          [...dependencies].toSorted(),
        ]),
    ),
  };
}

function renderCatalogKey(key: string): string {
  return key.startsWith("@") ? JSON.stringify(key) : key;
}

export function renderGeneratedPnpmWorkspaceYaml(
  options: GeneratedDependencyCatalogOptions,
): string {
  const minimumReleaseAgeExclude = options.minimumReleaseAgeExclude ?? [];
  assertMinimumReleaseAgeExclusions(minimumReleaseAgeExclude);
  if (
    options.dependencyLinker?.kind === "hoisted" &&
    (options.dependencyLinker.evidence.trim().length === 0 ||
      options.dependencyLinker.evidence.includes("\n"))
  ) {
    throw new Error(
      "Hoisted linking requires single-line compatibility evidence",
    );
  }
  const catalog = selectTemplateDependencyCatalogEntries(options.dependencies);
  const packages = options.packages ?? ["."];
  const dependencyLinker = options.dependencyLinker?.kind ?? "isolated";
  const lines = [
    "packages:",
    ...packages.map((workspacePackage) => `  - ${workspacePackage}`),
    "",
    ...(options.dependencyLinker?.kind === "hoisted"
      ? [
          `# Hoisted linker compatibility evidence: ${options.dependencyLinker.evidence}`,
        ]
      : []),
    `nodeLinker: ${dependencyLinker}`,
    "autoInstallPeers: false",
    "resolvePeersFromWorkspaceRoot: false",
    "injectWorkspacePackages: false",
    "dedupeInjectedDeps: false",
    "syncInjectedDepsAfterScripts:",
    "  - build",
    "minimumReleaseAge: 1440",
    "minimumReleaseAgeStrict: true",
    "",
  ];

  if (minimumReleaseAgeExclude.length) {
    lines.push(
      "minimumReleaseAgeExclude:",
      ...minimumReleaseAgeExclude
        .toSorted()
        .map((dependency) => `  - ${JSON.stringify(dependency)}`),
      "",
    );
  }

  if (options.allowBuilds) {
    lines.push(
      "allowBuilds:",
      ...Object.entries(options.allowBuilds)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([dependency, allowed]) => `  ${dependency}: ${allowed}`),
      "",
    );
  }

  const overrides = options.overrides ?? {};
  if (Object.keys(overrides).length > 0) {
    lines.push(
      "overrides:",
      ...Object.entries(overrides)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(
          ([dependency, version]) =>
            `  ${JSON.stringify(dependency)}: ${JSON.stringify(version)}`,
        ),
      "",
    );
  }

  lines.push(
    "catalog:",
    ...Object.entries(catalog).map(
      ([dependency, version]) =>
        `  ${renderCatalogKey(dependency)}: ${version}`,
    ),
    "",
  );

  return lines.join("\n");
}
