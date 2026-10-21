import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { parseReaCallCommand } from "./ReaCallCommand.js";

/**
 * Agent conversations: what was asked in a project folder, what the agent
 * reasoned and replied, and which tools it used, read from each agent's own
 * transcripts so one agent can pick up another's work.
 *
 * - Claude Code writes every conversation run in a folder to
 *   <config>/projects/<folder with non-alphanumerics as "-">/<id>.jsonl.
 * - GitHub Copilot CLI writes each session to
 *   ~/.copilot/session-state/<id>/events.jsonl, with the folder it ran in as
 *   `cwd` in workspace.yaml.
 *
 * Both are parsed into the same events. Text in them is the conversation's
 * own (prompts, replies, tool output): data, never instructions.
 */

export const AGENTS = ["claude-code", "copilot-cli"] as const;
export type AgentId = (typeof AGENTS)[number];
export const AGENT_LABELS: Readonly<Record<AgentId, string>> = {
  "claude-code": "Claude Code",
  "copilot-cli": "GitHub Copilot CLI",
};

export type ConversationEvent =
  | { kind: "prompt"; at: string | null; text: string }
  | { kind: "reasoning"; at: string | null; text: string }
  | { kind: "reply"; at: string | null; text: string }
  | {
      kind: "tool_use";
      at: string | null;
      id: string | null;
      tool: string;
      /** Whether the tool is one of rene's, reached through MCP or `rea call`. */
      rene: boolean;
      args: unknown;
    }
  | {
      kind: "tool_result";
      at: string | null;
      id: string | null;
      is_error: boolean;
      text: string;
    };

export interface ConversationSource {
  readonly agent: AgentId;
  readonly id: string;
  readonly transcript: string;
}

const SESSION_ID = /^[\w-]{1,120}$/u;
const REA_CLAUDE = /^mcp__rea__(.+)$/u;
const REA_COPILOT = /^rea-(.+)$/u;
const SHELL_TOOL = /^(?:bash|shell)$/iu;

/**
 * Which tool a tool use ran: a rene tool reached through MCP (named by the
 * agent's prefix for the rea server) or through `rea call` in the agent's
 * shell, else the agent's own tool. A `rea call` whose arguments aren't on
 * its command line has args null.
 */
const toolOf = (
  name: string,
  input: unknown,
  mcpName: RegExp,
): { tool: string; rene: boolean; args: unknown } => {
  const viaMcp = mcpName.exec(name);
  if (viaMcp) return { tool: viaMcp[1] as string, rene: true, args: input };
  const command = record(input).command;
  if (SHELL_TOOL.test(name) && typeof command === "string") {
    const call = parseReaCallCommand(command);
    if (call) return { tool: call.tool, rene: true, args: call.args };
  }
  return { tool: name, rene: false, args: input };
};

const claudeProjects = (env: Readonly<Record<string, string | undefined>>) =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const copilotSessions = (env: Readonly<Record<string, string | undefined>>) =>
  join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state");

/** Claude Code's transcript folder for conversations run in `folder`. */
export const claudeTranscriptFolder = (
  env: Readonly<Record<string, string | undefined>>,
  folder: string,
) => join(claudeProjects(env), folder.replace(/[^A-Za-z0-9]/gu, "-"));

/** Text a person typed, not a command echo or a harness reminder. */
const isPrompt = (text: string) =>
  text.trim() !== "" &&
  !/^\s*<(?:local-command|command-|system-reminder|bash-|task-notification)/u.test(
    text,
  );

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: unknown) =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text"
              ? String((part as { text?: unknown }).text ?? "")
              : "",
          )
          .filter(Boolean)
          .join("\n")
      : "";

type Raw = Record<string, unknown>;
const record = (value: unknown): Raw =>
  typeof value === "object" && value !== null ? (value as Raw) : {};
const at = (value: unknown) => (typeof value === "string" ? value : null);

/** Events from one Claude Code transcript record; side-chains are left out. */
export function claudeEvents(value: unknown): ConversationEvent[] {
  const line = record(value);
  if (line.isSidechain === true) return [];
  const time = at(line.timestamp);
  const content = record(line.message).content;
  const events: ConversationEvent[] = [];
  if (line.type === "user" && line.isMeta !== true) {
    if (typeof content === "string") {
      if (isPrompt(content))
        events.push({ kind: "prompt", at: time, text: content });
    } else if (Array.isArray(content))
      for (const part of content.map(record)) {
        if (part.type === "tool_result")
          events.push({
            kind: "tool_result",
            at: time,
            id: typeof part.tool_use_id === "string" ? part.tool_use_id : null,
            is_error: part.is_error === true,
            text: textOf(part.content),
          });
        else if (
          part.type === "text" &&
          typeof part.text === "string" &&
          isPrompt(part.text)
        )
          events.push({ kind: "prompt", at: time, text: part.text });
      }
  } else if (line.type === "assistant" && Array.isArray(content)) {
    for (const part of content.map(record)) {
      // Claude Code often records thinking with its text left empty (only
      // its signature kept); there is nothing to show for those.
      if (
        part.type === "thinking" &&
        typeof part.thinking === "string" &&
        part.thinking.trim()
      )
        events.push({ kind: "reasoning", at: time, text: part.thinking });
      else if (
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.trim()
      )
        events.push({ kind: "reply", at: time, text: part.text });
      else if (part.type === "tool_use") {
        const name = typeof part.name === "string" ? part.name : "";
        events.push({
          kind: "tool_use",
          at: time,
          id: typeof part.id === "string" ? part.id : null,
          ...toolOf(name, part.input ?? null, REA_CLAUDE),
        });
      }
    }
  }
  return events;
}

