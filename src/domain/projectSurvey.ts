import { z } from "zod";

import { localPathStringSchema } from "./localPath.js";

/**
 * A project-directory survey: the folder's structure, the file types in use,
 * and which REA tools accept those types. File types come from content
 * (magic bytes) wherever the format has a signature; names decide only when
 * content can't, and each type says which way it was decided.
 */

export const surveyProjectDirectoryInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to the project directory.",
  ),
  max_entries: z
    .number()
    .int()
    .min(1)
    .max(1_000_000)
    .default(100_000)
    .describe(
      "Directory entries examined before the walk stops; coverage reports when it does.",
    ),
  max_depth: z
    .number()
    .int()
    .min(0)
    .max(64)
    .default(24)
    .describe("Folder depth below the root that is still descended into."),
  exclude_names: z
    .array(z.string().min(1))
    .default([".git", "node_modules"])
    .describe(
      "Folder names not descended into; each excluded folder is listed in coverage.",
    ),
});

export type SurveyProjectDirectoryInput = z.infer<
  typeof surveyProjectDirectoryInputSchema
>;

const typeCountSchema = z.strictObject({
  type: z.string(),
  files: z.number().int().nonnegative(),
});

export const projectSurveySchema = z.strictObject({
  root: z.string(),
  coverage: z.strictObject({
    entries_examined: z.number().int().nonnegative(),
    directories: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    symlinks: z.number().int().nonnegative(),
    other_entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    complete: z.boolean(),
    entry_limit_reached: z.boolean(),
    depth_limit_folders: z.array(z.string()),
    excluded_folders: z.array(z.string()),
    unreadable: z.array(
      z.strictObject({ path: z.string(), reason: z.string() }),
    ),
    unreadable_truncated: z.boolean(),
  }),
  structure: z.array(
    z.strictObject({
      path: z.string(),
      depth: z.number().int().nonnegative(),
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      top_types: z.array(typeCountSchema),
    }),
  ),
  file_types: z.array(
    z.strictObject({
      type: z.string(),
      detection: z.enum(["content", "name"]),
      files: z.number().int().nonnegative(),
      bytes: z.number().int().nonnegative(),
      examples: z.array(z.string()),
    }),
  ),
  applicable_tools: z.array(
    z.strictObject({
      tool: z.string(),
      access: z.enum(["path", "open_binary"]),
      file_types: z.array(z.string()),
      examples: z.array(z.string()),
    }),
  ),
  limitations: z.array(z.string()),
});

export type ProjectSurvey = z.infer<typeof projectSurveySchema>;

