import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

/**
 * Environment key naming another CodeGraph package folder to run instead of
 * rene's own (packages/codegraph), e.g. a checkout being worked on.
 */
export const CODEGRAPH_HOME_ENV = "REA_CODEGRAPH_HOME";

/** rene's own CodeGraph, from src/codegraph or dist/codegraph alike. */
export const BUNDLED_CODEGRAPH_HOME = fileURLToPath(
  new URL("../../packages/codegraph", import.meta.url),
);

const remediation = (bundled: boolean) =>
  bundled
    ? "Build rene's CodeGraph with npm run codegraph:build (npm run build:cached builds it too)."
    : `Build that CodeGraph (npm ci && npm run build in its folder), or unset ${CODEGRAPH_HOME_ENV} to use rene's own.`;

/** The CodeGraph install REA runs: its entry points and reported version. */
export interface CodeGraphInstall {
  readonly home: string;
  /** dist/bin/codegraph.js: the CLI, whose `serve --mcp` is the query server. */
  readonly cli: string;
  /** dist/index.js: the library the index worker loads. */
  readonly library: string;
  readonly version: string | null;
}

const unavailable = (operation: string, reason: string, bundled: boolean) =>
  new AnalysisCapabilityUnavailableError("codegraph", operation, reason, {
    userMessage: `${reason} ${remediation(bundled)}`,
  });

const isFile = async (path: string) =>
  (await stat(path).catch(() => undefined))?.isFile() === true;

/** Resolves and checks rene's CodeGraph, or the one REA_CODEGRAPH_HOME names. */
export const resolveCodeGraphInstall = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: string,
): Promise<Result<CodeGraphInstall, AnalysisCapabilityUnavailableError>> => {
  const override = environment[CODEGRAPH_HOME_ENV];
  const bundled = override === undefined || override === "";
  const selected = bundled ? BUNDLED_CODEGRAPH_HOME : override;
  if (!isAbsolute(selected))
    return err(
      unavailable(
        operation,
        `${CODEGRAPH_HOME_ENV} must be an absolute path; it is ${selected}.`,
        bundled,
      ),
    );
  const home = await realpath(selected).catch(() => undefined);
  if (home === undefined)
    return err(unavailable(operation, `${selected} does not exist.`, bundled));
  const cli = join(home, "dist", "bin", "codegraph.js");
  const library = join(home, "dist", "index.js");
  for (const entry of [cli, library])
    if (!(await isFile(entry)))
      return err(
        unavailable(
          operation,
          `${entry} is missing: ${home} isn't a built CodeGraph package.`,
          bundled,
        ),
      );
  let version: string | null = null;
  try {
    const manifest: unknown = JSON.parse(
      await readFile(join(home, "package.json"), "utf8"),
    );
    if (
      typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
    )
      version = manifest.version;
  } catch {
    // The version is reported when the manifest states it; unknown otherwise.
  }
  return ok({ home, cli, library, version });
};

/**
 * Environment for every CodeGraph process REA starts: telemetry off, no
 * shared background daemon (REA owns the one process it starts), and no
 * file watcher (index_source_graph updates the index on request).
 */
export const codeGraphEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv => ({
  ...environment,
  DO_NOT_TRACK: "1",
  CODEGRAPH_TELEMETRY: "0",
  CODEGRAPH_NO_DAEMON: "1",
  CODEGRAPH_NO_WATCH: "1",
  // Query servers only read (rene's CodeGraph): no writer lock and no
  // catch-up sync, so the bridge and every agent can query one project at
  // once. The index changes only through index_source_graph.
  CODEGRAPH_READ_ONLY: "1",
});