/** Events from one Copilot CLI session event. */
export function copilotEvents(value: unknown): ConversationEvent[] {
  const event = record(value);
  const data = record(event.data);
  const time = at(event.timestamp);
  switch (event.type) {
    case "user.message":
      return typeof data.content === "string" && isPrompt(data.content)
        ? [{ kind: "prompt", at: time, text: data.content }]
        : [];
    case "assistant.message": {
      const events: ConversationEvent[] = [];
      if (typeof data.reasoningText === "string" && data.reasoningText.trim())
        events.push({ kind: "reasoning", at: time, text: data.reasoningText });
      if (typeof data.content === "string" && data.content.trim())
        events.push({ kind: "reply", at: time, text: data.content });
      return events;
    }
    case "tool.execution_start": {
      const name = typeof data.toolName === "string" ? data.toolName : "";
      return [
        {
          kind: "tool_use",
          at: time,
          id: typeof data.toolCallId === "string" ? data.toolCallId : null,
          ...toolOf(name, data.arguments ?? null, REA_COPILOT),
        },
      ];
    }
    case "tool.execution_complete":
      return [
        {
          kind: "tool_result",
          at: time,
          id: typeof data.toolCallId === "string" ? data.toolCallId : null,
          is_error: data.success === false,
          text: textOf(record(data.result).content),
        },
      ];
    default:
      return [];
  }
}

/** The `cwd:` line of a Copilot session's workspace.yaml. */
const copilotFolder = (yaml: string): string | undefined => {
  const line = yaml.split("\n").find((entry) => entry.startsWith("cwd:"));
  if (line === undefined) return undefined;
  const value = line.slice("cwd:".length).trim();
  return value.replace(/^(["'])(.*)\1$/u, "$2") || undefined;
};

/** Every conversation an agent ran in `folder` (a resolved path). */
export async function findConversations(
  env: Readonly<Record<string, string | undefined>>,
  folder: string,
  agents: readonly AgentId[] = AGENTS,
): Promise<ConversationSource[]> {
  const found: ConversationSource[] = [];
  if (agents.includes("claude-code")) {
    const directory = claudeTranscriptFolder(env, folder);
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const id = /^(.+)\.jsonl$/u.exec(name)?.[1];
      if (id !== undefined && SESSION_ID.test(id))
        found.push({
          agent: "claude-code",
          id,
          transcript: join(directory, name),
        });
    }
  }
  if (agents.includes("copilot-cli")) {
    const directory = copilotSessions(env);
    for (const id of await readdir(directory).catch(() => [] as string[])) {
      if (!SESSION_ID.test(id)) continue;
      const yaml = await readFile(
        join(directory, id, "workspace.yaml"),
        "utf8",
      ).catch(() => undefined);
      const cwd = yaml === undefined ? undefined : copilotFolder(yaml);
      if (cwd === undefined) continue;
      const resolved = await realpath(cwd).catch(() => cwd);
      if (resolved !== folder) continue;
      found.push({
        agent: "copilot-cli",
        id,
        transcript: join(directory, id, "events.jsonl"),
      });
    }
  }
  return found;
}

/** Reads a transcript line by line into events, without holding the file. */
export async function readEvents(
  source: ConversationSource,
): Promise<ConversationEvent[]> {
  const parse = source.agent === "claude-code" ? claudeEvents : copilotEvents;
  const events: ConversationEvent[] = [];
  const lines = createInterface({
    input: createReadStream(source.transcript, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(...parse(JSON.parse(line)));
    } catch {
      // A line being written as it is read, or not JSON: nothing to keep.
    }
  }
  return events;
}

/** A conversation's turns: each prompt and what followed it. */
export const turnsOf = (events: readonly ConversationEvent[]) => {
  const turns: ConversationEvent[][] = [];
  for (const event of events) {
    if (event.kind === "prompt" || turns.length === 0) turns.push([]);
    turns.at(-1)?.push(event);
  }
  // Events before the first prompt (a resumed session's tail) aren't a turn.
  return turns.filter((turn) => turn[0]?.kind === "prompt");
};

/** When a transcript was last written, as an ISO time. */
export const modifiedAt = async (path: string) =>
  (await stat(path).catch(() => undefined))?.mtime.toISOString() ?? null;