/** Signatures for formats REA tools consume that the artifact classifier leaves generic. */
export const contentTypeOf = (prefix: Buffer): string | undefined => {
  const starts = (bytes: readonly number[], offset = 0) =>
    prefix.length >= offset + bytes.length &&
    bytes.every((byte, index) => prefix[offset + index] === byte);
  const ascii = (text: string, offset = 0) =>
    starts([...Buffer.from(text, "latin1")], offset);
  if (starts([0x00, 0x61, 0x73, 0x6d])) return "wasm";
  if (ascii("SQLite format 3\u0000")) return "sqlite";
  if (ascii("DUCK", 8)) return "duckdb";
  if (
    starts([0xd4, 0xc3, 0xb2, 0xa1]) ||
    starts([0xa1, 0xb2, 0xc3, 0xd4]) ||
    starts([0x4d, 0x3c, 0xb2, 0xa1]) ||
    starts([0xa1, 0xb2, 0x3c, 0x4d])
  )
    return "pcap";
  if (starts([0x0a, 0x0d, 0x0d, 0x0a])) return "pcapng";
  if (ascii("dex\n")) return "dex";
  if (starts([0xca, 0xfe, 0xba, 0xbe])) return "java-class";
  if (ascii("hsqs") || ascii("sqsh")) return "squashfs";
  if (ascii("BOMStore")) return "apple-asset-catalog";
  if (starts([0x03, 0x00, 0x08, 0x00])) return "android-binary-xml";
  if (starts([0x1f, 0x8b])) return "gzip";
  if (starts([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "xz";
  if (starts([0x28, 0xb5, 0x2f, 0xfd])) return "zstd";
  if (ascii("BZh")) return "bzip2";
  if (starts([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "7z";
  if (ascii("ustar", 257)) return "tar";
  if (ascii("%PDF-")) return "pdf";
  if (starts([0x89, 0x50, 0x4e, 0x47])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii("GIF8")) return "gif";
  return undefined;
};

/** An ELF's e_type says whether it is a core dump (ET_CORE). */
export const isElfCore = (prefix: Buffer): boolean => {
  if (prefix.length < 18) return false;
  const littleEndian = prefix[5] === 1;
  const type = littleEndian ? prefix.readUInt16LE(16) : prefix.readUInt16BE(16);
  return type === 4;
};

/** Types decided by name, for text formats and containers with no signature of their own. */
const NAME_TYPES: readonly (readonly [RegExp, string])[] = [
  [/\.py$/u, "python-source"],
  [/\.(?:ts|tsx|mts|cts)$/u, "typescript-source"],
  [/\.(?:java)$/u, "java-source"],
  [/\.(?:kt|kts)$/u, "kotlin-source"],
  [/\.(?:c|h)$/u, "c-source"],
  [/\.(?:cc|cpp|cxx|hpp|hh)$/u, "cpp-source"],
  [/\.rs$/u, "rust-source"],
  [/\.go$/u, "go-source"],
  [/\.swift$/u, "swift-source"],
  [/\.cs$/u, "csharp-source"],
  [/\.(?:m|mm)$/u, "objective-c-source"],
  [/\.sol$/u, "solidity-source"],
  [/\.smali$/u, "smali"],
  [/\.(?:sh|bash|zsh)$/u, "shell-script"],
  [/\.har$/u, "har"],
  [/\.(?:qlog|sqlog)$/u, "qlog"],
  [/\.(?:xib|storyboard)$/u, "interface-builder-source"],
  [/\.json$/u, "json"],
  [/\.(?:yml|yaml)$/u, "yaml"],
  [/\.toml$/u, "toml"],
  [/\.(?:md|markdown)$/u, "markdown"],
  [/\.(?:html|htm)$/u, "html"],
  [/\.css$/u, "css"],
  [/\.xml$/u, "xml"],
  [/\.(?:bin|img|fw|rom)$/u, "firmware-image"],
];

export const nameTypeOf = (path: string): string | undefined => {
  const lower = path.toLowerCase();
  return NAME_TYPES.find(([pattern]) => pattern.test(lower))?.[1];
};

/** ZIP-based formats REA knows by name: the content says ZIP, the name says which. */
export const zipTypeOf = (path: string): string | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jar")) return "jar";
  if (lower.endsWith(".aab")) return "android-app-bundle";
  if (lower.endsWith(".sr")) return "sigrok-session";
  return undefined;
};

/** Source trees CodeGraph parses: index the project root, then explore it. */
const SOURCE_GRAPH = [
  ["index_source_graph", "path"],
  ["explore_source_graph", "path"],
] as const;

/**
 * REA tools that accept each file type. "path" tools take the file (or, for
 * source trees, the project root) directly; "open_binary" means the type is
 * opened as the session target first, after which the session tools apply.
 * Every name here is checked against the tool catalog by a test.
 */
export const TOOLS_FOR_TYPE: Readonly<
  Record<string, readonly (readonly [string, "path" | "open_binary"])[]>
> = {
  elf: [
    ["open_binary", "open_binary"],
    ["inspect_binary_layout", "path"],
    ["inspect_with_objdump", "path"],
    ["inspect_go_binary", "path"],
    ["inspect_rust_binary", "path"],
    ["execute_rizin_command", "path"],
  ],
  "elf-core": [["inspect_recorded_crash", "path"]],
  pe: [
    ["open_binary", "open_binary"],
    ["inspect_binary_layout", "path"],
    ["inspect_pe_resources", "path"],
    ["inspect_with_objdump", "path"],
    ["inspect_go_binary", "path"],
    ["inspect_rust_binary", "path"],
  ],
  "dos-mz": [["open_binary", "open_binary"]],
  "mach-o": [
    ["open_binary", "open_binary"],
    ["inspect_binary_layout", "path"],
    ["inspect_go_binary", "path"],
    ["inspect_rust_binary", "path"],
  ],
  "mach-o-universal": [
    ["open_binary", "open_binary"],
    ["inspect_binary_layout", "path"],
  ],
  zip: [["open_binary", "open_binary"]],
  jar: [["open_binary", "open_binary"]],
  apk: [
    ["inspect_android_package", "path"],
    ["search_android_classes", "path"],
    ["decode_android_resources", "path"],
    ["identify_flutter_build", "path"],
    ["open_binary", "open_binary"],
  ],
  ipa: [["open_binary", "open_binary"]],
  msix: [["open_binary", "open_binary"]],
  appx: [["open_binary", "open_binary"]],
  hap: [["open_binary", "open_binary"]],
  hsp: [["open_binary", "open_binary"]],
  asar: [
    ["analyze_javascript_application", "path"],
    ["open_binary", "open_binary"],
  ],
  "javascript-bundle": [
    ["analyze_javascript_application", "path"],
    ["recover_javascript_sources", "path"],
    ["open_binary", "open_binary"],
  ],
  javascript: [
    ...SOURCE_GRAPH,
    ["analyze_javascript_application", "path"],
    ["recover_javascript_sources", "path"],
    ["open_binary", "open_binary"],
  ],
  "source-map": [["open_binary", "open_binary"]],
  plist: [["inspect_plist", "path"]],
  wasm: [["inspect_wasm_artifact", "path"]],
  sqlite: [["inspect_sqlite_database", "path"]],
  duckdb: [["inspect_duckdb_database", "path"]],
  pcap: [
    ["inspect_pcap_capture", "path"],
    ["inspect_packet_capture", "path"],
  ],
  pcapng: [
    ["inspect_pcap_capture", "path"],
    ["inspect_packet_capture", "path"],
  ],
  har: [["inspect_web_network_capture", "path"]],
  "python-source": [
    ...SOURCE_GRAPH,
    ["inspect_python_blocking_calls", "path"],
    ["inspect_python_docs_drift", "path"],
  ],
  "typescript-source": SOURCE_GRAPH,
  "java-source": SOURCE_GRAPH,
  "kotlin-source": SOURCE_GRAPH,
  "c-source": SOURCE_GRAPH,
  "cpp-source": SOURCE_GRAPH,
  "rust-source": SOURCE_GRAPH,
  "go-source": SOURCE_GRAPH,
  "swift-source": SOURCE_GRAPH,
  "csharp-source": SOURCE_GRAPH,
  "objective-c-source": SOURCE_GRAPH,
  "solidity-source": SOURCE_GRAPH,
  "sigrok-session": [["decode_signal_recording", "path"]],
  squashfs: [
    ["inspect_firmware_regions", "path"],
    ["extract_firmware", "path"],
  ],
  "firmware-image": [
    ["inspect_firmware_regions", "path"],
    ["extract_firmware", "path"],
  ],
};
