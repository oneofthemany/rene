import type { Client } from "@modelcontextprotocol/client";

import type { ReportSender } from "../toolbox/HistoryReport.js";
import { CONSENT_RULE, consentNeeded } from "../toolbox/CommandConsent.js";
import { GIT_HISTORY_RULE, gitHistoryWrite } from "../toolbox/GitHistory.js";
import type {
  ProviderSession,
  ToolCall,
  ToolOutcome,
  ToolSpec,
  Turn,
} from "./providers.js";

/**
 * The loop of `rene agent`: the model asks for tools, the agent runs them
 * through rene and hands back what they returned, until the model answers.
 *
 * The model sees three tools rather than rene's ~235: search_tools,
 * describe_tool and call_tool. Every rene tool stays reachable, and the
 * definitions a small local context window must carry stay small. A
 * call_tool is made with `callRecorded`, as `rene call` makes it, so it
 * reaches the workbench's history the same way.
 *
 * The workbench's rules hold here as its topic gate holds them for Claude
 * Code: a turn's first rene call declares its topic (record_topic), and a
 * shell command that would write git history is refused.
 */

export const AGENT_TOOLS: readonly ToolSpec[] = [
  {
    name: "search_tools",
    description:
      "Find rene tools whose name or description contains every one of the words. Returns one line per tool: its name and what it does.",
    input_schema: {
      type: "object",
      properties: {
        words: {
          type: "array",
          items: { type: "string" },
          description: 'Words to match, such as ["read", "file"].',
        },
      },
      required: ["words"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_tool",
    description:
      "Show one rene tool's description and the JSON Schema of its input, before calling it.",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "call_tool",
    description:
      "Run one rene tool with its arguments and return its result (Evidence JSON for most tools).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The rene tool's name." },
        arguments: {
          type: "object",
          description: "The tool's input, as describe_tool shows its schema.",
        },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
  },
];

/** What a run tells its caller as it goes. */
export type AgentEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly call: ToolCall }
  | {
      readonly type: "result";
      readonly call: ToolCall;
      readonly outcome: ToolOutcome;
    }
  | { readonly type: "usage"; readonly turn: Turn }
  | { readonly type: "notice"; readonly text: string };

export interface AgentToolbox {
  readonly client: Client;
  readonly reports: ReportSender | undefined;
  /** Asks the user a yes-or-no question; absent when no one can be asked. */
  readonly confirm?: ((question: string) => Promise<boolean>) | undefined;
  /** Calls one rene tool, recorded; returns the text an agent reads. */
  call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface TurnOptions {
  readonly session: ProviderSession;
  readonly toolbox: AgentToolbox;
  readonly prompt: string;
  readonly maxResultChars: number;
  /** Model replies one request may take before it is stopped. */
  readonly maxSteps: number;
  readonly onEvent: (event: AgentEvent) => void;
}

export interface TurnOutcome {
  readonly answer: string;
  readonly declared: boolean;
  readonly steps: number;
  readonly stopped?: "max-steps" | "refusal";
}

const DECLARE_FIRST =
  "No topic is declared for this request yet. Call call_tool with name record_topic first: pass the topic_id of the topic it continues (the project assessment's Topics section lists them), or declare a new feature, question, bug, investigation, refactor, docs, decision or other topic under its thread (declare a thread, kind thread, first when none fits).";

/** Cuts a result to `limit` characters from its middle, saying how much went. */
const bounded = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const keep = Math.floor((limit - 200) / 2);
  return `${text.slice(0, keep)}\n…[${text.length - 2 * keep} characters cut: ask the tool for less, for example a smaller range]…\n${text.slice(text.length - keep)}`;
};

interface ToolLine {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

/** The first sentence of a description, on one line. */
const summary = (description = "") => {
  const text = description.replace(/\s+/gu, " ").trim();
  const end = text.search(/\.(\s|$)/u);
  return end === -1 ? text : text.slice(0, end + 1);
};

class TurnRun {
  #declared = false;
  #tools: readonly ToolLine[] | undefined;

  constructor(private readonly options: TurnOptions) {}

  async #catalog(): Promise<readonly ToolLine[]> {
    if (this.#tools !== undefined) return this.#tools;
    const tools: ToolLine[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.options.toolbox.client.listTools(
        cursor === undefined ? undefined : { cursor },
      );
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    this.#tools = tools;
    return tools;
  }

  async #searchTools(input: Readonly<Record<string, unknown>>) {
    const words = (Array.isArray(input.words) ? input.words : [input.words])
      .filter((word): word is string => typeof word === "string")
      .map((word) => word.toLowerCase());
    const matches = (await this.#catalog()).filter((tool) => {
      const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
      return words.every((word) => text.includes(word));
    });
    if (matches.length === 0)
      return {
        text: "No rene tool matches every one of those words.",
        isError: false,
      };
    const shown = matches.slice(0, 30);
    return {
      text: [
        ...shown.map((tool) => `${tool.name}\t${summary(tool.description)}`),
        ...(matches.length > shown.length
          ? [`…and ${matches.length - shown.length} more; add words to narrow.`]
          : []),
      ].join("\n"),
      isError: false,
    };
  }

