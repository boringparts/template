import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  standardPresetVerificationScenarios,
  type PresetVerificationScenario,
} from "../packages/presets/src/scenarios.ts";

type PresetScenario = PresetVerificationScenario & {
  readonly kind: "preset";
};

type RepoSmokeScenario = {
  readonly kind: "repo-smoke";
  readonly id: "repo-devcontainer";
};

type VerificationScenario = PresetScenario | RepoSmokeScenario;

const presetScenarios: readonly PresetScenario[] =
  standardPresetVerificationScenarios.map((scenario) => ({
    kind: "preset",
    ...scenario,
  }));

const repoSmokeScenario: RepoSmokeScenario = {
  kind: "repo-smoke",
  id: "repo-devcontainer",
};

const allScenarios: readonly VerificationScenario[] = [
  ...presetScenarios,
  repoSmokeScenario,
];

const scenariosById = new Map<string, VerificationScenario>(
  allScenarios.map((scenario) => [scenario.id, scenario]),
);

const localContextNames = new Set([
  "AGENTS.md",
  ".agents",
  "docs",
  ".scratch",
  ".codex",
  ".git",
]);

const runtimeDirectoryNames = new Set([
  "node_modules",
  "dist",
  "templates",
  "target",
  "coverage",
  ".turbo",
  ".pnpm-store",
  ".vitest",
  ".local",
  "playwright-report",
  "test-results",
]);

const diagnosticSubpaths = [
  "test-results",
  "playwright-report",
  ".vitest/attachments",
] as const;

function resolveExecutable(name: string, searchRoot: string): string {
  const candidate = path.join(searchRoot, "node_modules", ".bin", name);
  return existsSync(candidate) ? candidate : name;
}

function runCaptured(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): string {
  return execFileSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runStreaming(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Command "${command} ${args.join(" ")}" failed (${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`})`,
        ),
      );
    });
  });
}

type ParsedCliArgs =
  | { readonly action: "list" }
  | {
      readonly action: "run";
      readonly scenarios: readonly VerificationScenario[];
      readonly diagnosticsDir?: string;
    };

