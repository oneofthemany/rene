import { z } from "zod";

import { localPathStringSchema } from "./localPath.js";

/**
 * The agent toolbox: reading, writing and editing files, finding files,
 * searching text and running commands, as REA tools so every action an agent
 * takes is a recorded, auditable call. Each tool works only inside the
 * toolbox roots (the user's home folder unless REA_TOOLBOX_ROOTS says
 * otherwise), resolved through symbolic links before any access.
 */

const absolutePath = localPathStringSchema.describe(
  "Absolute path inside the toolbox roots (the home folder by default).",
);
const excludeNames = z
  .array(z.string().min(1))
  .default([".git", "node_modules"])
  .describe("Folder names not descended into.");

export const MAX_READ_BYTES = 4 * 1024 * 1024;
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export const readFileInputSchema = z.strictObject({
  path: absolutePath,
  start_line: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("First line to return, counting from 1."),
  max_lines: z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .default(2000)
    .describe("Lines returned from start_line."),
});

export const readFileResultSchema = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  binary: z.boolean(),
  start_line: z.number().int(),
  end_line: z.number().int(),
  total_lines: z.number().int().nonnegative(),
  truncated: z.boolean(),
  text: z.string(),
});

export const writeFileInputSchema = z.strictObject({
  path: absolutePath,
  content: z
    .string()
    .max(MAX_WRITE_BYTES)
    .describe("The file's complete new text."),
  overwrite: z
    .boolean()
    .default(false)
    .describe(
      "Replace an existing file; without it an existing file is refused.",
    ),
  create_directories: z
    .boolean()
    .default(false)
    .describe("Create missing parent folders."),
});

export const writeFileResultSchema = z.strictObject({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  created: z.boolean(),
  previous_sha256: z.string().nullable(),
});

export const editFileInputSchema = z.strictObject({
  path: absolutePath,
  old_text: z.string().min(1).describe("Exact text to replace."),
  new_text: z.string().describe("Its replacement; empty deletes it."),
  replace_all: z
    .boolean()
    .default(false)
    .describe(
      "Replace every occurrence; without it old_text must occur exactly once.",
    ),
});

export const editFileResultSchema = z.strictObject({
  path: z.string(),
  replacements: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  previous_sha256: z.string(),
});

export const findFilesInputSchema = z.strictObject({
  root: absolutePath.describe("Folder to search, inside the toolbox roots."),
  pattern: z
    .string()
    .min(1)
    .default("**/*")
    .describe("Glob matched against paths relative to root, e.g. **/*.ts."),
  exclude_names: excludeNames,
  include_directories: z.boolean().default(false),
  max_results: z.number().int().min(1).max(20_000).default(1000),
});

export const findFilesResultSchema = z.strictObject({
  root: z.string(),
  pattern: z.string(),
  matches: z.array(
    z.strictObject({
      path: z.string(),
      kind: z.enum(["file", "directory", "symlink"]),
      bytes: z.number().int().nonnegative(),
      modified: z.string(),
    }),
  ),
  truncated: z.boolean(),
  excluded_folders: z.array(z.string()),
  unreadable: z.array(z.string()),
});

export const searchTextInputSchema = z.strictObject({
  root: absolutePath.describe(
    "Folder (searched recursively) or single file, inside the toolbox roots.",
  ),
  query: z.string().min(1).describe("Text or regular expression to find."),
  regex: z
    .boolean()
    .default(false)
    .describe("Treat query as a JavaScript regular expression."),
  case_sensitive: z.boolean().default(true),
  pattern: z
    .string()
    .min(1)
    .default("**/*")
    .describe("Glob limiting which files are searched, relative to root."),
  exclude_names: excludeNames,
  context_lines: z.number().int().min(0).max(10).default(0),
  max_matches: z.number().int().min(1).max(10_000).default(500),
});

const searchLine = z.strictObject({
  line: z.number().int().positive(),
  text: z.string(),
});

