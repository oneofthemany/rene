import { readFileSync } from "node:fs";

/**
 * Provider paths the workbench saves on its Providers page, in one JSON file
 * (`{ environment, use }`, frontend/settings.mjs writes it). REA reads
 * provider locations from its environment, so these are environment
 * variables. This module owns which variables the file may set and how its
 * environment is read; the workbench adds the values to the environment it
 * gives REA and its agents, and `rene` applies them to a call run by hand.
 *
 * The file is data, never shell: nothing evaluates it. Only these names with
 * string values are applied; anything else in it is left in place but
 * ignored.
 */
export const PROVIDER_SETTING_NAMES = [
  "GHIDRA_INSTALL_DIR",
  "JAVA_HOME",
  "HOPPER_LAUNCHER_PATH",
  "REA_IDA_MCP_CONFIG",
  "REA_JADX_MCP_JAR",
  "REA_KUNA_COMMAND",
  "REA_APKTOOL_COMMAND",
  "REA_WABT_BIN_DIRECTORY",
  "REA_PWNTOOLS_PYTHON",
  "REA_UNBLOB_COMMAND",
  "REA_MITMDUMP_COMMAND",
  "REA_DUCKDB_COMMAND",
  "REA_RIZIN_COMMAND",
  "REA_WAKARU_COMMAND",
  "REA_ANALYSIS_PROVIDER",
] as const;

const KNOWN = new Set<string>(PROVIDER_SETTING_NAMES);

/** What one read of the file found. A missing file is no settings, not a failure. */
export type SavedSettingsRead =
  | {
      readonly ok: true;
      readonly environment: Readonly<Record<string, string>>;
      /** The file's `use` member as written; the workbench parses it. */
      readonly use: unknown;
    }
  | { readonly ok: false; readonly reason: string };

/** The saved settings in `text`, the file's content. */
export const parseSavedSettings = (text: string): SavedSettingsRead => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: unknown) {
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const document =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { environment?: unknown; use?: unknown })
      : {};
  const environment =
    typeof document.environment === "object" && document.environment !== null
      ? Object.fromEntries(
          Object.entries(document.environment).filter(
            (entry): entry is [string, string] =>
              KNOWN.has(entry[0]) && typeof entry[1] === "string",
          ),
        )
      : {};
  return { ok: true, environment, use: document.use };
};

/** Reads the settings file at `path`; one that doesn't exist holds nothing. */
export const readSavedSettings = (path: string): SavedSettingsRead => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause: unknown) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, environment: {}, use: undefined };
    return {
      ok: false,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return parseSavedSettings(text);
};

/**
 * `env` with each saved value its caller doesn't set. The caller's own
 * value wins, so a variable set for one command still applies; a workbench
 * session's environment already carries the saved values.
 */
export const withSavedProviderSettings = (
  env: NodeJS.ProcessEnv,
  saved: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv => {
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const [name, value] of Object.entries(saved))
    if (merged[name] === undefined || merged[name] === "") merged[name] = value;
  return merged;
};