function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let listScenarios = false;
  const selectedIds: string[] = [];
  let diagnosticsDir = process.env.TEMPLATE_CONTAINER_DIAGNOSTICS_DIR;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--list-scenarios") {
      listScenarios = true;
      continue;
    }
    if (arg === "--repo-smoke") {
      selectedIds.push(repoSmokeScenario.id);
      continue;
    }
    if (arg === "--scenario" || arg.startsWith("--scenario=")) {
      const value =
        arg === "--scenario" ? args[++index] : arg.slice("--scenario=".length);
      if (value === undefined || value.length === 0) {
        throw new Error("--scenario requires a scenario ID");
      }
      selectedIds.push(value);
      continue;
    }
    if (arg === "--diagnostics-dir" || arg.startsWith("--diagnostics-dir=")) {
      const value =
        arg === "--diagnostics-dir"
          ? args[++index]
          : arg.slice("--diagnostics-dir=".length);
      if (value === undefined || value.length === 0) {
        throw new Error("--diagnostics-dir requires a directory path");
      }
      diagnosticsDir = path.resolve(value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (listScenarios) {
    return { action: "list" };
  }

  if (selectedIds.length === 0) {
    return {
      action: "run",
      scenarios: allScenarios,
      ...(diagnosticsDir === undefined ? {} : { diagnosticsDir }),
    };
  }

  const seen = new Set<string>();
  const scenarios: VerificationScenario[] = [];
  for (const id of selectedIds) {
    const scenario = scenariosById.get(id);
    if (scenario === undefined) {
      throw new Error(
        `Unknown scenario "${id}". Available scenarios: ${allScenarios.map((s) => s.id).join(", ")}`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      scenarios.push(scenario);
    }
  }

  return {
    action: "run",
    scenarios,
    ...(diagnosticsDir === undefined ? {} : { diagnosticsDir }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runWithTransientRetry(
  label: string,
  operation: () => Promise<void>,
  maxAttempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Warning: ${label} failed on attempt ${String(attempt)}/${String(maxAttempts)} (${message}); retrying in 2s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

async function runInsideDevcontainer(options: {
  readonly scenarioId: string;
  readonly projectDir: string;
  readonly devcontainerBin: string;
  readonly commands: readonly (readonly [string, ...string[]])[];
  readonly diagnosticsDir?: string;
}): Promise<void> {
  const uniqueId = `tpl-verify-${options.scenarioId}-${randomUUID().slice(0, 8)}`;
  const idLabel = `com.boringparts.template.verify=${uniqueId}`;
  const workspaceName = path.basename(options.projectDir);
  const containerWorkspaceFolder = `/workspaces/${workspaceName}`;
  const workspaceVolume = `${uniqueId}-workspace`;
  const ownedVolumes = new Set<string>([workspaceVolume]);

  const sessionTempDir = mkdtempSync(
    path.join(tmpdir(), `template-dc-${options.scenarioId}-`),
  );
  const devcontainerTmpDir = path.join(sessionTempDir, "dc-tmp");
  mkdirSync(devcontainerTmpDir, { recursive: true });

  const configPath = path.join(
    options.projectDir,
    ".devcontainer",
    "devcontainer.json",
  );
  const baseConfig = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    unknown
  >;

  const baseMounts = Array.isArray(baseConfig.mounts) ? baseConfig.mounts : [];
  const overrideMounts = baseMounts.map((mount) => {
    if (
      isRecord(mount) &&
      mount.type === "volume" &&
      typeof mount.source === "string" &&
      mount.source.includes("${devcontainerId}")
    ) {
      const source = mount.source.replaceAll("${devcontainerId}", uniqueId);
      ownedVolumes.add(source);
      return { ...mount, source };
    }
    return mount;
  });

  // Always use a named Docker volume for workspaceMount + docker cp so Docker-outside-of-Docker
  // environments (where /tmp lives in container overlayfs) and bare CI runners behave identically.
  const overrideConfig = {
    ...baseConfig,
    workspaceMount: `type=volume,source=${workspaceVolume},target=${containerWorkspaceFolder}`,
    workspaceFolder: containerWorkspaceFolder,
    mounts: overrideMounts,
  };
  const overridePath = path.join(sessionTempDir, "override-devcontainer.json");
  writeFileSync(overridePath, `${JSON.stringify(overrideConfig, null, 2)}\n`);

  const devcontainerEnv: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: devcontainerTmpDir,
  };

  let containerId: string | undefined;

  try {
    await runWithTransientRetry(`devcontainer up (${options.scenarioId})`, () =>
      runStreaming(
        options.devcontainerBin,
        [
          "up",
          "--workspace-folder",
          options.projectDir,
          "--config",
          configPath,
          "--override-config",
          overridePath,
          "--no-lockfile",
          "--skip-post-create",
          "--id-label",
          idLabel,
        ],
        { cwd: options.projectDir, env: devcontainerEnv },
      ),
    );

    const containerIds = runCaptured(
      "docker",
      ["ps", "-aq", "--filter", `label=${idLabel}`],
      { cwd: options.projectDir },
    )
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    containerId = containerIds[0];
    if (containerId === undefined) {
      throw new Error(
        `devcontainer up succeeded for ${options.scenarioId} but no container matched label ${idLabel}`,
      );
    }

    // Copy workspace files into the named Docker volume mounted inside the container.
    await runStreaming(
      "docker",
      [
        "cp",
        `${options.projectDir}/.`,
        `${containerId}:${containerWorkspaceFolder}/`,
      ],
      { cwd: options.projectDir },
    );

    await runStreaming(
      options.devcontainerBin,
      [
        "exec",
        "--workspace-folder",
        options.projectDir,
        "--config",
        configPath,
        "--override-config",
        overridePath,
        "--id-label",
        idLabel,
        "git",
        "config",
        "--global",
        "--add",
        "safe.directory",
        containerWorkspaceFolder,
      ],
      { cwd: options.projectDir, env: devcontainerEnv },
    );

    for (const [cmd, ...cmdArgs] of options.commands) {
      await runStreaming(
        options.devcontainerBin,
        [
          "exec",
          "--workspace-folder",
          options.projectDir,
          "--config",
          configPath,
          "--override-config",
          overridePath,
          "--id-label",
          idLabel,
          cmd,
          ...cmdArgs,
        ],
        { cwd: options.projectDir, env: devcontainerEnv },
      );
    }
  } catch (error) {
    if (containerId !== undefined && options.diagnosticsDir !== undefined) {
      await collectContainerDiagnostics(
        containerId,
        containerWorkspaceFolder,
        path.join(options.diagnosticsDir, options.scenarioId),
        options.projectDir,
      );
    }
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      const containerIds = runCaptured(
        "docker",
        ["ps", "-aq", "--filter", `label=${idLabel}`],
        { cwd: sessionTempDir },
      )
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      if (containerIds.length > 0) {
        runCaptured("docker", ["rm", "-f", "-v", ...containerIds], {
          cwd: sessionTempDir,
        });
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    for (const volume of ownedVolumes) {
      try {
        runCaptured("docker", ["volume", "rm", "-f", volume], {
          cwd: sessionTempDir,
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }

    rmSync(sessionTempDir, { recursive: true, force: true });

    if (cleanupErrors.length > 0) {
      console.error(
        `Warning: container cleanup encountered errors for ${options.scenarioId}:`,
        cleanupErrors,
      );
    }
  }
}

async function collectContainerDiagnostics(
  containerId: string,
  containerWorkspaceFolder: string,
  targetDir: string,
  cwd: string,
): Promise<void> {
  try {
    const matches = runCaptured(
      "docker",
      [
        "exec",
        containerId,
        "sh",
        "-c",
        `cd "${containerWorkspaceFolder}" && find . -maxdepth 4 \\( -name test-results -o -name playwright-report -o -path "*/.vitest/attachments" \\) 2>/dev/null || true`,
      ],
      { cwd },
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean);

    for (const rel of matches) {
      const cleanRel = rel.replace(/^\.\//u, "");
      if (
        !diagnosticSubpaths.some(
          (marker) => cleanRel === marker || cleanRel.endsWith(`/${marker}`),
        )
      ) {
        continue;
      }
      const dest = path.join(targetDir, cleanRel);
      mkdirSync(path.dirname(dest), { recursive: true });
      try {
        runCaptured(
          "docker",
          [
            "cp",
            `${containerId}:${containerWorkspaceFolder}/${cleanRel}`,
            dest,
          ],
          { cwd },
        );
      } catch {
        // Best-effort diagnostics copy.
      }
    }
  } catch {
    // Best-effort diagnostics discovery.
  }
}

async function runPresetScenario(options: {
  readonly scenario: PresetScenario;
  readonly tarballPath: string;
  readonly devcontainerBin: string;
  readonly diagnosticsDir?: string;
}): Promise<void> {
  const workDir = mkdtempSync(
    path.join(tmpdir(), `template-scenario-${options.scenario.id}-`),
  );
  try {
    const consumerDir = path.join(workDir, "consumer");
    const projectDir = path.join(workDir, options.scenario.id);
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(
      path.join(consumerDir, "package.json"),
      JSON.stringify({
        name: "isolated-verifier",
        private: true,
        type: "module",
      }),
    );

    console.log(
      `\n==> [${options.scenario.id}] Installing packed @boringparts/template`,
    );
    await runStreaming(
      "npm",
      [
        "install",
        "--ignore-scripts=false",
        "--no-audit",
        "--no-fund",
        options.tarballPath,
      ],
      { cwd: consumerDir },
    );

    const templateBin = path.join(consumerDir, "node_modules/.bin/template");
    runCaptured(templateBin, ["--version"], { cwd: consumerDir });
    runCaptured(templateBin, ["--schema"], { cwd: consumerDir });
    runCaptured(templateBin, ["presets"], { cwd: consumerDir });

    console.log(`==> [${options.scenario.id}] Running template init`);
    await runStreaming(
      templateBin,
      ["init", projectDir, ...options.scenario.args],
      { cwd: workDir },
    );

    console.log(
      `==> [${options.scenario.id}] Starting devcontainer & running pnpm check:full`,
    );
    await runInsideDevcontainer({
      scenarioId: options.scenario.id,
      projectDir,
      devcontainerBin: options.devcontainerBin,
      commands: [
        ["pnpm", "install"],
        ["pnpm", "run", "check:full"],
      ],
      ...(options.diagnosticsDir === undefined
        ? {}
        : { diagnosticsDir: options.diagnosticsDir }),
    });
    console.log(`==> [${options.scenario.id}] PASSED`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function runRepoSmokeScenario(options: {
  readonly workspaceRoot: string;
  readonly devcontainerBin: string;
  readonly diagnosticsDir?: string;
}): Promise<void> {
  const workDir = mkdtempSync(path.join(tmpdir(), "template-repo-smoke-"));
  try {
    const snapshotDir = path.join(workDir, "template");
    mkdirSync(snapshotDir, { recursive: true });

    console.log(
      "\n==> [repo-devcontainer] Snapshotting repository working tree",
    );
    const files = runCaptured(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: options.workspaceRoot },
    )
      .split("\0")
      .filter(Boolean);

    for (const file of new Set(files)) {
      const segments = file.split("/");
      if (
        localContextNames.has(segments[0]!) ||
        file.startsWith(".changeset/packed/") ||
        /^GLOSSARY.*\.md$/u.test(segments[0]!) ||
        segments.some((segment) => runtimeDirectoryNames.has(segment))
      ) {
        continue;
      }
      const sourcePath = path.join(options.workspaceRoot, file);
      if (!existsSync(sourcePath)) {
        continue;
      }
      const destPath = path.join(snapshotDir, file);
      mkdirSync(path.dirname(destPath), { recursive: true });
      cpSync(sourcePath, destPath, { verbatimSymlinks: true });
    }

    runCaptured("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: snapshotDir,
    });
    runCaptured("git", ["add", "--all"], { cwd: snapshotDir });
    runCaptured(
      "git",
      [
        "-c",
        "user.name=Template container check",
        "-c",
        "user.email=template-container-check@localhost",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "--no-verify",
        "-m",
        "Snapshot for repository devcontainer smoke check",
      ],
      { cwd: snapshotDir },
    );

    console.log(
      "==> [repo-devcontainer] Starting devcontainer & running pnpm check",
    );
    await runInsideDevcontainer({
      scenarioId: repoSmokeScenario.id,
      projectDir: snapshotDir,
      devcontainerBin: options.devcontainerBin,
      commands: [
        ["pnpm", "install", "--frozen-lockfile"],
        ["pnpm", "run", "check"],
      ],
      ...(options.diagnosticsDir === undefined
        ? {}
        : { diagnosticsDir: options.diagnosticsDir }),
    });
    console.log("==> [repo-devcontainer] PASSED");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  let parsed: ParsedCliArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      "Usage: verify-containers.ts [--list-scenarios] [--scenario <id>] [--repo-smoke] [--diagnostics-dir <dir>]",
    );
    process.exitCode = 2;
    return;
  }

  if (parsed.action === "list") {
    for (const scenario of allScenarios) {
      process.stdout.write(`${scenario.id}\n`);
    }
    return;
  }

  const workspaceRoot = process.cwd();
  const devcontainerBin = resolveExecutable("devcontainer", workspaceRoot);

  const needsTarball = parsed.scenarios.some(
    (scenario) => scenario.kind === "preset",
  );
  const packWorkDir = needsTarball
    ? mkdtempSync(path.join(tmpdir(), "template-verify-pack-"))
    : undefined;

  try {
    let tarballPath: string | undefined;
    if (needsTarball && packWorkDir !== undefined) {
      console.log("==> Building @boringparts/template distribution");
      await runStreaming(
        "pnpm",
        ["--filter", "@boringparts/template", "run", "build"],
        { cwd: workspaceRoot },
      );
      const packOut = runCaptured(
        "pnpm",
        [
          "--filter",
          "@boringparts/template",
          "pack",
          "--pack-destination",
          packWorkDir,
        ],
        { cwd: workspaceRoot },
      ).trim();
      tarballPath = packOut.split(/\r?\n/u).at(-1);
      if (tarballPath === undefined || !existsSync(tarballPath)) {
        throw new Error(
          `Failed to locate packed tarball: ${String(tarballPath)}`,
        );
      }
    }

    for (const scenario of parsed.scenarios) {
      if (scenario.kind === "repo-smoke") {
        await runRepoSmokeScenario({
          workspaceRoot,
          devcontainerBin,
          ...(parsed.diagnosticsDir === undefined
            ? {}
            : { diagnosticsDir: parsed.diagnosticsDir }),
        });
      } else {
        await runPresetScenario({
          scenario,
          tarballPath: tarballPath!,
          devcontainerBin,
          ...(parsed.diagnosticsDir === undefined
            ? {}
            : { diagnosticsDir: parsed.diagnosticsDir }),
        });
      }
    }
  } finally {
    if (packWorkDir !== undefined) {
      rmSync(packWorkDir, { recursive: true, force: true });
    }
  }
}

await main();