  async #describeTool(input: Readonly<Record<string, unknown>>) {
    const tool = (await this.#catalog()).find(
      (candidate) => candidate.name === input.name,
    );
    return tool === undefined
      ? {
          text: `No rene tool is named ${String(input.name)}; search_tools finds tools.`,
          isError: true,
        }
      : {
          text: JSON.stringify({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          }),
          isError: false,
        };
  }

  /**
   * Why a command may not run, when it needs the user's consent
   * (CommandConsent.ts) and the user didn't give it, or can't be asked.
   */
  async #consent(command: string): Promise<string | undefined> {
    const reason = consentNeeded(command);
    if (reason === undefined) return undefined;
    const { confirm } = this.options.toolbox;
    if (confirm === undefined)
      return `This command needs the user's consent (${reason}), and this session can't ask: run rene agent in a terminal to be asked. ${CONSENT_RULE}`;
    if (
      await confirm(
        `rene agent wants to run a command that needs your consent: ${reason}.\n  ${command}\nAllow it?`,
      )
    )
      return undefined;
    return `The user declined this command (${reason}). Don't retry it; say what you would need it for, or find another way. ${CONSENT_RULE}`;
  }

  async #callTool(input: Readonly<Record<string, unknown>>) {
    const name = typeof input.name === "string" ? input.name : "";
    const args =
      typeof input.arguments === "object" &&
      input.arguments !== null &&
      !Array.isArray(input.arguments)
        ? (input.arguments as Record<string, unknown>)
        : {};
    if (name === "")
      return { text: "call_tool needs a tool name.", isError: true };
    if (!this.#declared && name !== "record_topic")
      return { text: DECLARE_FIRST, isError: true };
    if (name === "run_command") {
      const command = String(args.command ?? "");
      const write = gitHistoryWrite(command);
      if (write !== undefined)
        return {
          text: `git ${write} is refused: ${GIT_HISTORY_RULE}`,
          isError: true,
        };
      const refusal = await this.#consent(command);
      if (refusal !== undefined) return { text: refusal, isError: true };
    }
    const result = await this.options.toolbox.call(name, args);
    if (name === "record_topic" && !result.isError) this.#declared = true;
    return result;
  }

  async #execute(call: ToolCall): Promise<ToolOutcome> {
    let result: { text: string; isError: boolean };
    try {
      if (call.name === "search_tools")
        result = await this.#searchTools(call.input);
      else if (call.name === "describe_tool")
        result = await this.#describeTool(call.input);
      else if (call.name === "call_tool")
        result = await this.#callTool(call.input);
      else
        result = {
          text: `There is no tool ${call.name}: use search_tools, describe_tool or call_tool.`,
          isError: true,
        };
    } catch (cause: unknown) {
      result = {
        text: cause instanceof Error ? cause.message : String(cause),
        isError: true,
      };
    }
    return {
      id: call.id,
      content: bounded(result.text, this.options.maxResultChars),
      isError: result.isError,
    };
  }

  async run(): Promise<TurnOutcome> {
    const { session, prompt, maxSteps, onEvent } = this.options;
    session.addUser(prompt);
    let remindedToDeclare = false;
    let answer = "";
    for (let step = 1; step <= maxSteps; step += 1) {
      const turn = await session.complete(AGENT_TOOLS);
      onEvent({ type: "usage", turn });
      if (turn.toolsUnavailable)
        onEvent({
          type: "notice",
          text: "This model can't call tools, so it answers without rene; choose a tool-capable model (such as qwen3) for grounded answers.",
        });
      if (turn.text) {
        answer = turn.text;
        onEvent({ type: "text", text: turn.text });
      }
      if (turn.refusal !== undefined)
        return {
          answer: turn.refusal,
          declared: this.#declared,
          steps: step,
          stopped: "refusal",
        };
      if (turn.toolCalls.length === 0) {
        // Sent back once, as the workbench's Stop hook does.
        if (this.#declared || remindedToDeclare || turn.toolsUnavailable)
          return { answer, declared: this.#declared, steps: step };
        remindedToDeclare = true;
        session.addUser(`${DECLARE_FIRST} Then finish your answer.`);
        continue;
      }
      const outcomes: ToolOutcome[] = [];
      for (const call of turn.toolCalls) {
        onEvent({ type: "tool", call });
        const outcome = await this.#execute(call);
        onEvent({ type: "result", call, outcome });
        outcomes.push(outcome);
      }
      session.addToolResults(outcomes);
    }
    return {
      answer,
      declared: this.#declared,
      steps: maxSteps,
      stopped: "max-steps",
    };
  }
}

/** Runs one request to its answer, or until it takes `maxSteps` replies. */
export const runTurn = (options: TurnOptions): Promise<TurnOutcome> =>
  new TurnRun(options).run();
