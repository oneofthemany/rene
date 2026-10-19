import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";

/** Environment key naming the CodeGraph package folder REA runs. */
export const CODEGRAPH_HOME_ENV = "REA_CODEGRAPH_HOME";

const REMEDIATION = `Build CodeGraph (npm ci && npm run build in its folder) and set ${CODEGRAPH_HOME_ENV} to that folder's absolute path; REA does not install it.`;

/** The CodeGraph install REA runs: its entry points and reported version. */
export interface CodeGraphInstall {
  readonly home: string;
  /** dist/bin/codegraph.js: the CLI, whose `serve --mcp` is the query server. */
  readonly cli: string;
  /** dist/index.js: the library the index worker loads. */
  readonly library: string;
  readonly version: string | null;
}

const unavailable = (operation: string, reason: string) =>
  new AnalysisCapabilityUnavailableError("codegraph", operation, reason, {
    userMessage: `${reason} ${REMEDIATION}`,
  });

const isFile = async (path: string) =>
  (await stat(path).catch(() => undefined))?.isFile() === true;

/** Resolves and checks the install named by REA_CODEGRAPH_HOME. */
export const resolveCodeGraphInstall = async (
  environment: Readonly<Record<string, string | undefined>>,
  operation: string,
): Promise<Result<CodeGraphInstall, AnalysisCapabilityUnavailableError>> => {
  const selected = environment[CODEGRAPH_HOME_ENV];
  if (selected === undefined || selected === "")
    return err(unavailable(operation, `${CODEGRAPH_HOME_ENV} is not set.`));
  if (!isAbsolute(selected))
    return err(
      unavailable(
        operation,
        `${CODEGRAPH_HOME_ENV} must be an absolute path; it is ${selected}.`,
      ),
    );
  const home = await realpath(selected).catch(() => undefined);
  if (home === undefined)
    return err(unavailable(operation, `${selected} does not exist.`));
  const cli = join(home, "dist", "bin", "codegraph.js");
  const library = join(home, "dist", "index.js");
  for (const entry of [cli, library])
    if (!(await isFile(entry)))
      return err(
        unavailable(
          operation,
          `${entry} is missing: ${home} isn't a built CodeGraph package.`,
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
});
