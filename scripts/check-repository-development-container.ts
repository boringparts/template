import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  containerCommandTimeoutMilliseconds,
  createDevelopmentContainerSession,
  developmentContainerPnpmStorePath,
  type ContainerCommandRunner,
} from "@boringparts/template-verification-runtime/development-container-session";
import { execa } from "execa";

import { repositoryDevelopmentEnvironment } from "./repository-environment.ts";
import { readTemplateToolchainDeclarations } from "./template-toolchain-declarations.ts";

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
  "template-dist",
  ".package",
  "target",
  "coverage",
  ".turbo",
  ".pnpm-store",
  ".template",
  ".fixture-evidence",
  ".fixture-evidence-activity",
  ".fixture-native-cache",
  ".fixture-workspace",
]);

function commandOutput(result: unknown): string {
  if (
    typeof result === "object" &&
    result !== null &&
    "stdout" in result &&
    typeof result.stdout === "string"
  )
    return result.stdout;
  throw new Error(
    "Source development container check command returned no stdout",
  );
}

async function dockerWorkspaceSource(
  projectDir: string,
  run: ContainerCommandRunner,
  cancelSignal: AbortSignal,
): Promise<string> {
  if (!existsSync("/.dockerenv")) return projectDir;
  const mounts = JSON.parse(
    commandOutput(
      await run(
        "docker",
        ["inspect", hostname(), "--format", "{{json .Mounts}}"],
        { cwd: projectDir, cancelSignal },
      ),
    ),
  ) as {
    readonly Type: string;
    readonly Source: string;
    readonly Destination: string;
  }[];
  const mount = mounts
    .filter(
      ({ Type, Destination }) =>
        Type === "bind" &&
        (projectDir === Destination ||
          projectDir.startsWith(`${Destination}/`)),
    )
    .sort(
      (left, right) => right.Destination.length - left.Destination.length,
    )[0];
  if (mount === undefined)
    throw new Error(
      `Could not resolve Docker host path for temporary workspace ${projectDir} from active container bind mounts`,
    );
  return path.join(mount.Source, path.relative(mount.Destination, projectDir));
}

/**
 * Snapshots the current working tree (excluding local agent context and runtime
 * build directories) into a temporary workspace and runs repository checks
 * inside its devcontainer. Removes the workspace on success and preserves it
 * for diagnostics on failure.
 */
export async function checkRepositoryDevelopmentContainer(
  options: {
    readonly repositoryRoot?: string;
    readonly run?: ContainerCommandRunner;
    readonly cancelSignal?: AbortSignal;
  } = {},
): Promise<void> {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const cancelSignal =
    options.cancelSignal ??
    AbortSignal.timeout(containerCommandTimeoutMilliseconds);
  const run: ContainerCommandRunner =
    options.run ??
    ((command, args, commandOptions) =>
      execa(command, [...args], {
        timeout: containerCommandTimeoutMilliseconds,
        ...commandOptions,
      }));
  const temporaryRoot = path.join(
    repositoryRoot,
    ".fixture-workspace",
    "repository-development-container",
  );
  await mkdir(temporaryRoot, { recursive: true });
  const temporaryProjectDir = await mkdtemp(
    path.join(temporaryRoot, "source-"),
  );
  let projectDir = temporaryProjectDir;
  let preserveWorkspace = false;
  try {
    projectDir = await realpath(temporaryProjectDir);
    const files = commandOutput(
      await run(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: repositoryRoot, cancelSignal },
      ),
    )
      .split("\0")
      .filter(Boolean);
    for (const file of new Set(files)) {
      cancelSignal.throwIfAborted();
      const segments = file.split("/");
      if (
        localContextNames.has(segments[0]!) ||
        file.startsWith(".changeset/packed/") ||
        /^GLOSSARY.*\.md$/u.test(segments[0]!) ||
        segments.some((segment) => runtimeDirectoryNames.has(segment))
      )
        continue;
      const destination = path.join(projectDir, file);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await cp(path.join(repositoryRoot, file), destination, {
          verbatimSymlinks: true,
        });
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
    }
    await run("git", ["init", "--quiet", "--initial-branch=main"], {
      cwd: projectDir,
      cancelSignal,
    });
    await run("git", ["add", "--all"], { cwd: projectDir, cancelSignal });
    await run(
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
        "Snapshot for source development container check",
      ],
      { cwd: projectDir, cancelSignal },
    );
    const environment = await repositoryDevelopmentEnvironment(
      await readTemplateToolchainDeclarations(projectDir),
    );
    const hostSource = await dockerWorkspaceSource(
      projectDir,
      run,
      cancelSignal,
    );
    if (hostSource.includes(","))
      throw new Error(
        `Docker bind mount source path must not contain commas: ${hostSource}`,
      );
    const session = createDevelopmentContainerSession({
      projectDir,
      probes: environment.probes,
      dependencyPreparation: {
        trustWorkspace: true,
        commands: [
          {
            command: "pnpm",
            args: [
              "install",
              "--frozen-lockfile",
              "--store-dir",
              developmentContainerPnpmStorePath,
            ],
            retryRegistry: "npm",
          },
        ],
      },
      ownedVolumePrefix: `template-repository-check-${path.basename(projectDir)}`,
      workspaceMount: {
        source: hostSource,
        target: `/workspaces/${path.basename(projectDir)}`,
      },
      cancelSignal,
      environment: process.env,
      onCleanupFailure: (error) => {
        console.error("Development container cleanup failed:", error);
      },
      recordActivity: (event) => {
        if (
          event.type === "retry" ||
          (event.type === "phase" && event.outcome === "failed")
        )
          console.error("Development container check activity:", event);
      },
      run,
    });
    await session.execute(async (execute) => {
      await execute("pnpm", ["run", "check"], {
        cwd: projectDir,
        stdio: "inherit",
      });
      await execute(
        "pnpm",
        [
          "exec",
          "turbo",
          "run",
          "test:browser",
          "@boringparts/reference-vue-app#test:e2e",
          "@boringparts/reference-vike-web#test:e2e",
          "@boringparts/preset-vue-hono-app#test:e2e",
          "--output-logs=errors-only",
        ],
        { cwd: projectDir, stdio: "inherit" },
      );
    });
  } catch (error) {
    preserveWorkspace = true;
    throw error;
  } finally {
    if (preserveWorkspace)
      console.error(
        `Source development container check did not complete; preserving diagnostic workspace: ${projectDir}`,
      );
    else await rm(projectDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const controller = new AbortController();
  let exitCode = 1;
  const cancel = (signal: "SIGINT" | "SIGTERM") => {
    exitCode = signal === "SIGINT" ? 130 : 143;
    controller.abort(
      new Error(`Source development container check received ${signal}`),
    );
  };
  const interrupt = () => cancel("SIGINT");
  const terminate = () => cancel("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    await checkRepositoryDevelopmentContainer({
      cancelSignal: controller.signal,
    });
  } catch (error) {
    console.error(error);
    process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
