import { createHash, randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  relative,
  resolve,
  sep,
} from "node:path";

import { isPathWithinRoot } from "../domain/localPath.js";
import {
  MAX_READ_BYTES,
  type EditFileInput,
  type FindFilesInput,
  type ReadFileInput,
  type SearchTextInput,
  type WriteFileInput,
} from "../domain/toolbox.js";

/** A path the toolbox may not touch, or input it can't act on. */
export class ToolboxRefusal extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
  }
}

const sha256 = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const MAX_UNREADABLE = 50;
const MAX_LINE_CHARS = 2000;

/**
 * The folders the toolbox may act in: REA_TOOLBOX_ROOTS (colon-separated
 * absolute paths) or the home folder, each resolved through symlinks.
 */
export const toolboxRoots = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string[]> => {
  const declared = environment.REA_TOOLBOX_ROOTS
    ? environment.REA_TOOLBOX_ROOTS.split(":").filter(Boolean)
    : [environment.HOME || homedir()];
  const roots = await Promise.all(
    declared
      .filter((root) => isAbsolute(root))
      .map((root) => realpath(root).catch(() => undefined)),
  );
  return roots.filter((root): root is string => root !== undefined);
};

/**
 * The real location of `path` once symlinks are resolved, refused unless it
 * is inside a toolbox root. A path that doesn't exist yet resolves through
 * its nearest existing ancestor, so a symlinked parent can't lead outside.
 */