export const searchTextResultSchema = z.strictObject({
  root: z.string(),
  query: z.string(),
  matches: z.array(
    z.strictObject({
      path: z.string(),
      line: z.number().int().positive(),
      column: z.number().int().positive(),
      text: z.string(),
      before: z.array(searchLine),
      after: z.array(searchLine),
    }),
  ),
  files_searched: z.number().int().nonnegative(),
  files_with_matches: z.number().int().nonnegative(),
  truncated: z.boolean(),
  skipped_binary: z.number().int().nonnegative(),
  skipped_large: z.number().int().nonnegative(),
  excluded_folders: z.array(z.string()),
  unreadable: z.array(z.string()),
});

export const runCommandInputSchema = z.strictObject({
  command: z
    .string()
    .min(1)
    .describe(
      "Shell command line, run with bash -c (pipes and redirects work).",
    ),
  cwd: absolutePath.describe("Working folder, inside the toolbox roots."),
  timeout_ms: z
    .number()
    .int()
    .min(100)
    .max(30 * 60_000)
    .default(120_000)
    .describe("The command and everything it started are stopped after this."),
  environment: z
    .record(z.string(), z.string())
    .default({})
    .describe("Extra environment variables for the command."),
});

export const runCommandResultSchema = z.strictObject({
  command: z.string(),
  cwd: z.string(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  output_truncated: z.boolean(),
  stopped: z
    .enum(["timeout", "cancelled", "output-limit"])
    .nullable()
    .describe("Why REA stopped the command, or null when it ended by itself."),
  duration_ms: z.number().int().nonnegative(),
});

/**
 * Conversation topics: a thread (the chat relationship, the top of the
 * hierarchy) and the topics under it, each a kind of request. A declaration
 * is a recorded call; the latest declaration of a topic_id is its current
 * state, so the topic tree and every change to it live in the call history.
 */
export const TOPIC_KINDS = [
  "thread",
  "feature",
  "question",
  "bug",
  "investigation",
  "refactor",
  "docs",
  "decision",
  "other",
] as const;
export const TOPIC_RELATIONS = [
  "follows_up",
  "fixes",
  "reopens",
  "depends_on",
  "duplicates",
  "supersedes",
] as const;

const topicId = z.string().uuid();
const topicEvidence = z.array(z.string().regex(/^ev_[a-f0-9]{64}$/u)).max(50);
// A turn by its recorded identity: the conversation it is in and the time
// its request was made, as the workbench lists turns no topic holds.
const topicTurn = z.strictObject({
  session: z.string().min(1).max(200),
  at: z.string().datetime({ offset: true }),
});

export const recordTopicInputSchema = z
  .strictObject({
    topic_id: topicId
      .optional()
      .describe("An existing topic to update; omit to declare a new one."),
    title: z.string().min(1).max(200),
    kind: z
      .enum(TOPIC_KINDS)
      .describe(
        "thread: a chat relationship, the top of the hierarchy (no parent). The other kinds sit under a thread.",
      ),
    parent_id: topicId
      .nullable()
      .default(null)
      .describe(
        "The thread (or topic) this one belongs to; null for a thread.",
      ),
    status: z.enum(["open", "done", "abandoned"]).default("open"),
    relations: z
      .array(
        z.strictObject({
          topic_id: topicId,
          relation: z.enum(TOPIC_RELATIONS),
        }),
      )
      .max(20)
      .default([])
      .describe("How this topic relates to other topics."),
    summary: z
      .string()
      .max(2000)
      .default("")
      .describe("What was asked, found or decided, in a few sentences."),
    evidence: topicEvidence
      .default([])
      .describe(
        "The evidence_id of each earlier result the summary rests on, so the topic's conclusion links to the calls that produced it.",
      ),
    turns: z
      .array(topicTurn)
      .max(200)
      .default([])
      .describe(
        "Earlier turns this topic holds, named by session and at as the project assessment lists turns in no topic. A turn that declares a topic itself stays with that topic.",
      ),
  })
  .superRefine((topic, context) => {
    if (topic.kind === "thread" && topic.parent_id !== null)
      context.addIssue({
        code: "custom",
        path: ["parent_id"],
        message: "A thread is the top of the hierarchy and has no parent.",
      });
    if (topic.kind !== "thread" && topic.parent_id === null)
      context.addIssue({
        code: "custom",
        path: ["parent_id"],
        message: `A ${topic.kind} topic belongs to a thread: set parent_id.`,
      });
  });

export const recordTopicResultSchema = z.strictObject({
  topic_id: topicId,
  title: z.string(),
  kind: z.enum(TOPIC_KINDS),
  parent_id: topicId.nullable(),
  status: z.enum(["open", "done", "abandoned"]),
  relations: z.array(
    z.strictObject({ topic_id: topicId, relation: z.enum(TOPIC_RELATIONS) }),
  ),
  summary: z.string(),
  evidence: topicEvidence,
  turns: z.array(topicTurn),
  declared_at: z.string(),
  created: z.boolean(),
});

/**
 * Agent conversations: the conversations coding agents (Claude Code, GitHub
 * Copilot CLI) ran in a project folder, read from their own transcripts, so
 * an agent can see what another asked, found and did there.
 */
export const CONVERSATION_AGENTS = ["claude-code", "copilot-cli"] as const;

export const listAgentConversationsInputSchema = z.strictObject({
  project_path: absolutePath.describe(
    "The project folder the conversations ran in.",
  ),
  agent: z
    .enum(["all", ...CONVERSATION_AGENTS])
    .default("all")
    .describe("Whose conversations to list."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .describe("The most recently written conversations listed."),
});

export const listAgentConversationsResultSchema = z.strictObject({
  project_path: z.string(),
  conversations: z.array(
    z.strictObject({
      agent: z.enum(CONVERSATION_AGENTS),
      agent_label: z.string(),
      conversation_id: z.string(),
      transcript: z.string(),
      started_at: z.string().nullable(),
      updated_at: z.string().nullable(),
      turns: z.number().int().nonnegative(),
      first_prompt: z.string().nullable(),
      last_prompt: z.string().nullable(),
    }),
  ),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const readAgentConversationInputSchema = z.strictObject({
  project_path: absolutePath.describe(
    "The project folder the conversation ran in.",
  ),
  agent: z.enum(CONVERSATION_AGENTS),
  conversation_id: z
    .string()
    .regex(/^[\w-]{1,120}$/u)
    .describe("From list_agent_conversations."),
  from_turn: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "First turn returned, counting from 1; omit for the latest turns.",
    ),
  max_turns: z.number().int().min(1).max(50).default(5),
  include_reasoning: z
    .boolean()
    .default(false)
    .describe("Include the agent's recorded reasoning."),
  include_tool_results: z
    .boolean()
    .default(false)
    .describe("Include what each tool returned, not only that it was called."),
  max_text_chars: z
    .number()
    .int()
    .min(200)
    .max(20_000)
    .default(2000)
    .describe("Each prompt, reply, reasoning or result is cut to this length."),
});

const conversationEntry = z.strictObject({
  kind: z.enum(["reasoning", "reply", "tool_use", "tool_result"]),
  at: z.string().nullable(),
  text: z.string().optional(),
  tool: z.string().optional(),
  rene: z.boolean().optional(),
  args: z.string().optional(),
  is_error: z.boolean().optional(),
  truncated: z.boolean(),
});

export const readAgentConversationResultSchema = z.strictObject({
  project_path: z.string(),
  agent: z.enum(CONVERSATION_AGENTS),
  agent_label: z.string(),
  conversation_id: z.string(),
  turn_count: z.number().int().nonnegative(),
  from_turn: z.number().int().nonnegative(),
  to_turn: z.number().int().nonnegative(),
  turns: z.array(
    z.strictObject({
      index: z.number().int().positive(),
      at: z.string().nullable(),
      prompt: z.string(),
      prompt_truncated: z.boolean(),
      entries: z.array(conversationEntry),
    }),
  ),
});

export type ListAgentConversationsInput = z.infer<
  typeof listAgentConversationsInputSchema
>;
export type ReadAgentConversationInput = z.infer<
  typeof readAgentConversationInputSchema
>;
export type RecordTopicInput = z.infer<typeof recordTopicInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type EditFileInput = z.infer<typeof editFileInputSchema>;
export type FindFilesInput = z.infer<typeof findFilesInputSchema>;
export type SearchTextInput = z.infer<typeof searchTextInputSchema>;
export type RunCommandInput = z.infer<typeof runCommandInputSchema>;
