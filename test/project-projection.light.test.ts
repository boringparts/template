import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  commitProjectProjectionPlan,
  planProjectProjections,
  readProjectProjectionCurrent,
  reconcileProjectProjections,
  type ProjectProjection,
  type ProjectProjectionEntry,
  type ProjectProjectionMirrorSlot,
  type ProjectProjectionPathPrecondition,
  type ProjectProjectionSource,
  type StructuredIdentitySetPolicy,
} from "@ykdz/template-core/project-projection";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fileEntry(
  filePath: string,
  content: string | Uint8Array,
  mode = 0,
  sources?: readonly ProjectProjectionSource[],
): ProjectProjectionEntry {
  return {
    path: filePath,
    kind: "file",
    content:
      typeof content === "string" ? encoder.encode(content) : content.slice(),
    mode,
    ...(sources === undefined ? {} : { sources }),
  };
}

function projection(
  entries: readonly ProjectProjectionEntry[],
  reconciliation: ProjectProjection["reconciliation"],
): ProjectProjection {
  return { entries, reconciliation };
}

function textProjection(
  filePath: string,
  content: string,
  options: {
    readonly mode?: number;
    readonly sources?: readonly ProjectProjectionSource[];
    readonly mirrorSlots?: readonly ProjectProjectionMirrorSlot[];
  } = {},
): ProjectProjection {
  const { mode = 0, sources, mirrorSlots } = options;
  return projection(
    [fileEntry(filePath, content, mode, sources)],
    [
      {
        path: filePath,
        driver: "text",
        ...(sources === undefined ? {} : { sources }),
        ...(mirrorSlots === undefined ? {} : { mirrorSlots }),
      },
    ],
  );
}

function structuredProjection(
  filePath: string,
  value: unknown,
  options: {
    readonly identitySets?: readonly StructuredIdentitySetPolicy[];
    readonly mirrorSlots?: readonly ProjectProjectionMirrorSlot[];
    readonly sources?: readonly ProjectProjectionSource[];
  } = {},
): ProjectProjection {
  const { identitySets, mirrorSlots, sources } = options;
  return projection(
    [fileEntry(filePath, `${JSON.stringify(value, null, 2)}\n`, 0, sources)],
    [
      {
        path: filePath,
        driver: "structured",
        ...(identitySets === undefined ? {} : { identitySets }),
        ...(mirrorSlots === undefined ? {} : { mirrorSlots }),
        ...(sources === undefined ? {} : { sources }),
      },
    ],
  );
}

async function planAtTarget(options: {
  readonly targetRoot: string;
  readonly before: ProjectProjection;
  readonly after: ProjectProjection;
  readonly preconditions?: readonly ProjectProjectionPathPrecondition[];
  readonly additionalPaths?: readonly string[];
}): Promise<ReturnType<typeof planProjectProjections>> {
  const { targetRoot, before, after, preconditions, additionalPaths } = options;
  const current = await readProjectProjectionCurrent({
    targetRoot,
    before,
    after,
    ...(preconditions === undefined ? {} : { preconditions }),
    ...(additionalPaths === undefined ? {} : { additionalPaths }),
  });
  return planProjectProjections({
    before,
    current,
    after,
    ...(preconditions === undefined ? {} : { preconditions }),
  });
}

