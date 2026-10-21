import Anthropic from "@anthropic-ai/sdk";

/**
 * The models `rene agent` can run on, behind one shape so its loop doesn't
 * depend on any of them (a port of sherloq's maicroft provider layer):
 *
 *   local      a model server on this machine with an OpenAI-compatible
 *              chat-completions endpoint: LiteLLM in front of Ollama by
 *              default (http://localhost:4000/v1), or Ollama, llama.cpp or
 *              LM Studio directly through RENE_AGENT_BASE_URL.
 *   openai     a cloud OpenAI-compatible endpoint (OpenAI, OpenRouter, …):
 *              OPENAI_BASE_URL and OPENAI_API_KEY.
 *   anthropic  Claude through the Anthropic API, with its official SDK; it
 *              finds credentials as the SDK does (ANTHROPIC_API_KEY, …).
 *
 * Tools are defined once in a neutral shape; each provider converts them and
 * its replies to the neutral Turn. Local models need their own handling,
 * learned in maicroft: chat templates that don't render the tool role, so
 * tool calls and results go back as plain text; a context window sized to
 * the conversation; long results trimmed to leave room for the answer; and
 * models without tool calling answered tool-free rather than failing.
 */

export const PROVIDERS = ["local", "openai", "anthropic"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Readonly<Record<ProviderName, string>> = {
  // Tool-capable, so answers stay grounded in tool results.
  local: "qwen3",
  openai: "gpt-5.5",
  anthropic: "claude-opus-5-5",
};

/** A tool as the agent defines it, before any provider's format. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

export interface ToolOutcome {
  readonly id: string;
  readonly content: string;
  readonly isError: boolean;
}

/** One model reply, whatever produced it. */
export interface Turn {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** The provider's own stop reason, kept as it said it. */
  readonly stopReason: string | null;
  /** Set when the model declined the request. */
  readonly refusal?: string;
  readonly usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
  };
  /** Set when the model can't call tools and answered without them. */
  readonly toolsUnavailable?: boolean;
}

/** One conversation with a model; it keeps its own message history. */
export interface ProviderSession {
  addUser(text: string): void;
  /** Ask the model for its next turn; the turn joins the history. */
  complete(tools: readonly ToolSpec[]): Promise<Turn>;
  addToolResults(results: readonly ToolOutcome[]): void;
}

export interface Provider {
  readonly name: ProviderName;
  readonly model: string;
  /** Characters of a tool result the agent passes back to this model. */
  readonly maxResultChars: number;
  start(system: string): ProviderSession;
}

export class ProviderError extends Error {}

const MAX_OUTPUT_TOKENS = 16_000;
const LOCAL_DEFAULT_BASE_URL = "http://localhost:4000/v1";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
// LiteLLM's fixed key for the local stack (maicroft's pycroft/llm config).
const LOCAL_DEFAULT_KEY = "sk-local";

// ---------------------------------------------------------------------------
// OpenAI-compatible chat completions (local and cloud)

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface ChatOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Local models: tool traffic as text, a sized window, trimmed prompts. */
  readonly local: boolean;
  readonly maxContextTokens: number;
  readonly fetch: typeof fetch;
}

// The context window grows in coarse steps, so a local model reloads only
// when the conversation really needs more (Ollama defaults to 4096, which a
// prompt with tool schemas and one result overflows).
const CONTEXT_STEPS = [8192, 16384, 32768, 65536, 131072];
const OUTPUT_RESERVE_TOKENS = 2048;
// ~4 characters a token, plus the tool schemas sent beside the messages.
const approximateTokens = (messages: readonly ChatMessage[]) =>
  Math.ceil(
    messages.reduce(
      (sum, message) => sum + JSON.stringify(message.content ?? "").length,
      0,
    ) / 4,
  ) + 1200;

/**
 * Trims the largest messages between the system prompt and the newest one
 * (usually old tool results) from their middle, so the prompt leaves room
 * for the answer within `window`.
 */
const fitMessages = (messages: ChatMessage[], window: number) => {
  const budget = Math.max(window - OUTPUT_RESERVE_TOKENS, 1024);
  for (let guard = 0; guard < 64; guard += 1) {
    const over = approximateTokens(messages) - budget;
    if (over <= 0) return;
    let largest = -1;
    let size = 0;
    for (let index = 1; index < messages.length; index += 1) {
      const content = messages[index]?.content;
      if (typeof content === "string" && content.length > size) {
        size = content.length;
        largest = index;
      }
    }
    if (largest < 0 || size < 400) return;
    const message = messages[largest] as { content: string };
    const cut = Math.min(size - 200, over * 4 + 200);
    const head = Math.floor((size - cut) / 2);
    message.content = `${message.content.slice(0, head)}\n…[${cut} characters trimmed to fit the context window]…\n${message.content.slice(size - (size - cut - head))}`;
  }
};

const contextWindow = (messages: readonly ChatMessage[], cap: number) => {
  const wanted = approximateTokens(messages) + OUTPUT_RESERVE_TOKENS;
  const step =
    CONTEXT_STEPS.find((size) => size >= wanted) ??
    (CONTEXT_STEPS[CONTEXT_STEPS.length - 1] as number);
  return Math.min(step, cap);
};