export const confine = async (
  roots: readonly string[],
  path: string,
  field: string,
): Promise<string> => {
  if (!isAbsolute(path))
    throw new ToolboxRefusal(`${field} must be an absolute path.`, field);
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch {
      const parent = dirname(existing);
      if (parent === existing)
        throw new ToolboxRefusal(`${path} has no existing ancestor.`, field);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
  const real = join(existing, ...rest);
  if (!roots.some((root) => isPathWithinRoot(root, real)))
    throw new ToolboxRefusal(
      `${path} is outside the toolbox roots (${roots.join(", ")}). Set REA_TOOLBOX_ROOTS to allow other folders.`,
      field,
    );
  return real;
};

const isBinary = (bytes: Buffer) =>
  bytes.subarray(0, BINARY_PROBE_BYTES).includes(0);

export const readTextFile = async (
  roots: readonly string[],
  input: ReadFileInput,
) => {
  const path = await confine(roots, input.path, "path");
  const info = await stat(path);
  if (!info.isFile())
    throw new ToolboxRefusal(`${path} is not a file.`, "path");
  const handle = await open(path, "r");
  let head: Buffer;
  const hash = createHash("sha256");
  try {
    // The whole file is hashed; at most MAX_READ_BYTES of it is decoded.
    const chunk = Buffer.alloc(1024 * 1024);
    const kept: Buffer[] = [];
    let keptBytes = 0;
    for (let position = 0; ;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      if (keptBytes < MAX_READ_BYTES) {
        const take = slice.subarray(0, MAX_READ_BYTES - keptBytes);
        kept.push(Buffer.from(take));
        keptBytes += take.length;
      }
      position += bytesRead;
    }
    head = Buffer.concat(kept);
  } finally {
    await handle.close();
  }
  const digest = hash.digest("hex");
  if (isBinary(head))
    return {
      path,
      bytes: info.size,
      sha256: digest,
      binary: true,
      start_line: 0,
      end_line: 0,
      total_lines: 0,
      truncated: false,
      text: "",
    };
  const partial = head.length < info.size;
  const lines = head.toString("utf8").split("\n");
  // A file cut at MAX_READ_BYTES may end mid-line; that line isn't counted.
  if (partial) lines.pop();
  const start = Math.min(input.start_line, lines.length + 1);
  const selected = lines.slice(start - 1, start - 1 + input.max_lines);
  return {
    path,
    bytes: info.size,
    sha256: digest,
    binary: false,
    start_line: start,
    end_line: start + selected.length - 1,
    total_lines: lines.length,
    truncated: partial || start - 1 + selected.length < lines.length,
    text: selected.join("\n"),
  };
};

/** Writes through a temporary file in the same folder, then one rename. */
const writeAtomic = async (path: string, text: string, mode?: number) => {
  const temporary = join(
    dirname(path),
    `.${basename(path)}.rea-${randomBytes(4).toString("hex")}`,
  );
  try {
    await writeFile(temporary, text, {
      flag: "wx",
      ...(mode === undefined ? {} : { mode }),
    });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
};

export const writeTextFile = async (
  roots: readonly string[],
  input: WriteFileInput,
) => {
  const path = await confine(roots, input.path, "path");
  const existing = await lstat(path).catch(() => undefined);
  if (existing && !existing.isFile())
    throw new ToolboxRefusal(
      `${path} exists and is not a regular file.`,
      "path",
    );
  if (existing && !input.overwrite)
    throw new ToolboxRefusal(
      `${path} exists; set overwrite to replace it.`,
      "overwrite",
    );
  const parent = dirname(path);
  if (
    !(await stat(parent).then(
      (info) => info.isDirectory(),
      () => false,
    ))
  ) {
    if (!input.create_directories)
      throw new ToolboxRefusal(
        `${parent} doesn't exist; set create_directories to create it.`,
        "create_directories",
      );
    await mkdir(parent, { recursive: true });
  }
  const previous = existing ? sha256(await readFile(path)) : null;
  await writeAtomic(
    path,
    input.content,
    existing ? existing.mode & 0o7777 : undefined,
  );
  return {
    path,
    bytes: Buffer.byteLength(input.content),
    sha256: sha256(input.content),
    created: !existing,
    previous_sha256: previous,
  };
};

export const editTextFile = async (
  roots: readonly string[],
  input: EditFileInput,
) => {
  const path = await confine(roots, input.path, "path");
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile())
    throw new ToolboxRefusal(
      `${path} is not an existing regular file.`,
      "path",
    );
  const bytes = await readFile(path);
  if (isBinary(bytes))
    throw new ToolboxRefusal(
      `${path} is binary; edit_file changes text files.`,
      "path",
    );
  const text = bytes.toString("utf8");
  const occurrences = text.split(input.old_text).length - 1;
  if (occurrences === 0)
    throw new ToolboxRefusal(`old_text doesn't occur in ${path}.`, "old_text");
  if (occurrences > 1 && !input.replace_all)
    throw new ToolboxRefusal(
      `old_text occurs ${occurrences} times in ${path}; add surrounding text to make it unique, or set replace_all.`,
      "old_text",
    );
  const updated = text.split(input.old_text).join(input.new_text);
  await writeAtomic(path, updated, info.mode & 0o7777);
  return {
    path,
    replacements: occurrences,
    bytes: Buffer.byteLength(updated),
    sha256: sha256(updated),
    previous_sha256: sha256(bytes),
  };
};

interface WalkEntry {
  readonly relativePath: string;
  readonly absolute: string;
  readonly dirent: Dirent;
}

/**
 * Breadth-first walk in name order, never following symlinks; excluded
 * folder names are reported, not entered. `visit` returns false to stop.
 */
const walk = async (
  root: string,
  excludeNames: readonly string[],
  visit: (entry: WalkEntry) => Promise<boolean> | boolean,
) => {
  const excluded: string[] = [];
  const unreadable: string[] = [];
  const queue = [root];
  const skip = new Set(excludeNames);
  while (queue.length > 0) {
    const folder = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch {
      if (unreadable.length < MAX_UNREADABLE)
        unreadable.push(relative(root, folder) || ".");
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of entries) {
      const absolute = join(folder, dirent.name);
      const relativePath = relative(root, absolute).split(sep).join("/");
      if (dirent.isDirectory() && skip.has(dirent.name)) {
        excluded.push(relativePath);
        continue;
      }
      if (!(await visit({ relativePath, absolute, dirent })))
        return { excluded, unreadable, stopped: true };
      if (dirent.isDirectory()) queue.push(absolute);
    }
  }
  return { excluded, unreadable, stopped: false };
};

export const findFiles = async (
  roots: readonly string[],
  input: FindFilesInput,
) => {
  const root = await confine(roots, input.root, "root");
  if (!(await stat(root)).isDirectory())
    throw new ToolboxRefusal(`${root} is not a folder.`, "root");
  const matches: {
    path: string;
    kind: "file" | "directory" | "symlink";
    bytes: number;
    modified: string;
  }[] = [];
  let truncated = false;
  const { excluded, unreadable } = await walk(
    root,
    input.exclude_names,
    async ({ relativePath, absolute, dirent }) => {
      const kind = dirent.isSymbolicLink()
        ? "symlink"
        : dirent.isDirectory()
          ? "directory"
          : dirent.isFile()
            ? "file"
            : undefined;
      if (
        kind === undefined ||
        (kind === "directory" && !input.include_directories)
      )
        return true;
      if (!matchesGlob(relativePath, input.pattern)) return true;
      if (matches.length >= input.max_results) {
        truncated = true;
        return false;
      }
      const info = await lstat(absolute).catch(() => undefined);
      matches.push({
        path: relativePath,
        kind,
        bytes: info?.size ?? 0,
        modified: info ? info.mtime.toISOString() : "",
      });
      return true;
    },
  );
  return {
    root,
    pattern: input.pattern,
    matches,
    truncated,
    excluded_folders: excluded,
    unreadable,
  };
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clipLine = (line: string) =>
  line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;

export const searchText = async (
  roots: readonly string[],
  input: SearchTextInput,
) => {
  const target = await confine(roots, input.root, "root");
  let expression: RegExp;
  try {
    expression = new RegExp(
      input.regex ? input.query : escapeRegExp(input.query),
      input.case_sensitive ? "" : "i",
    );
  } catch (cause) {
    throw new ToolboxRefusal(
      `query isn't a valid regular expression: ${(cause as Error).message}`,
      "query",
    );
  }
  const result = {
    root: target,
    query: input.query,
    matches: [] as {
      path: string;
      line: number;
      column: number;
      text: string;
      before: { line: number; text: string }[];
      after: { line: number; text: string }[];
    }[],
    files_searched: 0,
    files_with_matches: 0,
    truncated: false,
    skipped_binary: 0,
    skipped_large: 0,
    excluded_folders: [] as string[],
    unreadable: [] as string[],
  };
  const searchFile = async (absolute: string, shown: string) => {
    const info = await stat(absolute);
    if (info.size > SEARCH_MAX_FILE_BYTES) {
      result.skipped_large += 1;
      return true;
    }
    const bytes = await readFile(absolute);
    if (isBinary(bytes)) {
      result.skipped_binary += 1;
      return true;
    }
    result.files_searched += 1;
    const lines = bytes.toString("utf8").split("\n");
    let found = false;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? "";
      const match = expression.exec(line);
      if (!match) continue;
      if (result.matches.length >= input.max_matches) {
        result.truncated = true;
        return false;
      }
      found = true;
      const context = (from: number, to: number) =>
        lines.slice(Math.max(0, from), Math.max(0, to)).map((text, offset) => ({
          line: Math.max(0, from) + offset + 1,
          text: clipLine(text),
        }));
      result.matches.push({
        path: shown,
        line: index + 1,
        column: match.index + 1,
        text: clipLine(line),
        before: context(index - input.context_lines, index),
        after: context(index + 1, index + 1 + input.context_lines),
      });
    }
    if (found) result.files_with_matches += 1;
    return true;
  };
  if ((await stat(target)).isFile()) {
    await searchFile(target, basename(target));
    return result;
  }
  const { excluded, unreadable } = await walk(
    target,
    input.exclude_names,
    async ({ relativePath, absolute, dirent }) => {
      if (!dirent.isFile() || !matchesGlob(relativePath, input.pattern))
        return true;
      try {
        return await searchFile(absolute, relativePath);
      } catch {
        if (result.unreadable.length < MAX_UNREADABLE)
          result.unreadable.push(relativePath);
        return true;
      }
    },
  );
  result.excluded_folders = excluded;
  result.unreadable.push(...unreadable);
  return result;
};