void describe("desired project projection reconciliation", () => {
  void it("merges non-overlapping generated text changes while preserving user insertions", () => {
    const before = textProjection("README.md", "first\ncommon\nlast\n");
    const after = textProjection(
      "README.md",
      "first\ncommon\ngenerated\nlast\n",
    );
    const result = reconcileProjectProjections({
      before,
      current: [fileEntry("README.md", "first\nprivate\ncommon\nlast\n")],
      after,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mutations.length, 1);
    assert.equal(
      decoder.decode(result.mutations[0]!.content),
      "first\nprivate\ncommon\ngenerated\nlast\n",
    );
  });

  void it("returns location and contributing sources for overlapping text conflicts without partial mutations", () => {
    const beforeSource = { identity: "content:before", label: "Base content" };
    const currentSource = {
      identity: "workspace:current",
      label: "User file",
    };
    const afterSource = { identity: "content:after", label: "Added content" };
    const before = textProjection("README.md", "first\nbase\n", {
      sources: [beforeSource],
    });
    const after = textProjection("README.md", "first\ngenerated\n", {
      sources: [afterSource],
    });
    const result = reconcileProjectProjections({
      before,
      current: [
        fileEntry("README.md", "first\nuser edit\n", 0, [currentSource]),
      ],
      after,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(Object.hasOwn(result, "mutations"), false);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.path, "README.md");
    assert.ok(result.conflicts[0]?.region);
    assert.deepEqual(
      result.conflicts[0]?.sources?.map(({ label }) => label),
      ["Base content", "User file", "Added content"],
    );
  });

  void it("recursively merges structured objects and explicit identity-set arrays while preserving Current members", () => {
    const identitySets = [
      {
        location: "/members",
        identity: { kind: "fields" as const, fields: ["id"] },
      },
    ];
    const before = structuredProjection(
      "workspace.json",
      {
        members: [{ id: "shared", settings: { timeout: 10 } }],
        enabled: false,
      },
      { identitySets },
    );
    const after = structuredProjection(
      "workspace.json",
      {
        members: [
          { id: "shared", settings: { required: true, timeout: 10 } },
          { id: "generated", settings: {} },
        ],
        enabled: true,
        added: { source: "package-addition" },
      },
      { identitySets },
    );
    const result = reconcileProjectProjections({
      before,
      current: [
        fileEntry(
          "workspace.json",
          `${JSON.stringify(
            {
              members: [
                { id: "user", settings: { retained: true } },
                { id: "shared", settings: { timeout: 20 } },
              ],
              enabled: false,
              userOnly: true,
            },
            null,
            2,
          )}\n`,
        ),
      ],
      after,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)) as unknown,
      {
        members: [
          { id: "user", settings: { retained: true } },
          { id: "shared", settings: { timeout: 20, required: true } },
          { id: "generated", settings: {} },
        ],
        enabled: true,
        added: { source: "package-addition" },
        userOnly: true,
      },
    );
  });

  void it("rejects Current array members with duplicate identities", () => {
    const identitySets = [
      {
        location: "/members",
        identity: { kind: "fields" as const, fields: ["id"] },
      },
    ];
    const result = reconcileProjectProjections({
      before: structuredProjection(
        "workspace.json",
        { members: [{ id: "base" }] },
        { identitySets },
      ),
      current: [
        fileEntry(
          "workspace.json",
          '{"members":[{"id":"base"},{"id":"base"}]}\n',
        ),
      ],
      after: structuredProjection(
        "workspace.json",
        { members: [{ id: "base" }, { id: "generated" }] },
        { identitySets },
      ),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.conflicts[0]?.location, "/members");
    assert.match(
      result.conflicts[0]?.reason ?? "",
      /identities must be unique/u,
    );
    assert.equal(Object.hasOwn(result, "mutations"), false);
  });

  void it("attaches location details to structured field, binary, and executable mode conflicts", () => {
    const structured = reconcileProjectProjections({
      before: structuredProjection("settings.json", {
        settings: { timeout: 10 },
      }),
      current: [fileEntry("settings.json", '{"settings":{"timeout":20}}\n')],
      after: structuredProjection("settings.json", {
        settings: { timeout: 30 },
      }),
    });

    assert.equal(structured.ok, false);
    if (structured.ok) return;
    assert.deepEqual(
      {
        path: structured.conflicts[0]?.path,
        driver: structured.conflicts[0]?.driver,
        location: structured.conflicts[0]?.location,
        reason: structured.conflicts[0]?.reason,
      },
      {
        path: "settings.json",
        driver: "structured",
        location: "/settings/timeout",
        reason: "Current and After contain incompatible scalar changes",
      },
    );
    assert.equal(Object.hasOwn(structured, "mutations"), false);

    const binary = reconcileProjectProjections({
      before: projection(
        [fileEntry("assets/icon.bin", new Uint8Array([0xff, 0, 1]))],
        [{ path: "assets/icon.bin", driver: "text" }],
      ),
      current: [fileEntry("assets/icon.bin", new Uint8Array([0xfd, 0, 1]))],
      after: projection(
        [fileEntry("assets/icon.bin", new Uint8Array([0xfe, 0, 1]))],
        [{ path: "assets/icon.bin", driver: "text" }],
      ),
    });

    assert.equal(binary.ok, false);
    if (binary.ok) return;
    assert.equal(binary.conflicts[0]?.attribute, "binary-content");
    assert.equal(binary.conflicts[0]?.path, "assets/icon.bin");
    assert.equal(Object.hasOwn(binary, "mutations"), false);

    const mode = reconcileProjectProjections({
      before: textProjection("scripts/run.sh", "echo ready\n"),
      current: [fileEntry("scripts/run.sh", "echo ready\n", 0o100)],
      after: textProjection("scripts/run.sh", "echo ready\n", { mode: 0o111 }),
    });

    assert.equal(mode.ok, false);
    if (mode.ok) return;
    assert.equal(mode.conflicts[0]?.attribute, "executable-mode");
    assert.equal(mode.conflicts[0]?.path, "scripts/run.sh");
    assert.equal(Object.hasOwn(mode, "mutations"), false);
  });

  void it("rejects deleting an existing generated path by omitting it from the After projection", () => {
    assert.throws(
      () =>
        reconcileProjectProjections({
          before: textProjection("docs/existing/README.md", "existing\n"),
          current: [fileEntry("docs/existing/README.md", "existing\n")],
          after: { entries: [], reconciliation: [] },
        }),
      /Package Addition projection may not delete path: docs\/existing\/README.md/u,
    );
  });
});

void describe("declared mirror slots", () => {
  const toolVersion = "24.16.0";
  const driftedVersion = "999";
  const configPath = "container/config.json";
  const mirrorSlots = [
    {
      id: "tool-version",
      location: { kind: "json-pointer" as const, pointer: "/env/TOOL_VERSION" },
    },
  ];

  void it("reads only declared JSON mirror paths and restores root values while preserving user fields", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-json-mirror-"),
    );
    const beforeConfig = structuredProjection(
      configPath,
      { env: { TOOL_VERSION: toolVersion }, name: "demo" },
      { mirrorSlots },
    );
    const beforePlain = textProjection("workspace/plain.txt", "generated\n");
    const before = projection(
      [...beforeConfig.entries, ...beforePlain.entries],
      [...beforeConfig.reconciliation, ...beforePlain.reconciliation],
    );
    const after = before;
    const currentConfigPath = path.join(targetRoot, configPath);
    const currentPlainPath = path.join(targetRoot, "workspace/plain.txt");

    try {
      await mkdir(path.dirname(currentConfigPath), { recursive: true });
      await mkdir(path.dirname(currentPlainPath), { recursive: true });
      await writeFile(
        currentConfigPath,
        `${JSON.stringify(
          {
            env: { TOOL_VERSION: driftedVersion },
            name: "demo",
            userOnly: { retained: true },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(currentPlainPath, "user config\n");

      const current = await readProjectProjectionCurrent({
        targetRoot,
        before,
        after,
      });
      assert.ok(current.facts.some((fact) => fact.path === configPath));
      assert.equal(
        current.facts.some((fact) => fact.path === "workspace/plain.txt"),
        false,
      );

      const planning = planProjectProjections({ before, current, after });
      assert.equal(planning.ok, true);
      if (!planning.ok) return;
      assert.deepEqual(
        planning.plan.actions.map(({ path: actionPath }) => actionPath),
        [configPath],
      );
      const committed = await commitProjectProjectionPlan({
        targetRoot,
        plan: planning.plan,
      });
      assert.equal(committed.ok, true);
      assert.deepEqual(
        JSON.parse(await readFile(currentConfigPath, "utf8")) as unknown,
        {
          env: { TOOL_VERSION: toolVersion },
          name: "demo",
          userOnly: { retained: true },
        },
      );
      assert.equal(await readFile(currentPlainPath, "utf8"), "user config\n");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("reconciles ordinary changes and mirror values in the same structured file", () => {
    const reconciliation = { mirrorSlots };
    const before = structuredProjection(
      configPath,
      {
        env: { TOOL_VERSION: toolVersion },
        features: { beta: false },
      },
      reconciliation,
    );
    const after = structuredProjection(
      configPath,
      {
        env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: toolVersion },
        features: { beta: true },
      },
      reconciliation,
    );
    const result = reconcileProjectProjections({
      before,
      current: [
        fileEntry(
          configPath,
          `${JSON.stringify(
            {
              env: { TOOL_VERSION: driftedVersion },
              features: { beta: false },
              userOnly: { retained: true },
            },
            null,
            2,
          )}\n`,
        ),
      ],
      after,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mutations.length, 1);
    assert.deepEqual(
      JSON.parse(decoder.decode(result.mutations[0]!.content)) as unknown,
      {
        env: { ADDITIONAL_TOOL: "1.4.0", TOOL_VERSION: toolVersion },
        features: { beta: true },
        userOnly: { retained: true },
      },
    );
  });

  void it("restores generated regions by named text anchor while preserving surrounding user text", () => {
    const launcherPath = "deploy/launcher.txt";
    const anchor = {
      id: "tool-version-anchor",
      location: { kind: "text-anchor" as const, name: "TOOL_VERSION" },
    };
    const anchoredText = (value: string) =>
      [
        "FROM base:1",
        "# @template-mirror TOOL_VERSION",
        `ARG TOOL_VERSION="${value}"`,
        "# @end-template-mirror",
        "RUN existing step",
        "",
      ].join("\n");
    const mirrorProjection = (value: string) =>
      textProjection(launcherPath, anchoredText(value), {
        mirrorSlots: [anchor],
      });
    const result = reconcileProjectProjections({
      before: mirrorProjection(toolVersion),
      current: [
        fileEntry(
          launcherPath,
          anchoredText(driftedVersion).replace(
            "RUN existing step\n",
            "RUN existing step\nRUN user step\n",
          ),
        ),
      ],
      after: mirrorProjection(toolVersion),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(
      decoder.decode(result.mutations[0]!.content),
      anchoredText(toolVersion).replace(
        "RUN existing step\n",
        "RUN existing step\nRUN user step\n",
      ),
    );
  });

  void it("returns a blocking conflict when a still-referenced anchor cannot be located", () => {
    const launcherPath = "deploy/launcher.txt";
    const anchor = {
      id: "tool-version-anchor",
      location: { kind: "text-anchor" as const, name: "TOOL_VERSION" },
    };
    const expected = [
      "FROM base:1",
      "# @template-mirror TOOL_VERSION",
      `ARG TOOL_VERSION="24.16.0"`,
      "# @end-template-mirror",
      "RUN existing step",
      "",
    ].join("\n");
    const result = reconcileProjectProjections({
      before: textProjection(launcherPath, expected, {
        mirrorSlots: [anchor],
      }),
      current: [
        fileEntry(
          launcherPath,
          'FROM base:1\nARG TOOL_VERSION="999"\n# @end-template-mirror\nFROM node:${TOOL_VERSION}-slim\n',
        ),
      ],
      after: textProjection(launcherPath, expected, {
        mirrorSlots: [anchor],
      }),
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0]?.path, launcherPath);
    assert.equal(result.conflicts[0]?.location, "TOOL_VERSION");
    assert.match(
      result.conflicts[0]?.reason ?? "",
      /anchor could not be located/u,
    );
    assert.equal(Object.hasOwn(result, "mutations"), false);
  });
});

void describe("planning and commit", () => {
  void it("previews without writing, and commits by merging user edits, keeping existing paths, and creating new package files", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-preview-"),
    );
    const beforeReadme = textProjection("README.md", "before\n");
    const beforePackage = textProjection(
      "docs/overview/README.md",
      "template overview\n",
    );
    const before = projection(
      [...beforeReadme.entries, ...beforePackage.entries],
      [...beforeReadme.reconciliation, ...beforePackage.reconciliation],
    );
    const afterReadme = textProjection("README.md", "before\ngenerated\n");
    const afterPackage = textProjection(
      "docs/overview/README.md",
      "template overview\n",
    );
    const afterNewPackage = textProjection(
      "docs/new/README.md",
      "new package\n",
    );
    const after = projection(
      [
        ...afterReadme.entries,
        ...afterPackage.entries,
        ...afterNewPackage.entries,
      ],
      [
        ...afterReadme.reconciliation,
        ...afterPackage.reconciliation,
        ...afterNewPackage.reconciliation,
      ],
    );
    const readmePath = path.join(targetRoot, "README.md");
    const existingPackagePath = path.join(
      targetRoot,
      "docs/overview/README.md",
    );
    const newPackagePath = path.join(targetRoot, "docs/new/README.md");

    try {
      await mkdir(path.dirname(existingPackagePath), { recursive: true });
      await writeFile(readmePath, "user heading\nbefore\n");
      await writeFile(existingPackagePath, "user overview\n");

      const planning = await planAtTarget({ targetRoot, before, after });
      assert.equal(planning.ok, true);
      if (!planning.ok) return;
      assert.deepEqual(
        planning.plan.actions.map(({ path: actionPath, action }) => [
          actionPath,
          action,
        ]),
        [
          ["README.md", "update"],
          ["docs/new/README.md", "create"],
        ],
      );
      assert.equal(
        await readFile(readmePath, "utf8"),
        "user heading\nbefore\n",
      );
      assert.equal(
        await readFile(existingPackagePath, "utf8"),
        "user overview\n",
      );
      await assert.rejects(stat(newPackagePath), { code: "ENOENT" });

      const committed = await commitProjectProjectionPlan({
        targetRoot,
        plan: planning.plan,
      });
      assert.equal(committed.ok, true);
      assert.equal(
        await readFile(readmePath, "utf8"),
        "user heading\nbefore\ngenerated\n",
      );
      assert.equal(
        await readFile(existingPackagePath, "utf8"),
        "user overview\n",
      );
      assert.equal(await readFile(newPackagePath, "utf8"), "new package\n");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("blocks the entire plan on any file conflict and leaves all target files untouched", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-no-partial-plan-"),
    );
    const beforeSource = {
      identity: "content:before",
      label: "Existing reference package",
    };
    const afterSource = {
      identity: "content:after",
      label: "Added reference package",
    };
    const beforeReadme = textProjection("README.md", "base\n", {
      sources: [beforeSource],
    });
    const beforeState = textProjection(".template/state.json", "before\n");
    const before = projection(
      [...beforeReadme.entries, ...beforeState.entries],
      [...beforeReadme.reconciliation, ...beforeState.reconciliation],
    );
    const afterReadme = textProjection("README.md", "generated\n", {
      sources: [afterSource],
    });
    const afterState = textProjection(".template/state.json", "after\n");
    const afterNewPackage = textProjection(
      "packages/new/README.md",
      "new package\n",
      { sources: [afterSource] },
    );
    const after = projection(
      [
        ...afterReadme.entries,
        ...afterState.entries,
        ...afterNewPackage.entries,
      ],
      [
        ...afterReadme.reconciliation,
        ...afterState.reconciliation,
        ...afterNewPackage.reconciliation,
      ],
    );
    const readmePath = path.join(targetRoot, "README.md");
    const statePath = path.join(targetRoot, ".template/state.json");
    const newPackagePath = path.join(targetRoot, "packages/new/README.md");

    try {
      await mkdir(path.join(targetRoot, ".template"), { recursive: true });
      await writeFile(readmePath, "user edit\n");
      await writeFile(statePath, "before\n");

      const planning = await planAtTarget({ targetRoot, before, after });
      assert.equal(planning.ok, false);
      if (planning.ok) return;
      assert.equal(planning.conflicts.length, 1);
      assert.equal(planning.conflicts[0]?.path, "README.md");
      assert.deepEqual(
        planning.conflicts[0]?.sources?.map(({ label }) => label),
        ["Existing reference package", "Added reference package"],
      );
      assert.equal(Object.hasOwn(planning, "plan"), false);
      assert.equal(await readFile(readmePath, "utf8"), "user edit\n");
      assert.equal(await readFile(statePath, "utf8"), "before\n");
      await assert.rejects(stat(newPackagePath), { code: "ENOENT" });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("rejects stale relevant facts while allowing commits after unrelated file changes", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-stale-facts-"),
    );
    const before = textProjection("README.md", "first\ncommon\nlast\n");
    const after = textProjection(
      "README.md",
      "first\ncommon\ngenerated\nlast\n",
    );
    const readmePath = path.join(targetRoot, "README.md");
    const providerPath = path.join(targetRoot, "provider.json");
    const unrelatedPath = path.join(targetRoot, "user-notes.txt");

    try {
      await writeFile(readmePath, "first\nprivate\ncommon\nlast\n");
      await writeFile(providerPath, '{"version":"first"}\n');

      const planning = await planAtTarget({
        targetRoot,
        before,
        after,
        additionalPaths: ["provider.json"],
      });
      assert.equal(planning.ok, true);
      if (!planning.ok) return;

      await writeFile(providerPath, '{"version":"changed"}\n');
      const stale = await commitProjectProjectionPlan({
        targetRoot,
        plan: planning.plan,
      });
      assert.equal(stale.ok, false);
      if (stale.ok) return;
      assert.ok(
        stale.conflicts.some(
          ({ path: conflictPath }) => conflictPath === "provider.json",
        ),
      );
      assert.equal(
        await readFile(readmePath, "utf8"),
        "first\nprivate\ncommon\nlast\n",
      );

      const freshPlanning = await planAtTarget({
        targetRoot,
        before,
        after,
        additionalPaths: ["provider.json"],
      });
      assert.equal(freshPlanning.ok, true);
      if (!freshPlanning.ok) return;
      await writeFile(unrelatedPath, "unrelated edit\n");
      const committed = await commitProjectProjectionPlan({
        targetRoot,
        plan: freshPlanning.plan,
      });
      assert.equal(committed.ok, true);
      assert.equal(
        await readFile(readmePath, "utf8"),
        "first\nprivate\ncommon\ngenerated\nlast\n",
      );
      assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated edit\n");
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("accepts only an empty or missing target for initialization and rejects stale plans after target changes", async () => {
    const parentRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-init-target-"),
    );
    const before: ProjectProjection = { entries: [], reconciliation: [] };
    const after = textProjection("README.md", "generated\n");
    const preconditions: readonly ProjectProjectionPathPrecondition[] = [
      {
        path: ".",
        kind: "directory-empty-or-missing",
        reason: "Initialization target must be empty or missing",
      },
    ];
    const missingTarget = path.join(parentRoot, "missing");
    const occupiedTarget = path.join(parentRoot, "occupied");

    try {
      const missingPlan = await planAtTarget({
        targetRoot: missingTarget,
        before,
        after,
        preconditions,
      });
      assert.equal(missingPlan.ok, true);
      if (!missingPlan.ok) return;
      await assert.rejects(stat(missingTarget), { code: "ENOENT" });
      const initialized = await commitProjectProjectionPlan({
        targetRoot: missingTarget,
        plan: missingPlan.plan,
      });
      assert.equal(initialized.ok, true);
      assert.equal(
        await readFile(path.join(missingTarget, "README.md"), "utf8"),
        "generated\n",
      );

      await mkdir(occupiedTarget);
      const occupiedPlan = await planAtTarget({
        targetRoot: occupiedTarget,
        before,
        after,
        preconditions,
      });
      assert.equal(occupiedPlan.ok, true);
      if (!occupiedPlan.ok) return;
      await writeFile(path.join(occupiedTarget, "OWNER"), "user data\n");
      const rejected = await commitProjectProjectionPlan({
        targetRoot: occupiedTarget,
        plan: occupiedPlan.plan,
      });
      assert.equal(rejected.ok, false);
      if (rejected.ok) return;
      assert.ok(
        rejected.conflicts.some(
          ({ path: conflictPath }) => conflictPath === ".",
        ),
      );
      assert.equal(
        await readFile(path.join(occupiedTarget, "OWNER"), "utf8"),
        "user data\n",
      );
      await assert.rejects(stat(path.join(occupiedTarget, "README.md")), {
        code: "ENOENT",
      });
    } finally {
      await rm(parentRoot, { recursive: true, force: true });
    }
  });

  void it("rejects an occupied new package path before commit while preserving the occupant and existing files", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-new-package-path-"),
    );
    const before = textProjection("README.md", "before\n");
    const afterReadme = textProjection("README.md", "after\n");
    const afterPackage = textProjection(
      "packages/new/README.md",
      "new package\n",
    );
    const after = projection(
      [...afterReadme.entries, ...afterPackage.entries],
      [...afterReadme.reconciliation, ...afterPackage.reconciliation],
    );
    const packagePath = path.join(targetRoot, "packages/new");
    const ownerPath = path.join(packagePath, "OWNER");
    const readmePath = path.join(targetRoot, "README.md");
    const preconditions: readonly ProjectProjectionPathPrecondition[] = [
      {
        path: "packages/new",
        kind: "must-not-exist",
        reason: "New package directory is already occupied",
      },
    ];

    try {
      await writeFile(readmePath, "before\n");
      const planning = await planAtTarget({
        targetRoot,
        before,
        after,
        preconditions,
      });
      assert.equal(planning.ok, true);
      if (!planning.ok) return;
      await mkdir(packagePath, { recursive: true });
      await writeFile(ownerPath, "user data\n");

      const rejected = await commitProjectProjectionPlan({
        targetRoot,
        plan: planning.plan,
      });
      assert.equal(rejected.ok, false);
      if (rejected.ok) return;
      assert.ok(
        rejected.conflicts.some(
          ({ path: conflictPath }) => conflictPath === "packages/new",
        ),
      );
      assert.equal(await readFile(readmePath, "utf8"), "before\n");
      assert.equal(await readFile(ownerPath, "utf8"), "user data\n");
      await assert.rejects(stat(path.join(packagePath, "README.md")), {
        code: "ENOENT",
      });
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });

  void it("restores overwritten file contents and full modes when commit fails", async () => {
    const targetRoot = await mkdtemp(
      path.join(tmpdir(), "template-projection-write-rollback-"),
    );
    const statePath = ".template/state.json";
    const guidePath = "docs/guide.md";
    const beforeState = projection(
      [fileEntry(statePath, '{\n  "state": "before"\n}\n')],
      [{ path: statePath, driver: "canonical" }],
    );
    const beforeGuide = textProjection(guidePath, "before\n");
    const before = projection(
      [...beforeState.entries, ...beforeGuide.entries],
      [...beforeState.reconciliation, ...beforeGuide.reconciliation],
    );
    const afterState = projection(
      [fileEntry(statePath, '{\n  "state": "after"\n}\n')],
      [{ path: statePath, driver: "canonical" }],
    );
    const afterGuide = textProjection(guidePath, "after\n");
    const after = projection(
      [...afterState.entries, ...afterGuide.entries],
      [...afterState.reconciliation, ...afterGuide.reconciliation],
    );
    const stateFile = path.join(targetRoot, statePath);
    const guideFile = path.join(targetRoot, guidePath);

    try {
      await mkdir(path.dirname(stateFile), { recursive: true });
      await mkdir(path.dirname(guideFile), { recursive: true });
      await writeFile(stateFile, '{\n  "state": "before"\n}\n');
      await writeFile(guideFile, "before\n");
      await chmod(stateFile, 0o640);
      await chmod(guideFile, 0o751);

      const planning = await planAtTarget({ targetRoot, before, after });
      assert.equal(planning.ok, true);
      if (!planning.ok) return;

      await assert.rejects(
        commitProjectProjectionPlan({
          targetRoot,
          plan: planning.plan,
          dependencies: {
            async commitMutation(options) {
              if (options.relativePath === guidePath) {
                throw new Error("injected filesystem write failure");
              }
              await options.commit();
            },
          },
        }),
        /injected filesystem write failure/u,
      );
      assert.equal(
        await readFile(stateFile, "utf8"),
        '{\n  "state": "before"\n}\n',
      );
      assert.equal(await readFile(guideFile, "utf8"), "before\n");
      assert.equal((await stat(stateFile)).mode & 0o777, 0o640);
      assert.equal((await stat(guideFile)).mode & 0o777, 0o751);
    } finally {
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});
