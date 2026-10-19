import type { Dirent } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import {
  classifyArtifactBytes,
  classifyArtifactContent,
  classifyArtifactPath,
} from "../inventory/ArtifactGraphConstruction.js";
import {
  contentTypeOf,
  isElfCore,
  nameTypeOf,
  TOOLS_FOR_TYPE,
  zipTypeOf,
  type ProjectSurvey,
  type SurveyProjectDirectoryInput,
} from "../../domain/projectSurvey.js";

const PREFIX_BYTES = 4096;
const STRUCTURE_DEPTH = 2;
const EXAMPLES = 3;
const TOOL_EXAMPLES = 2;
const TOP_TYPES = 5;
const MAX_UNREADABLE = 50;
const CONCURRENCY = 32;

interface FileType {
  readonly type: string;
  readonly detection: "content" | "name";
}

/** Reads up to PREFIX_BYTES from the start of a file. */
const readPrefix = async (path: string): Promise<Buffer> => {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};

/**
 * One file's type. Content decides first, through the artifact classifier
 * that owns executable and container formats, then the survey's signatures;
 * the name decides only what content can't.
 */
export const classifyProjectFile = (
  relativePath: string,
  prefix: Buffer,
  size: number,
): FileType => {
  const bytes = classifyArtifactBytes(prefix, size);
  if (bytes !== "file" && bytes !== "unknown") {
    const { format } = classifyArtifactContent(relativePath, prefix, size);
    if (format === "elf" && isElfCore(prefix))
      return { type: "elf-core", detection: "content" };
    if (format === "zip")
      return { type: zipTypeOf(relativePath) ?? "zip", detection: "content" };
    return { type: format, detection: "content" };
  }
  const signature = contentTypeOf(prefix);
  if (signature !== undefined) return { type: signature, detection: "content" };
  if (bytes === "unknown") return { type: "unknown", detection: "content" };
  const byPath = classifyArtifactPath(relativePath);
  // The artifact classifier calls every JS/TS path a bundle, which holds in
  // a shipped app; in a source tree TypeScript is source and plain .js is
  // just JavaScript, bundled or not.
  if (byPath.format === "javascript-bundle")
    return {
      type:
        nameTypeOf(relativePath) === "typescript-source"
          ? "typescript-source"
          : "javascript",
      detection: "name",
    };
  if (byPath.format !== "file")
    return { type: byPath.format, detection: "name" };
  const named = nameTypeOf(relativePath);
  if (named !== undefined) return { type: named, detection: "name" };
  if (prefix.length === 0) return { type: "empty", detection: "content" };
  return {
    type: prefix.includes(0) ? "binary" : "text",
    detection: "content",
  };
};

