import {
  editFileInputSchema,
  editFileResultSchema,
  findFilesInputSchema,
  findFilesResultSchema,
  readFileInputSchema,
  readFileResultSchema,
  recordTopicInputSchema,
  recordTopicResultSchema,
  runCommandInputSchema,
  runCommandResultSchema,
  searchTextInputSchema,
  searchTextResultSchema,
  writeFileInputSchema,
  writeFileResultSchema,
} from "../domain/toolbox.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const ROOTS =
  "Paths must resolve, through symbolic links, inside the toolbox roots: the home folder, or the folders in REA_TOOLBOX_ROOTS.";

/** The agent toolbox: everyday file, search and shell actions as recorded REA calls. */
export const TOOLBOX_TOOL_CONTRACTS = [
  {
    name: "read_file",
    ...toolContractMetadata("read_file"),
    kind: "toolbox",
    description: `Read a text file: a range of lines (start_line, max_lines) with the file's size, SHA-256 and total line count. Up to 4 MiB is decoded; a file with a NUL byte in its first 8 KiB is reported as binary, with its digest and no text. ${ROOTS}`,
    inputSchema: readFileInputSchema,
    outputSchema: evidenceResultOf(readFileResultSchema),
    examples: [
      {
        title: "Read a file",
        input: { path: "/home/analyst/project/README.md" },
      },
    ],
  },
  {
    name: "write_file",
    ...toolContractMetadata("write_file"),
    kind: "toolbox",
    description: `Write a text file's complete content, atomically (a temporary file in the same folder, then a rename), keeping an existing file's permissions. An existing file is refused unless overwrite is true; missing parent folders are refused unless create_directories is true. Returns the new and previous SHA-256. ${ROOTS}`,
    inputSchema: writeFileInputSchema,
    outputSchema: evidenceResultOf(writeFileResultSchema),
    examples: [
      {
        title: "Create a notes file",
        input: { path: "/home/analyst/project/notes.md", content: "# Notes\n" },
      },
    ],
  },
  {
    name: "edit_file",
    ...toolContractMetadata("edit_file"),
    kind: "toolbox",
    description: `Replace exact text in a text file, atomically and keeping its permissions. old_text must occur exactly once unless replace_all is true; the count and the SHA-256 before and after are returned. ${ROOTS}`,
    inputSchema: editFileInputSchema,
    outputSchema: evidenceResultOf(editFileResultSchema),
    examples: [
      {
        title: "Change one line",
        input: {
          path: "/home/analyst/project/config.toml",
          old_text: "debug = false",
          new_text: "debug = true",
        },
      },
    ],
  },
  {
    name: "find_files",
    ...toolContractMetadata("find_files"),
    kind: "toolbox",
    description: `List files under a folder whose relative path matches a glob (e.g. **/*.ts), in name order, with size and modification time. Symbolic links are listed, not followed; folders named in exclude_names (default .git, node_modules) are skipped and reported. ${ROOTS}`,
    inputSchema: findFilesInputSchema,
    outputSchema: evidenceResultOf(findFilesResultSchema),
    examples: [
      {
        title: "Find TypeScript files",
        input: { root: "/home/analyst/project", pattern: "**/*.ts" },
      },
    ],
  },
  {
    name: "search_text",
    ...toolContractMetadata("search_text"),
    kind: "toolbox",
    description: `Search text files under a folder (or one file) for a literal or regular expression, line by line, with optional context lines. Files over 2 MiB and binary files are skipped and counted; folders in exclude_names are skipped and reported. ${ROOTS}`,
    inputSchema: searchTextInputSchema,
    outputSchema: evidenceResultOf(searchTextResultSchema),
    examples: [
      {
        title: "Find where a function is used",
        input: {
          root: "/home/analyst/project",
          query: "openDatabase",
          pattern: "**/*.ts",
        },
      },
    ],
  },
  {
    name: "run_command",
    ...toolContractMetadata("run_command"),
    kind: "toolbox",
    description: `Run a shell command line with bash -c in a folder and return its exit code, signal, stdout and stderr (1 MiB kept), and duration. The command and everything it starts are stopped at timeout_ms or on cancellation; a nonzero exit is a result. It runs with the current user's permissions where REA runs (its container, when started from the workbench) and can change files, start programs and use the network. ${ROOTS}`,
    inputSchema: runCommandInputSchema,
    outputSchema: evidenceResultOf(runCommandResultSchema),
    examples: [
      {
        title: "List a folder",
        input: { command: "ls -la", cwd: "/home/analyst/project" },
      },
    ],
  },
  {
    name: "record_topic",
    ...toolContractMetadata("record_topic"),
    kind: "toolbox",
    description:
      "Declare or update a conversation topic so work can be grouped by its relationship: a thread (kind thread, the chat relationship at the top of the hierarchy, no parent) or a topic under it (feature, question, bug, investigation, refactor, docs, decision, other) with parent_id set to its thread. Optional relations link topics (follows_up, fixes, reopens, depends_on, duplicates, supersedes); status is open, done or abandoned. Omit topic_id to declare a new topic and get its id; pass topic_id to update one, where the latest declaration is its current state. Call it when a request begins, and again when its status changes. It stores nothing itself: the declaration is the recorded call.",
    inputSchema: recordTopicInputSchema,
    outputSchema: evidenceResultOf(recordTopicResultSchema),
    examples: [
      {
        title: "Declare a thread",
        input: { title: "CodeGraph to DuckDB migration", kind: "thread" },
      },
      {
        title: "Declare a feature under a thread",
        input: {
          title: "Rust store crate with napi-rs",
          kind: "feature",
          parent_id: "00000000-0000-4000-8000-000000000001",
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
