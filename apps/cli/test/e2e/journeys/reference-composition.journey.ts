import assert from "node:assert/strict";
import {
  lstat,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { format } from "oxfmt";

import type { CliJourney } from "../journey.ts";
import { requireReferencePresetName } from "../reference-preset.ts";

const libraryPresetName = requireReferencePresetName("@ykdz/reference-ts-lib");
const applicationPresetName = requireReferencePresetName(
  "@ykdz/reference-vue-app",
);

async function snapshot(root: string, relative = ""): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = path.join(relative, name);
    const info = await lstat(path.join(root, child));
    result.push({
      path: child,
      mode: info.mode,
      content: info.isFile()
        ? (await readFile(path.join(root, child))).toString("base64")
        : info.isSymbolicLink()
          ? await readlink(path.join(root, child))
          : null,
    });
    if (info.isDirectory()) result.push(...(await snapshot(root, child)));
  }
  return result;
}

const journey: CliJourney = {
  name: "reference-composition",
  modes: ["source", "distribution", "packed"],
  async setup() {},
  commands(context) {
    const project = path.join(context.workDir, "project");
    let before: unknown[];
    let generation: string;
    const addition = (name: string) => [
      "add",
      "package",
      "--preset",
      applicationPresetName,
      "--name",
      name,
      "--path",
      `services/${name}`,
    ];
    const remember = async () => {
      before = await snapshot(project);
    };
    const unchanged = async () =>
      assert.deepEqual(await snapshot(project), before);
    return [
      {
        name: "initialize library project",
        args: [
          "init",
          "project",
          "--preset",
          libraryPresetName,
          "--scope",
          "acme",
        ],
      },
      {
        name: "preview standalone application",
        cwd: project,
        args: [...addition("portal"), "--dry-run"],
        prepare: remember,
      },
      {
        name: "atomically add first application",
        cwd: project,
        args: addition("portal"),
        prepare: unchanged,
      },
      {
        name: "preserve app and config customizations and preview second application",
        cwd: project,
        args: [...addition("console"), "--dry-run"],
        async prepare() {
          for (const file of [
            "services/portal/src/stores/counter.ts",
            "packages/tooling-config/oxfmt.config.ts",
          ]) {
            const full = path.join(project, file);
            await writeFile(
              full,
              `${await readFile(full, "utf8")}\n// User-retained customization\n`,
            );
          }
          await writeFile(
            path.join(project, "user-note.txt"),
            "user root file\n",
          );
          const manifestPath = path.join(project, "package.json");
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.scripts["user:note"] = "node --version";
          await writeFile(
            manifestPath,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          const turboPath = path.join(project, "turbo.json");
          const turbo = JSON.parse(await readFile(turboPath, "utf8"));
          turbo.tasks["//#user:note"] = {
            tags: ["work:preparation"],
            cache: false,
          };
          await writeFile(
            turboPath,
            (await format(turboPath, JSON.stringify(turbo), { printWidth: 80 }))
              .code,
          );
          await remember();
        },
      },
      {
        name: "add second standalone application reusing tooling-config",
        cwd: project,
        args: addition("console"),
        prepare: unchanged,
      },
      {
        name: "repeat application addition performs no writes",
        cwd: project,
        args: addition("console"),
        prepare: remember,
      },
      {
        name: "subsequent addition replays tooling-config bindings again",
        cwd: project,
        args: addition("dashboard"),
        prepare: unchanged,
      },
      {
        name: "conflict rejects entire multi-package transaction",
        cwd: project,
        args: addition("conflicting"),
        async prepare() {
          const file = path.join(project, ".template/generation.json");
          generation = await readFile(file, "utf8");
          await writeFile(file, JSON.stringify(JSON.parse(generation)));
          await remember();
        },
      },
      {
        name: "preview after conflict still performs no writes",
        cwd: project,
        args: [...addition("conflicting"), "--dry-run"],
        prepare: unchanged,
      },
      {
        name: "install dependencies in customized multi-app workspace",
        cwd: project,
        executable: "pnpm",
        args: ["install"],
        async prepare() {
          await unchanged();
          await writeFile(
            path.join(project, ".template/generation.json"),
            generation,
          );
        },
      },
      {
        name: "check three independent applications with retained customizations",
        cwd: project,
        executable: "pnpm",
        args: ["run", "check"],
      },
    ];
  },
  async assertions({ context, results }) {
    for (const result of results.slice(0, 7))
      assert.equal(
        result.exitCode,
        0,
        `${result.commandName}\n${result.stderr}`,
      );
    for (const index of [1, 3]) {
      const result = JSON.parse(results[index]!.stdout);
      assert.equal(result.variant, "planned");
      assert.equal(result.data.dryRun, true);
    }
    const preview = JSON.parse(results[1]!.stdout);
    assert.ok(
      preview.data.actions.some(
        (action: { path: string }) =>
          action.path === "services/portal/package.json",
      ),
    );
    assert.deepEqual(JSON.parse(results[5]!.stdout).data.actions, []);
    for (const result of results.slice(7, 9)) {
      assert.equal(result.exitCode, 1);
      assert.equal(JSON.parse(result.stderr).variant, "conflict");
      assert.deepEqual(JSON.parse(result.stderr).data.actions, []);
    }
    for (const result of results.slice(9))
      assert.equal(
        result.exitCode,
        0,
        `${result.commandName}\n${result.stdout}\n${result.stderr}`,
      );
    const project = path.join(context.workDir, "project");
    for (const name of ["portal", "console", "dashboard"]) {
      const manifest = JSON.parse(
        await readFile(
          path.join(project, `services/${name}/package.json`),
          "utf8",
        ),
      );
      assert.equal(manifest.name, `@acme/${name}`);
      const configurationLink =
        manifest.devDependencies["@acme/tooling-config"];
      assert.equal(configurationLink, "workspace:*");
    }
    for (const file of [
      "services/portal/src/stores/counter.ts",
      "packages/tooling-config/oxfmt.config.ts",
    ]) {
      assert.ok(
        (await readFile(path.join(project, file), "utf8")).endsWith(
          "// User-retained customization\n",
        ),
      );
    }
    assert.equal(
      await readFile(path.join(project, "user-note.txt"), "utf8"),
      "user root file\n",
    );
    const root = JSON.parse(
      await readFile(path.join(project, "package.json"), "utf8"),
    );
    assert.equal(root.scripts["user:note"], "node --version");
    const blueprint = JSON.parse(
      await readFile(path.join(project, ".template/blueprint.json"), "utf8"),
    );
    assert.equal(
      blueprint.packages.filter(
        (item: { name: string }) => item.name === "@acme/tooling-config",
      ).length,
      1,
    );
  },
};

export default journey;