/** Walks one project directory and summarizes its structure, types and tools. */
export const surveyProjectDirectory = async (
  input: SurveyProjectDirectoryInput,
  signal?: AbortSignal,
): Promise<ProjectSurvey> => {
  const root = await realpath(input.path);
  const exclude = new Set(input.exclude_names);
  const coverage = {
    entries_examined: 0,
    directories: 0,
    files: 0,
    symlinks: 0,
    other_entries: 0,
    bytes: 0,
    entry_limit_reached: false,
    depth_limit_folders: [] as string[],
    excluded_folders: [] as string[],
    unreadable: [] as { path: string; reason: string }[],
    unreadable_truncated: false,
  };
  const types = new Map<
    string,
    {
      detection: FileType["detection"];
      files: number;
      bytes: number;
      examples: string[];
    }
  >();
  const folders = new Map<
    string,
    { depth: number; files: number; bytes: number; types: Map<string, number> }
  >();
  const unreadable = (path: string, cause: unknown) => {
    if (coverage.unreadable.length >= MAX_UNREADABLE) {
      coverage.unreadable_truncated = true;
      return;
    }
    coverage.unreadable.push({
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    });
  };
  const folderKey = (relativeFile: string) => {
    const parts = relativeFile.split(sep).slice(0, -1);
    return parts;
  };
  const count = (relativeFile: string, size: number, type: FileType) => {
    const known = types.get(type.type) ?? {
      detection: type.detection,
      files: 0,
      bytes: 0,
      examples: [],
    };
    known.files += 1;
    known.bytes += size;
    if (known.examples.length < EXAMPLES) known.examples.push(relativeFile);
    types.set(type.type, known);
    // Each file counts towards its folder and the folders above it, to depth 2.
    const parts = folderKey(relativeFile);
    for (
      let depth = 0;
      depth <= Math.min(STRUCTURE_DEPTH, parts.length);
      depth++
    ) {
      const path = depth === 0 ? "." : parts.slice(0, depth).join("/");
      const folder = folders.get(path) ?? {
        depth,
        files: 0,
        bytes: 0,
        types: new Map<string, number>(),
      };
      folder.files += 1;
      folder.bytes += size;
      folder.types.set(type.type, (folder.types.get(type.type) ?? 0) + 1);
      folders.set(path, folder);
    }
  };

  // Breadth-first, in name order, so the same tree gives the same survey.
  const queue: { path: string; depth: number }[] = [{ path: root, depth: 0 }];
  while (queue.length > 0 && !coverage.entry_limit_reached) {
    if (signal?.aborted === true) throw signal.reason ?? new Error("cancelled");
    const { path: directory, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (cause: unknown) {
      unreadable(relative(root, directory) || ".", cause);
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const files: { absolute: string; relativePath: string }[] = [];
    for (const entry of entries) {
      if (coverage.entries_examined >= input.max_entries) {
        coverage.entry_limit_reached = true;
        break;
      }
      coverage.entries_examined += 1;
      const absolute = join(directory, entry.name);
      const relativePath = relative(root, absolute);
      if (entry.isSymbolicLink()) coverage.symlinks += 1;
      else if (entry.isDirectory()) {
        coverage.directories += 1;
        if (exclude.has(entry.name))
          coverage.excluded_folders.push(relativePath);
        else if (depth >= input.max_depth)
          coverage.depth_limit_folders.push(relativePath);
        else queue.push({ path: absolute, depth: depth + 1 });
      } else if (entry.isFile()) files.push({ absolute, relativePath });
      else coverage.other_entries += 1;
    }
    for (let start = 0; start < files.length; start += CONCURRENCY) {
      const batch = files.slice(start, start + CONCURRENCY);
      const classified = await Promise.all(
        batch.map(async ({ absolute, relativePath }) => {
          try {
            const { size } = await lstat(absolute);
            const prefix = await readPrefix(absolute);
            return {
              relativePath,
              size,
              type: classifyProjectFile(relativePath, prefix, size),
            };
          } catch (cause: unknown) {
            unreadable(relativePath, cause);
            return undefined;
          }
        }),
      );
      for (const file of classified) {
        if (file === undefined) continue;
        coverage.files += 1;
        coverage.bytes += file.size;
        count(file.relativePath.split(sep).join("/"), file.size, file.type);
      }
    }
  }

  const fileTypes = [...types.entries()]
    .map(([type, value]) => ({ type, ...value }))
    .sort((a, b) => b.files - a.files || (a.type < b.type ? -1 : 1));
  const tools = new Map<
    string,
    { access: "path" | "open_binary"; file_types: string[]; examples: string[] }
  >();
  for (const fileType of fileTypes)
    for (const [tool, access] of TOOLS_FOR_TYPE[fileType.type] ?? []) {
      const known = tools.get(tool) ?? { access, file_types: [], examples: [] };
      known.file_types.push(fileType.type);
      for (const example of fileType.examples)
        if (known.examples.length < TOOL_EXAMPLES) known.examples.push(example);
      tools.set(tool, known);
    }
  const complete =
    !coverage.entry_limit_reached &&
    coverage.depth_limit_folders.length === 0 &&
    coverage.excluded_folders.length === 0 &&
    coverage.unreadable.length === 0;
  return {
    root,
    coverage: { ...coverage, complete },
    structure: [...folders.entries()]
      .map(([path, folder]) => ({
        path,
        depth: folder.depth,
        files: folder.files,
        bytes: folder.bytes,
        top_types: [...folder.types.entries()]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
          .slice(0, TOP_TYPES)
          .map(([type, files]) => ({ type, files })),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    file_types: fileTypes,
    applicable_tools: [...tools.entries()]
      .map(([tool, value]) => ({ tool, ...value }))
      .sort((a, b) => (a.tool < b.tool ? -1 : 1)),
    limitations: [
      'File types with detection "name" were decided by file name because their content has no signature REA checks; they are not verified against content.',
      "Applicable tools are the REA tools that accept these file types. A tool can still reject a file it can't parse, and whether its provider is installed is reported by binary_session and rea doctor, not here.",
      "Symbolic links are counted but not followed.",
      ...(complete
        ? []
        : [
            "Coverage is partial: see coverage for excluded folders, folders past max_depth, unreadable entries and the entry limit. Types in folders that weren't walked are unknown, not absent.",
          ]),
    ],
  };
};
