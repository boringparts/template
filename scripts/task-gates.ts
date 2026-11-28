import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runTaskGateCli } from "@boringparts/tooling-config/task-gates";

export {
  inspectTaskGate,
  runTaskGate,
  runTaskGateCli,
  type TaskGate,
} from "@boringparts/tooling-config/task-gates";

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(resolve(mainFile)).href === import.meta.url
) {
  void runTaskGateCli();
}