const parseArguments = (text: string | undefined) => {
  try {
    const value: unknown = JSON.parse(text || "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

interface ChatResponse {
  choices?: {
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Strips a reasoning model's <think>…</think> from the answer it shows. */
const withoutThinking = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();

class ChatSession implements ProviderSession {
  readonly #options: ChatOptions;
  readonly #messages: ChatMessage[];
  #toolsUnavailable = false;

  constructor(options: ChatOptions, system: string) {
    this.#options = options;
    this.#messages = [{ role: "system", content: system }];
  }

  addUser(text: string) {
    this.#messages.push({ role: "user", content: text });
  }

  async #post(body: Record<string, unknown>): Promise<ChatResponse> {
    const { baseUrl, apiKey, fetch: send } = this.#options;
    let response: Response;
    try {
      response = await send(
        `${baseUrl.replace(/\/+$/u, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        },
      );
    } catch (cause: unknown) {
      throw new ProviderError(
        `The model server at ${baseUrl} isn't reachable (${cause instanceof Error ? cause.message : String(cause)}).${this.#options.local ? " Start the local model server (LiteLLM/Ollama), or point RENE_AGENT_BASE_URL at it." : ""}`,
      );
    }
    const text = await response.text();
    let parsed: ChatResponse = {};
    try {
      parsed = JSON.parse(text) as ChatResponse;
    } catch {
      // Reported below with the raw text.
    }
    if (!response.ok)
      throw new ProviderError(
        `The model server answered ${response.status}: ${parsed.error?.message ?? text.slice(0, 500)}`,
      );
    return parsed;
  }

  async complete(tools: readonly ToolSpec[]): Promise<Turn> {
    const { model, local, maxContextTokens } = this.#options;
    const body: Record<string, unknown> = {
      model,
      messages: this.#messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (local) {
      const window = contextWindow(this.#messages, maxContextTokens);
      fitMessages(this.#messages, window);
      // LiteLLM passes num_ctx on to Ollama; other servers ignore it.
      body.num_ctx = window;
    }
    const withTools = tools.length > 0 && !this.#toolsUnavailable;
    if (withTools) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema,
        },
      }));
      body.tool_choice = "auto";
    }
    let response: ChatResponse;
    try {
      response = await this.#post(body);
    } catch (cause: unknown) {
      // Some local models can't call tools (Ollama: "does not support
      // tools"); answer without them rather than fail the turn.
      if (!withTools || !/does not support tools/iu.test(String(cause)))
        throw cause;
      this.#toolsUnavailable = true;
      delete body.tools;
      delete body.tool_choice;
      response = await this.#post(body);
    }
    const choice = response.choices?.[0];
    const message = choice?.message ?? {};
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map(
      (call, index) => ({
        id: call.id ?? `call_${this.#messages.length}_${index}`,
        name: call.function?.name ?? "",
        input: parseArguments(call.function?.arguments),
      }),
    );
    const text = withoutThinking(message.content ?? "");
    this.#appendAssistant(text, toolCalls);
    return {
      text,
      toolCalls,
      stopReason: choice?.finish_reason ?? null,
      usage: {
        ...(response.usage?.prompt_tokens === undefined
          ? {}
          : { inputTokens: response.usage.prompt_tokens }),
        ...(response.usage?.completion_tokens === undefined
          ? {}
          : { outputTokens: response.usage.completion_tokens }),
      },
      ...(this.#toolsUnavailable ? { toolsUnavailable: true } : {}),
    };
  }

  #appendAssistant(text: string, toolCalls: readonly ToolCall[]) {
    if (this.#options.local) {
      // Local chat templates often drop structured tool calls; as text the
      // model sees what it asked for.
      const calls = toolCalls.map(
        (call) => `[Called tool ${call.name}(${JSON.stringify(call.input)})]`,
      );
      this.#messages.push({
        role: "assistant",
        content: [text, ...calls].filter(Boolean).join("\n") || "(working)",
      });
      return;
    }
    this.#messages.push({
      role: "assistant",
      content: text || null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: {
                name: call.name,
                arguments: JSON.stringify(call.input),
              },
            })),
          }
        : {}),
    });
  }

  addToolResults(results: readonly ToolOutcome[]) {
    if (this.#options.local) {
      // The user role is the one local templates always render.
      this.#messages.push({
        role: "user",
        content: results
          .map(
            (result) =>
              `Result of the tool call${result.isError ? " (failed)" : ""}:\n${result.content}`,
          )
          .join("\n\n"),
      });
      return;
    }
    for (const result of results)
      this.#messages.push({
        role: "tool",
        tool_call_id: result.id,
        content: result.isError ? `Error: ${result.content}` : result.content,
      });
  }
}

// ---------------------------------------------------------------------------
// Claude, through the Anthropic SDK

// Models that take adaptive thinking and effort, and those that take the
// server-side refusal fallback with "default" routing.
const ADAPTIVE_MODELS =
  /^claude-(?:fable-5|mythos-5|opus-5|sonnet-5|haiku-5-5|opus-4-[6-9]|sonnet-4-6)/u;
