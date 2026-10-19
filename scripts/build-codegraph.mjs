// Builds rene's own CodeGraph (packages/codegraph), which the source-graph
// tools use. Its dependencies are installed from its lockfile when they are
// missing or the lockfile changed, then its own build runs (TypeScript,
// grammar assets and the viewer UI). Telemetry stays off throughout.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const codegraph = join(root, "packages", "codegraph");
const env = {
  ...process.env,
  DO_NOT_TRACK: "1",
  CODEGRAPH_TELEMETRY: "0",
};

const npm = (args) => {
  const result = spawnSync("npm", args, {
    cwd: codegraph,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.error(
      `npm ${args.join(" ")} failed in packages/codegraph (status ${result.status ?? result.signal}).`,
    );
    process.exit(result.status ?? 1);
  }
};

// npm ci records the installed tree in node_modules/.package-lock.json; a
// lockfile newer than that record means the dependencies changed.
const installed = join(codegraph, "node_modules", ".package-lock.json");
const lockfile = join(codegraph, "package-lock.json");
if (
  !existsSync(installed) ||
  statSync(lockfile).mtimeMs > statSync(installed).mtimeMs
)
  npm(["ci", "--no-audit", "--no-fund"]);
npm(["run", "build"]);
