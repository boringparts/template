import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Root bypasses directory permission checks on author directories; non-root users keep their current identity.
export const unprivilegedProcessOptions =
  process.geteuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};

/**
 * Runs `action` while the specified author directories are `chmod 0`, providing a
 * Node executable path outside those directories so unprivileged child processes
 * can still spawn when `process.execPath` resides inside a pnpm-managed workspace.
 */
export async function withUnreadableAuthorDirectories<Result>(
  directories: readonly { readonly path: string; readonly mode: number }[],
  action: (nodeExecutable: string) => Promise<Result>,
): Promise<Result> {
  const orderedDirectories = [...directories].sort(
    (left, right) => right.path.length - left.path.length,
  );
  let executableDirectory: string | undefined;
  let nodeExecutable = process.execPath;
  if (
    process.geteuid?.() === 0 &&
    orderedDirectories.some(({ path: directory }) => {
      const relative = path.relative(directory, process.execPath);
      return (
        relative !== "" &&
        !relative.startsWith("..") &&
        !path.isAbsolute(relative)
      );
    })
  ) {
    executableDirectory = await mkdtemp(
      path.join(tmpdir(), "unprivileged-node-"),
    );
    await chmod(executableDirectory, 0o755);
    nodeExecutable = path.join(
      executableDirectory,
      path.basename(process.execPath),
    );
    await copyFile(process.execPath, nodeExecutable);
    await chmod(nodeExecutable, 0o755);
  }
  try {
    for (const directory of orderedDirectories) {
      await chmod(directory.path, 0);
    }
    return await action(nodeExecutable);
  } finally {
    for (const directory of [...orderedDirectories].reverse()) {
      await chmod(directory.path, directory.mode);
    }
    if (executableDirectory !== undefined) {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  }
}
