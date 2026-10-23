import type {
  ListAgentConversationsInput,
  ReadAgentConversationInput,
} from "../domain/toolbox.js";
import {
  AGENT_LABELS,
  AGENTS,
  findConversations,
  modifiedAt,
  readEvents,
  turnsOf,
  type ConversationEvent,
} from "./AgentConversations.js";
import { confine, ToolboxRefusal } from "./ToolboxFiles.js";

type Environment = Readonly<Record<string, string | undefined>>;

const PROMPT_PREVIEW = 200;
const ARGS_PREVIEW = 500;

/** Usage accounting, which the workbench's usage bar reads; not shown here. */
const ACCOUNTING: ReadonlySet<ConversationEvent["kind"]> = new Set([
  "usage",
  "billing",
  "turn_end",
  "quota",
]);
type Entry = Exclude<
  ConversationEvent,
  { kind: "prompt" | "usage" | "billing" | "turn_end" | "quota" }
>;

const clip = (text: string, limit: number) =>
  text.length > limit
    ? { text: `${text.slice(0, limit)}…`, truncated: true }
    : { text, truncated: false };

const firstLine = (text: string) =>
  clip(text.replace(/\s+/gu, " ").trim(), PROMPT_PREVIEW).text;

/** The conversations agents ran in a project folder, latest first. */
export async function listAgentConversations(
  roots: readonly string[],
  environment: Environment,
  input: ListAgentConversationsInput,
) {
  const folder = await confine(roots, input.project_path, "project_path");
  const sources = await findConversations(
    environment,
    folder,
    input.agent === "all" ? AGENTS : [input.agent],
  );
  const dated = await Promise.all(
    sources.map(async (source) => ({
      source,
      updated: await modifiedAt(source.transcript),
    })),
  );
  dated.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  const shown = dated.slice(0, input.limit);
  const conversations = await Promise.all(
    shown.map(async ({ source, updated }) => {
      const events: ConversationEvent[] = await readEvents(source).catch(
        () => [],
      );
      const prompts = events.filter(
        (event): event is Extract<ConversationEvent, { kind: "prompt" }> =>
          event.kind === "prompt",
      );
      return {
        agent: source.agent,
        agent_label: AGENT_LABELS[source.agent],
        conversation_id: source.id,
        transcript: source.transcript,
        started_at: events.find((event) => event.at !== null)?.at ?? null,
        updated_at: updated,
        turns: prompts.length,
        first_prompt: prompts[0] ? firstLine(prompts[0].text) : null,
        last_prompt: prompts.at(-1) ? firstLine(prompts.at(-1)!.text) : null,
      };
    }),
  );
  return {
    project_path: folder,
    conversations,
    total: sources.length,
    truncated: sources.length > shown.length,
  };
}

/** One conversation's turns, paged and cut to size. */
export async function readAgentConversation(
  roots: readonly string[],
  environment: Environment,
  input: ReadAgentConversationInput,
) {
  const folder = await confine(roots, input.project_path, "project_path");
  const source = (
    await findConversations(environment, folder, [input.agent])
  ).find((candidate) => candidate.id === input.conversation_id);
  if (source === undefined)
    throw new ToolboxRefusal(
      `No ${AGENT_LABELS[input.agent]} conversation ${input.conversation_id} ran in ${folder}; list_agent_conversations lists them.`,
      "conversation_id",
    );
  const turns = turnsOf(await readEvents(source));
  const start =
    input.from_turn === undefined
      ? Math.max(0, turns.length - input.max_turns)
      : Math.min(input.from_turn - 1, turns.length);
  const page = turns.slice(start, start + input.max_turns);
  const limit = input.max_text_chars;
  const entry = (event: Entry) => {
    switch (event.kind) {
      case "reasoning":
      case "reply":
      case "interjection":
        return { kind: event.kind, at: event.at, ...clip(event.text, limit) };
      case "interrupt":
        return { kind: event.kind, at: event.at, truncated: false };
      case "compaction":
        return {
          kind: event.kind,
          at: event.at,
          tokens_before: event.tokens_before,
          tokens_after: event.tokens_after,
          truncated: false,
        };
      case "tool_use": {
        const args = clip(JSON.stringify(event.args ?? null), ARGS_PREVIEW);
        return {
          kind: event.kind,
          at: event.at,
          tool: event.tool,
          rene: event.rene,
          args: args.text,
          truncated: args.truncated,
        };
      }
      case "tool_result":
        return {
          kind: event.kind,
          at: event.at,
          is_error: event.is_error,
          ...clip(event.text, limit),
        };
    }
  };
  return {
    project_path: folder,
    agent: input.agent,
    agent_label: AGENT_LABELS[input.agent],
    conversation_id: input.conversation_id,
    turn_count: turns.length,
    from_turn: page.length > 0 ? start + 1 : 0,
    to_turn: start + page.length,
    turns: page.map((turn, offset) => {
      const [prompt, ...rest] = turn;
      const promptText = prompt?.kind === "prompt" ? prompt.text : "";
      const clipped = clip(promptText, limit);
      return {
        index: start + offset + 1,
        at: prompt?.at ?? null,
        prompt: clipped.text,
        prompt_truncated: clipped.truncated,
        entries: rest
          .filter(
            (event): event is Entry =>
              event.kind !== "prompt" &&
              !ACCOUNTING.has(event.kind) &&
              (event.kind !== "reasoning" || input.include_reasoning) &&
              (event.kind !== "tool_result" || input.include_tool_results),
          )
          .map(entry),
      };
    }),
  };
}
