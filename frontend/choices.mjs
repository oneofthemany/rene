// What the user has chosen to use.
//
// Each choice is a provider or tool the workbench can set up. A choice that
// is off isn't offered for install and its rea doctor checks don't count as
// "to fix"; nothing is uninstalled. The choices and the default analysis
// engine (REA_ANALYSIS_PROVIDER) are saved in the workbench settings file.

export const CHOICES = [
  {
    id: "ghidra",
    group: "Analysis engines",
    label: "Ghidra",
    purpose: "Free decompiler for native programs. Needs Java.",
    engine: true,
    releases: ["ghidra"],
  },
  {
    id: "hopper",
    group: "Analysis engines",
    label: "Hopper (demo)",
    purpose: "Commercial disassembler; the demo is in the REA container.",
    engine: true,
  },
  {
    id: "kuna",
    group: "Analysis engines",
    label: "Kuna",
    purpose: "A second free decompiler, for cross-checking.",
    engine: true,
    releases: ["kuna"],
  },
  {
    id: "ida",
    group: "Analysis engines",
    label: "IDA",
    purpose:
      "Commercial; needs your own IDA licence and an IDA MCP server set up by hand.",
    engine: true,
    off: true,
  },
  {
    id: "jadx",
    group: "Android",
    label: "JADX",
    purpose: "Android apps: classes and decompiled methods. Needs Java.",
    releases: ["jadx"],
  },
  {
    id: "apktool",
    group: "Android",
    label: "Apktool",
    purpose: "Android resources: manifests, strings and tables. Needs Java.",
    releases: ["apktool"],
  },
  {
    id: "wabt",
    group: "Other targets",
    label: "WABT",
    purpose: "WebAssembly modules.",
    releases: ["wabt"],
  },
  {
    id: "pwntools",
    group: "Other targets",
    label: "pwntools",
    purpose: "ELF layout and recorded Linux crashes.",
    releases: ["pwntools"],
  },
  {
    id: "unblob",
    group: "Other targets",
    label: "Unblob",
    purpose: "Firmware extraction (binwalk in the container scans).",
    releases: ["unblob"],
  },
  {
    id: "mitmproxy",
    group: "Other targets",
    label: "mitmproxy",
    purpose: "Saved mitmproxy network captures.",
    releases: ["mitmproxy"],
  },
  {
    id: "duckdb",
    group: "Other targets",
    label: "DuckDB",
    purpose: "DuckDB databases; offers each new DuckDB 1.x release.",
    releases: ["duckdb"],
  },
  {
    id: "wakaru",
    group: "Other targets",
    label: "Wakaru",
    purpose: "Bundled JavaScript: recovered modules and sources (Linux x64).",
    releases: ["wakaru"],
  },
];

const BY_ID = new Map(CHOICES.map((choice) => [choice.id, choice]));

/** Engines REA_ANALYSIS_PROVIDER may name; "auto" lets REA pick. */
export const ENGINES = [
  "auto",
  ...CHOICES.filter((c) => c.engine).map((c) => c.id),
];

/** Saved choices over the defaults, keyed by choice id. */
export const effectiveUse = (saved = {}) =>
  Object.fromEntries(
    CHOICES.map((choice) => [
      choice.id,
      typeof saved[choice.id] === "boolean" ? saved[choice.id] : !choice.off,
    ]),
  );

/** Keeps only known ids with boolean values. */
export const cleanUse = (value) =>
  Object.fromEntries(
    Object.entries(value ?? {}).filter(
      ([id, used]) => BY_ID.has(id) && typeof used === "boolean",
    ),
  );

/**
 * Whether an installable release is wanted: its own choice is on, or (for
 * Java, which has no choice) a chosen release needs it.
 */
export function releaseWanted(release, releases, use) {
  const owner = CHOICES.find((choice) => choice.releases?.includes(release.id));
  if (owner) return use[owner.id];
  return releases.some(
    (other) =>
      other.needs === release.id && releaseWanted(other, releases, use),
  );
}

/** The choice a rea doctor check belongs to (by name or "<id>-" prefix). */
export const checkOwner = (checkName) =>
  CHOICES.find(
    (choice) =>
      checkName === choice.id || checkName.startsWith(`${choice.id}-`),
  );
