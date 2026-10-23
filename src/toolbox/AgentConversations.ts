import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { parseReaCallCommands, reneCallFailed } from "./ReaCallCommand.js";

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
      /** Whether the tool is one of rene's, reached through MCP or `rene call`. */
      rene: boolean;
      args: unknown;
    }
  | {
      kind: "tool_result";
      at: string | null;
      id: string | null;
      is_error: boolean;
      text: string;
    }
  /** A message the person sent while the agent was working on a turn. */
  | { kind: "interjection"; at: string | null; text: string }
  /** The person stopped the agent mid-turn. */
  | { kind: "interrupt"; at: string | null }
  /**
   * Tokens one model call used (`scope: "call"`; records of one call share
   * its `call` id and repeat its usage), or a session's running total for a
   * model (`scope: "session"`, the latest replaces earlier ones, and covers
   * only models whose calls weren't recorded one by one). `input` excludes
   * cache reads and writes. `context_limit` is the prompt window the call
   * was allowed, where the agent records it, so what a call read can be read
   * as a share of it. `ai_credits_nano` is what the call was billed in the
   * agent service's own unit, in billionths of a credit, where it bills in
   * one; the agent shows the user the same figure.
   */
  | {
      kind: "usage";
      at: string | null;
      scope: "call" | "session";
      call: string | null;
      model: string | null;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      context_limit: number | null;
      ai_credits_nano: number | null;
    }
  /** Billing units the agent's service reported so far in the session. */
  | { kind: "billing"; at: string | null; premium_requests: number }
  /** The agent summarised its context to make room. */
  | {
      kind: "compaction";
      at: string | null;
      tokens_before: number | null;
      tokens_after: number | null;
      duration_ms: number | null;
    }
  /** A turn finished, with how long the agent worked on it when recorded. */
  | { kind: "turn_end"; at: string | null; duration_ms: number | null }
  /**
   * The account's premium-request quota as the service reported it with a
   * model call: requests used of those the plan allows this period.
   */
  | {
      kind: "quota";
      at: string | null;
      unlimited: boolean;
      entitlement: number | null;
      used: number;
      remaining_percent: number | null;
      resets_at: string | null;
      overage_allowed: boolean;
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
 * Which tools a tool use ran: a rene tool reached through MCP (named by the
 * agent's prefix for the rea server); every rene tool a shell tool use ran
 * with `rene call`, one for each call on its line; else the agent's own tool.
 * A `rene call` whose arguments aren't on its command line has args null.
 */
const toolsOf = (
  name: string,
  input: unknown,
  mcpName: RegExp,
): { tool: string; rene: boolean; args: unknown }[] => {
  const viaMcp = mcpName.exec(name);
  if (viaMcp) return [{ tool: viaMcp[1] as string, rene: true, args: input }];
  const command = record(input).command;
  if (SHELL_TOOL.test(name) && typeof command === "string") {
    const calls = parseReaCallCommands(command);
    if (calls.length > 0)
      return calls.map((call) => ({
        tool: call.tool,
        rene: true,
        args: call.args,
      }));
  }
  return [{ tool: name, rene: false, args: input }];
};

export const claudeProjects = (
  env: Readonly<Record<string, string | undefined>>,
) => join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
export const copilotSessions = (
  env: Readonly<Record<string, string | undefined>>,
) => join(env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state");

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
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
const countOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** The text Claude Code records when the person stops a turn. */
const INTERRUPTED = /^\[Request interrupted by user/u;

/**
 * The tokens one Claude Code record's model call used, side-chains (a
 * subagent's work) included: they count against the account too.
 */
export function claudeUsage(value: unknown): ConversationEvent[] {
  const line = record(value);
  const message = record(line.message);
  // Claude Code's own placeholder replies (errors, interruptions) cost nothing.
  if (
    line.type !== "assistant" ||
    message.usage === undefined ||
    message.model === "<synthetic>"
  )
    return [];
  const usage = record(message.usage);
  return [
    {
      kind: "usage",
      at: at(line.timestamp),
      scope: "call",
      call: typeof message.id === "string" ? message.id : null,
      model: typeof message.model === "string" ? message.model : null,
      input: count(usage.input_tokens),
      cache_read: count(usage.cache_read_input_tokens),
      cache_write: count(usage.cache_creation_input_tokens),
      output: count(usage.output_tokens),
      context_limit: null,
      ai_credits_nano: null,
    },
  ];
}

/** Events from one Claude Code transcript record; side-chains are left out. */
export function claudeEvents(value: unknown): ConversationEvent[] {
  const line = record(value);
  if (line.isSidechain === true) return [];
  const time = at(line.timestamp);
  const message = record(line.message);
  const content = message.content;
  const events: ConversationEvent[] = [];
  const attachment = record(line.attachment);
  if (
    line.type === "attachment" &&
    attachment.type === "queued_command" &&
    record(attachment.origin).kind === "human" &&
    typeof attachment.prompt === "string" &&
    isPrompt(attachment.prompt)
  )
    events.push({ kind: "interjection", at: time, text: attachment.prompt });
  else if (line.type === "system" && line.subtype === "compact_boundary") {
    const meta = record(line.compactMetadata);
    events.push({
      kind: "compaction",
      at: time,
      tokens_before: countOrNull(meta.preTokens),
      tokens_after: countOrNull(meta.postTokens),
      duration_ms: countOrNull(meta.durationMs),
    });
  } else if (line.type === "system" && line.subtype === "turn_duration")
    events.push({
      kind: "turn_end",
      at: time,
      duration_ms: countOrNull(line.durationMs),
    });
  // A compaction's summary is Claude Code's, written as if you sent it.
  if (
    line.type === "user" &&
    line.isMeta !== true &&
    line.isCompactSummary !== true
  ) {
    if (typeof content === "string") {
      if (INTERRUPTED.test(content))
        events.push({ kind: "interrupt", at: time });
      else if (isPrompt(content))
        events.push({ kind: "prompt", at: time, text: content });
    } else if (Array.isArray(content))
      for (const part of content.map(record)) {
        if (part.type === "tool_result")
          events.push({
            kind: "tool_result",
            at: time,
            id: typeof part.tool_use_id === "string" ? part.tool_use_id : null,
            // A failed `rene call` piped through a filter exits 0; its
            // receipt on stderr still says it failed.
            is_error:
              part.is_error === true || reneCallFailed(textOf(part.content)),
            text: textOf(part.content),
          });
        else if (part.type === "text" && typeof part.text === "string") {
          if (INTERRUPTED.test(part.text))
            events.push({ kind: "interrupt", at: time });
          else if (isPrompt(part.text))
            events.push({ kind: "prompt", at: time, text: part.text });
        }
      }
  } else if (line.type === "assistant" && Array.isArray(content)) {
    events.push(...claudeUsage(line));
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
        for (const tool of toolsOf(name, part.input ?? null, REA_CLAUDE))
          events.push({
            kind: "tool_use",
            at: time,
            id: typeof part.id === "string" ? part.id : null,
            ...tool,
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
      // "steering" is a message delivered into the turn the agent is on.
      return typeof data.content === "string" && isPrompt(data.content)
        ? [
            {
              kind: data.delivery === "steering" ? "interjection" : "prompt",
              at: time,
              text: data.content,
            },
          ]
        : [];
    case "abort":
      return data.reason === "user_initiated"
        ? [{ kind: "interrupt", at: time }]
        : [];
    case "session.compaction_complete":
      return data.success === false
        ? []
        : [
            {
              kind: "compaction",
              at: time,
              tokens_before: countOrNull(data.preCompactionTokens),
              tokens_after: countOrNull(data.postCompactionTokens),
              duration_ms: null,
            },
          ];
    case "model.model_call_success": {
      const events: ConversationEvent[] = [];
      const premium = record(record(data.quotaSnapshots).premium_interactions);
      if (Object.keys(premium).length > 0)
        events.push({
          kind: "quota",
          at: time,
          unlimited: premium.isUnlimitedEntitlement === true,
          entitlement:
            premium.isUnlimitedEntitlement === true
              ? null
              : countOrNull(premium.entitlementRequests),
          used: count(premium.usedRequests),
          remaining_percent: countOrNull(premium.remainingPercentage),
          resets_at: at(premium.resetDate),
          overage_allowed: premium.overageAllowedWithExhaustedQuota === true,
        });
      if (data.usage === undefined) return events;
      const usage = record(data.usage);
      const prompt = record(usage.prompt_tokens_details);
      const cacheRead = count(prompt.cached_tokens);
      const cacheWrite = count(prompt.cache_write_tokens);
      return [
        ...events,
        {
          kind: "usage",
          at: time,
          scope: "call",
          call: typeof data.callId === "string" ? data.callId : null,
          model: at(record(data.modelCall).model),
          input: Math.max(
            0,
            count(usage.prompt_tokens) - cacheRead - cacheWrite,
          ),
          cache_read: cacheRead,
          cache_write: cacheWrite,
          output: count(usage.completion_tokens),
          context_limit: null,
          ai_credits_nano: null,
        },
      ];
    }
    // One model call Copilot CLI billed, written as the call finishes: the
    // only per-call record of its main model, whose calls `model_call_success`
    // doesn't cover. `inputTokens` is the whole prompt, cache included.
    case "session.usage_record": {
      const usage = record(data.usage);
      const cacheRead = count(usage.cacheReadTokens);
      const cacheWrite = count(usage.cacheWriteTokens);
      const accounting = record(usage.accounting);
      const call =
        typeof accounting.usageId === "string"
          ? accounting.usageId
          : typeof usage.apiCallId === "string"
            ? usage.apiCallId
            : null;
      return [
        {
          kind: "usage",
          at: time,
          scope: "call",
          call,
          model: typeof usage.model === "string" ? usage.model : null,
          input: Math.max(0, count(usage.inputTokens) - cacheRead - cacheWrite),
          cache_read: cacheRead,
          cache_write: cacheWrite,
          output: count(usage.outputTokens),
          context_limit: countOrNull(usage.maxPromptTokens),
          ai_credits_nano: countOrNull(record(usage.copilotUsage).totalNanoAiu),
        },
      ];
    }
    case "session.usage_checkpoint":
      return [
        {
          kind: "billing",
          at: time,
          premium_requests: count(data.totalPremiumRequests),
        },
      ];
    case "session.shutdown": {
      // The session's totals per model, for a session whose calls weren't
      // recorded one by one (Copilot CLI before `session.usage_record`): a
      // reader counts these only for a model it saw no call of.
      const events: ConversationEvent[] = [
        {
          kind: "billing",
          at: time,
          premium_requests: count(data.totalPremiumRequests),
        },
      ];
      for (const [model, metrics] of Object.entries(
        record(data.modelMetrics),
      )) {
        const usage = record(record(metrics).usage);
        const cacheRead = count(usage.cacheReadTokens);
        const cacheWrite = count(usage.cacheWriteTokens);
        events.push({
          kind: "usage",
          at: time,
          scope: "session",
          call: null,
          model,
          input: Math.max(0, count(usage.inputTokens) - cacheRead - cacheWrite),
          cache_read: cacheRead,
          cache_write: cacheWrite,
          output: count(usage.outputTokens),
          context_limit: null,
          ai_credits_nano: null,
        });
      }
      return events;
    }
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
      return toolsOf(name, data.arguments ?? null, REA_COPILOT).map((tool) => ({
        kind: "tool_use" as const,
        at: time,
        id: typeof data.toolCallId === "string" ? data.toolCallId : null,
        ...tool,
      }));
    }
    case "tool.execution_complete":
      return [
        {
          kind: "tool_result",
          at: time,
          id: typeof data.toolCallId === "string" ? data.toolCallId : null,
          is_error:
            data.success === false ||
            reneCallFailed(textOf(record(data.result).content)) ||
            shellCommandFailed(textOf(record(data.result).content)),
          text: textOf(record(data.result).content),
        },
      ];
    default:
      return [];
  }
}

/**
 * Copilot CLI counts a shell call that ran as a success whatever the command
 * returned, and records the status only in the line it appends to the output.
 * A command that failed is a failed call, so read that line. A command it
 * moved to the background or stopped records no status and is not a failure.
 */
const SHELL_STATUS = /<shellId: [^>]*? exit code (\d+)>$/u;
const shellCommandFailed = (text: string): boolean => {
  const status = SHELL_STATUS.exec(text.trimEnd());
  return status !== null && status[1] !== "0";
};

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