const FALLBACK_MODELS = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

class ClaudeSession implements ProviderSession {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #system: string;
  readonly #messages: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(client: Anthropic, model: string, system: string) {
    this.#client = client;
    this.#model = model;
    this.#system = system;
  }

  addUser(text: string) {
    this.#messages.push({ role: "user", content: text });
  }

  async complete(tools: readonly ToolSpec[]): Promise<Turn> {
    const adaptive = ADAPTIVE_MODELS.test(this.#model);
    const fallback = FALLBACK_MODELS.has(this.#model);
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.#client.beta.messages.create({
        model: this.#model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The prefix (tools, then this system prompt) is the same on every
        // request of a session, so it is cached.
        system: [
          {
            type: "text",
            text: this.#system,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema:
            tool.input_schema as Anthropic.Beta.BetaTool.InputSchema,
        })),
        messages: this.#messages,
        ...(adaptive
          ? {
              thinking: { type: "adaptive" as const },
              output_config: { effort: "high" as const },
            }
          : {}),
        ...(fallback
          ? {
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default" as const,
            }
          : {}),
      });
    } catch (cause: unknown) {
      if (cause instanceof Anthropic.AuthenticationError)
        throw new ProviderError(
          "The Anthropic API refused the credentials: set ANTHROPIC_API_KEY, or log in with `ant auth login`.",
        );
      if (cause instanceof Anthropic.RateLimitError)
        throw new ProviderError(
          `The Anthropic API is rate limiting this account: ${cause.message}`,
        );
      if (cause instanceof Anthropic.APIError)
        throw new ProviderError(
          `The Anthropic API answered ${cause.status ?? "with an error"}: ${cause.message}`,
        );
      throw cause;
    }
    // The whole content goes back, thinking blocks included.
    this.#messages.push({ role: "assistant", content: response.content });
    const text = response.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
      .trim();
    const toolCalls = response.content.flatMap((block) =>
      block.type === "tool_use"
        ? [
            {
              id: block.id,
              name: block.name,
              input: (block.input ?? {}) as Record<string, unknown>,
            },
          ]
        : [],
    );
    const refusal =
      response.stop_reason === "refusal"
        ? (response.stop_details?.explanation ?? "The model declined.")
        : undefined;
    return {
      text,
      toolCalls,
      stopReason: response.stop_reason,
      ...(refusal === undefined ? {} : { refusal }),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ...(response.usage.cache_read_input_tokens == null
          ? {}
          : { cacheReadTokens: response.usage.cache_read_input_tokens }),
      },
    };
  }

  addToolResults(results: readonly ToolOutcome[]) {
    // All results of one turn go back in one message.
    this.#messages.push({
      role: "user",
      content: results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.id,
        content: result.content,
        is_error: result.isError,
      })),
    });
  }
}

// ---------------------------------------------------------------------------

export interface ProviderSettings {
  readonly provider?: string;
  readonly model?: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}

const positiveInteger = (text: string | undefined, fallback: number) => {
  const value = Number.parseInt(text ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/**
 * The provider a run asked for: --provider and --model, else
 * RENE_AGENT_PROVIDER and RENE_AGENT_MODEL, else the local default.
 */
export const createProvider = (settings: ProviderSettings): Provider => {
  const { env } = settings;
  const name = (settings.provider ?? env.RENE_AGENT_PROVIDER ?? "local")
    .trim()
    .toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(name))
    throw new ProviderError(
      `Unknown provider ${name}: choose ${PROVIDERS.join(", ")}.`,
    );
  const provider = name as ProviderName;
  const model =
    (settings.model ?? env.RENE_AGENT_MODEL ?? "").trim() ||
    DEFAULT_MODELS[provider];
  if (provider === "anthropic") {
    const client = new Anthropic();
    return {
      name: provider,
      model,
      maxResultChars: positiveInteger(env.RENE_AGENT_MAX_RESULT_CHARS, 100_000),
      start: (system) => new ClaudeSession(client, model, system),
    };
  }
  const local = provider === "local";
  const apiKey = local
    ? env.RENE_AGENT_API_KEY || LOCAL_DEFAULT_KEY
    : env.OPENAI_API_KEY;
  if (!apiKey)
    throw new ProviderError(
      "The openai provider needs OPENAI_API_KEY (and OPENAI_BASE_URL for an endpoint other than OpenAI's).",
    );
  const options: ChatOptions = {
    baseUrl: local
      ? env.RENE_AGENT_BASE_URL || LOCAL_DEFAULT_BASE_URL
      : env.OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL,
    apiKey,
    model,
    local,
    maxContextTokens: positiveInteger(env.RENE_AGENT_NUM_CTX_MAX, 16_384),
    fetch: settings.fetch ?? fetch,
  };
  return {
    name: provider,
    model,
    // A small local window can't take a large result whole.
    maxResultChars: positiveInteger(
      env.RENE_AGENT_MAX_RESULT_CHARS,
      local ? 24_000 : 100_000,
    ),
    start: (system) => new ChatSession(options, system),
  };
};
