// Provider paths saved by the workbench.
//
// REA reads provider locations from its environment. The workbench keeps
// the paths chosen on its Providers page in one JSON file and adds them to
// the environment it gives REA (the MCP child, `rea doctor` and `rea setup`).
// The file is data, never shell: nothing evaluates it. A saved path takes
// precedence over the same variable in the shell the bridge started from,
// and clearing it falls back to that shell value. Each save keeps the
// previous file as <file>.bak.

import { existsSync } from "node:fs";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { cleanUse, effectiveUse, ENGINES } from "./choices.mjs";

/**
 * Variables the page may set. `inspection` names the rea doctor provider
 * inspection whose `available` verdict covers the setting; Hopper has no
 * inspection, so `check` names its doctor check instead. Tools without
 * either have no readiness badge.
 */
export const PROVIDER_SETTINGS = [
  {
    name: "GHIDRA_INSTALL_DIR",
    label: "Ghidra",
    kind: "dir",
    inspection: "ghidra",
  },
  {
    name: "JAVA_HOME",
    label: "Java for Ghidra",
    kind: "dir",
    inspection: "ghidra",
  },
  {
    name: "HOPPER_LAUNCHER_PATH",
    label: "Hopper launcher",
    kind: "file",
    check: "hopper",
  },
  {
    name: "REA_IDA_MCP_CONFIG",
    label: "IDA MCP registration",
    kind: "file",
    inspection: "ida",
  },
  {
    name: "REA_JADX_MCP_JAR",
    label: "jadx-headless-mcp JAR",
    kind: "file",
    inspection: "jadx",
  },
  {
    name: "REA_KUNA_COMMAND",
    label: "Kuna executable",
    kind: "file",
    inspection: "kuna",
  },
  // Tools for other targets. rea doctor doesn't check these; REA reports
  // them per session (binary_session's tool_availability).
  { name: "REA_APKTOOL_COMMAND", label: "Apktool launcher", kind: "file" },
  { name: "REA_WABT_BIN_DIRECTORY", label: "WABT bin folder", kind: "dir" },
  { name: "REA_PWNTOOLS_PYTHON", label: "pwntools Python", kind: "file" },
  { name: "REA_UNBLOB_COMMAND", label: "Unblob launcher", kind: "file" },
  { name: "REA_MITMDUMP_COMMAND", label: "mitmdump", kind: "file" },
  { name: "REA_DUCKDB_COMMAND", label: "DuckDB CLI", kind: "file" },
  { name: "REA_RIZIN_COMMAND", label: "rizin", kind: "file" },
  { name: "REA_WAKARU_COMMAND", label: "Wakaru", kind: "file" },
  // The default analysis engine, chosen with the "What you use" switches.
  {
    name: "REA_ANALYSIS_PROVIDER",
    label: "Default analysis engine",
    kind: "choice",
    values: ENGINES,
  },
];
const BY_NAME = new Map(PROVIDER_SETTINGS.map((entry) => [entry.name, entry]));

export class SettingsError extends Error {}

/** Checks one requested value; "" clears the saved value. */
async function validate(name, value) {
  const setting = BY_NAME.get(name);
  if (!setting) throw new SettingsError(`${name} is not a provider setting.`);
  if (typeof value !== "string" || value.includes("\0"))
    throw new SettingsError(`${name} must be a string.`);
  if (value === "") return;
  if (setting.kind === "choice") {
    if (!setting.values.includes(value))
      throw new SettingsError(
        `${setting.label}: choose one of ${setting.values.join(", ")}.`,
      );
    return;
  }
  if (!isAbsolute(value))
    throw new SettingsError(`${setting.label}: use an absolute path.`);
  let info;
  try {
    info = await stat(value);
  } catch {
    throw new SettingsError(`${setting.label}: ${value} does not exist.`);
  }
  if (setting.kind === "dir" && !info.isDirectory())
    throw new SettingsError(`${setting.label}: choose a folder.`);
  if (setting.kind === "file" && !info.isFile())
    throw new SettingsError(`${setting.label}: choose a file.`);
}

export function createSettings(path) {
  let saved = {};
  let use = {};
  let loadError;

  /** Reads the file. A file that can't be read applies nothing and is reported. */
  async function load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (cause) {
      if (cause.code !== "ENOENT")
        loadError = `${path} could not be read (${cause.message}). Saving replaces it and keeps it as ${path}.bak.`;
      return;
    }
    // Only known variables with string values are applied; anything else in
    // the file is left in place but ignored.
    saved = Object.fromEntries(
      Object.entries(parsed?.environment ?? {}).filter(
        ([name, value]) => BY_NAME.has(name) && typeof value === "string",
      ),
    );
    use = cleanUse(parsed?.use);
  }

  /** Writes environment and choices together, keeping the previous file. */
  async function persist(environment, choices) {
    if (existsSync(path)) await copyFile(path, `${path}.bak`);
    await writeFile(
      `${path}.tmp`,
      `${JSON.stringify({ environment, use: choices }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(`${path}.tmp`, path);
    saved = environment;
    use = choices;
    loadError = undefined;
  }

  return {
    load,

    /** The environment REA runs with: the bridge's own plus saved paths. */
    environment(base) {
      const merged = Object.fromEntries(
        Object.entries(base).filter(([, value]) => value !== undefined),
      );
      return { ...merged, ...saved };
    },

    /** Each setting with its saved, shell and effective values. */
    describe(base) {
      return {
        path,
        loadError,
        settings: PROVIDER_SETTINGS.map((setting) => ({
          ...setting,
          saved: saved[setting.name] ?? "",
          shell: base[setting.name] ?? "",
          effective: saved[setting.name] ?? base[setting.name] ?? "",
        })),
      };
    },

    /** Validates every change, then writes them together. Returns true if anything changed. */
    async save(changes) {
      if (
        typeof changes !== "object" ||
        changes === null ||
        Array.isArray(changes)
      )
        throw new SettingsError("Expected { values: Record<string, string> }.");
      for (const [name, value] of Object.entries(changes))
        await validate(name, value);
      const next = { ...saved };
      for (const [name, value] of Object.entries(changes)) {
        if (value === "") delete next[name];
        else next[name] = value;
      }
      if (JSON.stringify(next) === JSON.stringify(saved)) return false;
      await persist(next, use);
      return true;
    },

    /** Which choices are on, saved over the defaults. */
    use: () => effectiveUse(use),

    /** Saves the switches; returns true if anything changed. */
    async saveUse(changes) {
      const next = { ...use, ...cleanUse(changes) };
      if (
        JSON.stringify(effectiveUse(next)) === JSON.stringify(effectiveUse(use))
      )
        return false;
      await persist(saved, next);
      return true;
    },
  };
}
