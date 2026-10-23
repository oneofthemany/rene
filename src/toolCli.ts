import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";

import {
  Client,
  ReadBuffer,
  serializeMessage,
  type JSONRPCMessage,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle,
} from "@modelcontextprotocol/server/stdio";

import { run } from "./main.js";
import { registerProcessShutdown } from "./main/processShutdown.js";
import type { RuntimeDependencies } from "./main/types.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import {
  createReportSender,
  readReportTarget,
  resultFields,
  type ReportSender,
} from "./toolbox/HistoryReport.js";
import {
  declarationReceipt,
  declaredTopicIds,
  failureReceipt,
  parseCallWords,
} from "./toolbox/ReaCallCommand.js";
import {
  readSavedSettings,
  withSavedProviderSettings,
} from "./toolbox/SavedProviderSettings.js";

/**
 * Explicit command-line access to every REA tool, without an MCP client.
 *
 *   rene tools [search <words…>]    one line per tool: name and summary
 *   rene tools describe <name>      the tool's description and input schema
 *   rene call <name> [<json>|-]     run one tool; arguments as JSON or stdin
 *   rene daemon [--socket <path>] [--exit-with-stdin]
 *                                  keep one session for many calls; with
 *                                  --exit-with-stdin it stops when its
 *                                  stdin closes, so the process that started
 *                                  it owns its lifetime across a container
 *
 * Tools run in the same server composition `rea mcp` serves, so contracts,
 * admission, Evidence and result delivery have one owner. Without
 * REA_DAEMON_SOCKET a call starts that runtime in-process and closes it when
 * the call settles, so targets opened by one call are gone by the next; with
 * it, calls reach a `rene daemon` whose session persists between them.
 */

export interface ToolCliIo {
  readonly env: NodeJS.ProcessEnv;
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly readStdin: () => Promise<string>;
}

const USAGE = `Usage:
  rene tools [search <words…>]    List tools (name and summary)
  rene tools describe <name>      Show a tool's description and input schema
  rene call <name> [<json>|-]     Run one tool; '-' reads the JSON arguments from stdin
  rene call <name> <json> --stdin-field <field>
                                 Run one tool with <field> set to stdin's raw text
                                 (the flag may also come before <json>)
  rene call <name> … --full       Print the whole Evidence envelope; without it
                                 the fields that repeat the call (parameters,
                                 provider, predicate_type) and empty ones are left out
  rene skill status               Show the installed reverse-engineer-anything skill
  rene skill install [--client <id>…]
                                 Install or update the skill: the shared
                                 ~/.agents/skills, every agent folder that
                                 already has it, and each --client named
  rene daemon [--socket <path>] [--exit-with-stdin]
                                 Serve one persistent session on a Unix socket;
                                 --exit-with-stdin stops it when stdin closes

Set REA_DAEMON_SOCKET to send tools and call to a running daemon; without it
each command starts and closes its own session.
`;

/** Signals only: an agent's shell or a background daemon may start with stdin closed. */
const signalShutdownEvents = {
  signals: process,
  stdin: { on: () => undefined, off: () => undefined },
};

const runtimeDependencies = (
  io: ToolCliIo,
  serve: RuntimeDependencies["serve"],
  onShutdown: (request: () => void) => void,
  exitWithStdin = false,
): RuntimeDependencies => ({
  // Per-call info logs would land in the agent's context with every result;
  // an explicit REA_LOG_LEVEL still wins.
  env:
    io.env.REA_LOG_LEVEL === undefined
      ? { ...io.env, REA_LOG_LEVEL: "warn" }
      : io.env,
  serve,
  writeStderr: io.writeStderr,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  registerShutdown: (handler) => {
    onShutdown(handler);
    if (!exitWithStdin)
      return registerProcessShutdown(handler, signalShutdownEvents);
    // stdin only reports its end while it is read; nothing else reads it.
    process.stdin.on("data", () => undefined);
    return registerProcessShutdown(handler);
  },
});

/** A newline-delimited JSON-RPC client transport over a connected socket. */
class SocketClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #socket: Socket;
  readonly #buffer = new ReadBuffer();

  constructor(socket: Socket) {
    this.#socket = socket;
  }

  start(): Promise<void> {
    this.#socket.on("data", (chunk: Buffer) => {
      this.#buffer.append(chunk);
      for (;;) {
        let message: JSONRPCMessage | null;
        try {
          message = this.#buffer.readMessage();
        } catch (cause: unknown) {
          this.onerror?.(
            cause instanceof Error ? cause : new Error(String(cause)),
          );
          return;
        }
        if (message === null) return;
        this.onmessage?.(message);
      }
    });
    this.#socket.on("error", (error) => this.onerror?.(error));
    this.#socket.on("close", () => this.onclose?.());
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.write(serializeMessage(message), (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  close(): Promise<void> {
    this.#buffer.clear();
    this.#socket.end();
    return Promise.resolve();
  }
}

const connectSocket = (path: string): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
    socket.once("error", reject);
  });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Run `action` with a connected client: to the daemon REA_DAEMON_SOCKET names,
 * or to a runtime started in this process and closed when `action` settles.
 */
export const withToolClient = async (
  io: ToolCliIo,
  action: (client: Client) => Promise<number>,
): Promise<number> => {
  const client = new Client({
    name: `${PRODUCT_IDENTITY.cliBinary}-cli`,
    version: PRODUCT_IDENTITY.packageVersion,
  });
  const socketPath = io.env.REA_DAEMON_SOCKET;
  if (socketPath !== undefined && socketPath !== "") {
    let socket: Socket;
    try {
      socket = await connectSocket(socketPath);
    } catch (cause: unknown) {
      io.writeStderr(
        `No REA daemon answers at ${socketPath} (REA_DAEMON_SOCKET): ${errorMessage(cause)}. Start one with 'rene daemon --socket ${socketPath}', or unset REA_DAEMON_SOCKET to run in-process.\n`,
      );
      return 1;
    }
    try {
      await client.connect(new SocketClientTransport(socket));
      return await action(client);
    } finally {
      await client.close().catch(() => undefined);
      socket.destroy();
    }
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let requestShutdown: (() => void) | undefined;
  const started = await run(
    runtimeDependencies(
      io,
      (factory, options) =>
        serveStdio(factory, { ...options, transport: serverTransport }),
      (request) => {
        requestShutdown = request;
      },
    ),
  );
  if (started !== 0) return started;
  try {
    await client.connect(clientTransport);
    return await action(client);
  } finally {
    await client.close().catch(() => undefined);
    requestShutdown?.();
  }
};

const listAllTools = async (client: Client): Promise<readonly Tool[]> => {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
};

/** The description's first sentence, as one line. */
const summary = (tool: Tool): string => {
  const text = (tool.description ?? "").replace(/\s+/g, " ").trim();
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
};

const runTools = async (
  args: readonly string[],
  io: ToolCliIo,
): Promise<number> => {
  const [subcommand, ...rest] = args;
  if (subcommand === "describe") {
    if (rest.length !== 1) {
      io.writeStderr(USAGE);
      return 2;
    }
    const name = rest[0];
    return withToolClient(io, async (client) => {
      const tool = (await listAllTools(client)).find(
        (candidate) => candidate.name === name,
      );
      if (tool === undefined) {
        io.writeStderr(
          `No tool named ${name}. 'rene tools search <words>' finds tools.\n`,
        );
        return 1;
      }
      io.writeStdout(
        `${JSON.stringify({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
          ...(tool.annotations === undefined
            ? {}
            : { annotations: tool.annotations }),
        })}\n`,
      );
      return 0;
    });
  }
  if (subcommand !== undefined && subcommand !== "search") {
    io.writeStderr(USAGE);
    return 2;
  }
  const words = (subcommand === "search" ? rest : []).map((word) =>
    word.toLowerCase(),
  );
  return withToolClient(io, async (client) => {
    const matches = (await listAllTools(client)).filter((tool) => {
      const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
    io.writeStdout(
      matches.map((tool) => `${tool.name}\t${summary(tool)}\n`).join(""),
    );
    return 0;
  });
};

const parseArguments = (
  text: string,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason: string;
    } => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause: unknown) {
    return { ok: false, reason: `not JSON: ${errorMessage(cause)}` };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, reason: "not a JSON object" };
  return { ok: true, value: value as Record<string, unknown> };
};

export type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * What an agent reads of a tool result: its text blocks, as an MCP client
 * shows them, or its structured content when it carries no text.
 */
export const resultText = (result: ToolResult): string => {
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = content.flatMap((block) =>
    block.type === "text" ? [block.text] : [],
  );
  return texts.length > 0
    ? texts.join("\n")
    : JSON.stringify(result.structuredContent ?? result);
};

/** Evidence fields that only repeat the call: its arguments and who answered it. */
const ECHOED_FIELDS = new Set(["parameters", "provider", "predicate_type"]);

const isEmpty = (value: unknown): boolean =>
  value === null || (Array.isArray(value) && value.length === 0);

/**
 * What `rene call` prints of a tool's text: an Evidence envelope without the
 * fields that only repeat the call or hold nothing (null, []), so the agent's
 * context gets the answer with its provenance, confidence, limitations and
 * locations, at about half to two thirds of the bytes. normalized_result is
 * always kept. Anything that isn't Evidence prints as it came; `--full`
 * prints the envelope whole, and history records it whole either way.
 */
export const compactResultText = (text: string): string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { evidence_id?: unknown }).evidence_id !== "string"
  )
    return text;
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).filter(
        ([field, entry]) =>
          field === "normalized_result" ||
          (!ECHOED_FIELDS.has(field) && !isEmpty(entry)),
      ),
    ),
  );
};

/**
 * Whether the SDK refused a call against its tool's input schema: an
 * argument missing, unknown or of the wrong type. A tool's own invalid_input
 * error is about a value (old_text not in the file, a relative path), and
 * its message already says which.
 */
export const isSchemaRefusal = (text: string): boolean =>
  text.startsWith("Input validation error");

type SchemaProperty = {
  readonly type?: unknown;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
};

const propertyForm = (
  name: string,
  property: SchemaProperty,
  required: boolean,
): string => {
  const type =
    property.enum !== undefined
      ? property.enum.join("|")
      : typeof property.type === "string"
        ? property.type
        : "value";
  const notes = [
    type,
    ...(required ? ["required"] : []),
    ...(property.default === undefined
      ? []
      : [`default ${JSON.stringify(property.default)}`]),
  ];
  return `${name} (${notes.join(", ")})`;
};

/**
 * The arguments a tool takes, as one line for a call refused for its
 * arguments: each name with its type, whether it is required and its
 * default, then the schema's first example as a call.
 */
export const argumentForm = (tool: Tool): string => {
  const schema = tool.inputSchema as {
    properties?: Record<string, SchemaProperty>;
    required?: readonly string[];
    examples?: readonly unknown[];
  };
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {}).sort(
    ([a], [b]) => Number(required.has(b)) - Number(required.has(a)),
  );
  const example = schema.examples?.[0];
  return [
    `${tool.name} takes ${properties
      .map(([name, property]) =>
        propertyForm(name, property, required.has(name)),
      )
      .join(", ")}.`,
    ...(example === undefined
      ? []
      : [`For example: rene call ${tool.name} '${JSON.stringify(example)}'.`]),
    `\`rene tools describe ${tool.name}\` shows each argument's meaning.`,
  ].join(" ");
};

const nameWords = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 2)
    // read_files and read_file share both words.
    .map((word) => word.replace(/s$/u, ""));

/**
 * For a tool name nothing answers to: the tools whose names share a word
 * with it, those sharing most first.
 */
export const missingToolHint = (
  name: string,
  tools: readonly Tool[],
): string => {
  const words = new Set(nameWords(name));
  const near = tools
    .map((tool) => ({
      name: tool.name,
      shared: nameWords(tool.name).filter((word) => words.has(word)).length,
    }))
    .filter(({ shared }) => shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 6)
    .map((tool) => tool.name);
  return [
    `No tool is named ${name}.`,
    ...(near.length === 0 ? [] : [`Near it: ${near.join(", ")}.`]),
    "`rene tools search <words>` finds tools.",
  ].join(" ");
};

/** The SDK's refusal of a call to a tool it doesn't have, which it throws. */
const MISSING_TOOL = /\bTool \S+ not found\b/u;

/**
 * The right form, for a call its tool's schema refused; undefined for any
 * other failure, which the tool's own result explains.
 */
const failureHint = async (
  client: Client,
  name: string,
  text: string,
): Promise<string | undefined> => {
  if (!isSchemaRefusal(text)) return undefined;
  const tool = (await listAllTools(client)).find(
    (candidate) => candidate.name === name,
  );
  return tool === undefined ? undefined : argumentForm(tool);
};

/** The wait for a tool that declares no deadline of its own. */
const DEFAULT_CALL_MS = 120_000;
/** Time a call that met its own deadline still needs to report it. */
const DEADLINE_MARGIN_MS = 30_000;
/** The arguments by which a tool takes its deadline. */
const DEADLINE_ARGUMENTS = ["timeout_ms", "analysis_timeout_ms"] as const;

const deadlineIn = (
  values: Readonly<Record<string, unknown>>,
): number | undefined =>
  DEADLINE_ARGUMENTS.map((name) => values[name]).find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value > 0,
  );

/**
 * How long rene call waits for one tool, after which it stops waiting and
 * reports the call as timed out. The tool decides: the deadline the call
 * names (`timeout_ms`, `analysis_timeout_ms`), else the default its schema
 * declares for that argument, else two minutes; plus a margin for a call
 * that met its deadline to report. The wait is fixed: progress from the
 * tool doesn't extend it. (The SDK's own 60 s abandoned longer runs, such as
 * a test suite through run_command, before their deadline.)
 */
export const callTimeoutMs = (
  args: Readonly<Record<string, unknown>>,
  schemaDefaults: Readonly<Record<string, unknown>> = {},
): number => {
  const deadline = deadlineIn(args) ?? deadlineIn(schemaDefaults);
  return deadline === undefined
    ? DEFAULT_CALL_MS
    : deadline + DEADLINE_MARGIN_MS;
};

/**
 * The defaults a tool's input schema declares for its deadline arguments,
 * read only when the call names no deadline itself.
 */
const deadlineDefaults = async (
  client: Client,
  name: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> => {
  if (deadlineIn(args) !== undefined) return {};
  const tool = (await listAllTools(client)).find(
    (candidate) => candidate.name === name,
  );
  const properties = (tool?.inputSchema.properties ?? {}) as Record<
    string,
    { default?: unknown }
  >;
  return Object.fromEntries(
    DEADLINE_ARGUMENTS.map((argument) => [
      argument,
      properties[argument]?.default,
    ]),
  );
};

/**
 * Calls one tool and reports it to the workbench's history, started and
 * settled. A call that throws is reported as failed and rethrown.
 */
export const callRecorded = async (
  client: Client,
  reports: ReportSender | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const ref = `${process.pid}:cli:${Date.now()}:${randomBytes(4).toString("hex")}`;
  const startedAt = Date.now();
  reports?.send({ type: "started", ref, name, args, startedAt });
  let result: ToolResult;
  try {
    const timeout = callTimeoutMs(
      args,
      await deadlineDefaults(client, name, args),
    );
    result = await client.callTool({ name, arguments: args }, { timeout });
  } catch (cause: unknown) {
    reports?.send({
      type: "settled",
      ref,
      outcome: "error",
      failure: errorMessage(cause),
      elapsedMs: Date.now() - startedAt,
    });
    throw cause;
  }
  reports?.send({
    type: "settled",
    ref,
    outcome: result.isError === true ? "error" : "ok",
    ...resultFields(result),
    elapsedMs: Date.now() - startedAt,
  });
  return result;
};

/**
 * The workbench's history reporter when the agent's session names one with
 * REA_HISTORY_REPORT; calls are recorded as the MCP relay records them.
 */
export const historyReports = (io: ToolCliIo): ReportSender | undefined => {
  const path = io.env.REA_HISTORY_REPORT;
  if (path === undefined || path === "") return undefined;
  const target = readReportTarget(path);
  if (!target.ok) {
    io.writeStderr(
      `rene call: ${target.reason}; the call won't be recorded.\n`,
    );
    return undefined;
  }
  return createReportSender(target.target, io.writeStderr, "rene call");
};

const runCall = async (
  args: readonly string[],
  io: ToolCliIo,
): Promise<number> => {
  // --stdin-field <field>: that field's value is stdin's raw text, so long
  // or multi-line text (a file's content, a script) needs no JSON escaping.
  const call = parseCallWords(args);
  if (call === undefined) {
    io.writeStderr(USAGE);
    return 2;
  }
  const { tool: name, input, stdinField, full } = call;
  const text =
    input === undefined ? "{}" : input === "-" ? await io.readStdin() : input;
  const parsed = parseArguments(text);
  if (!parsed.ok) {
    io.writeStderr(`The arguments for ${name} are ${parsed.reason}.\n`);
    return 2;
  }
  const callArgs =
    stdinField === undefined
      ? parsed.value
      : { ...parsed.value, [stdinField]: await io.readStdin() };
  const reports = historyReports(io);
  return withToolClient(io, async (client) => {
    let result: ToolResult;
    try {
      result = await callRecorded(client, reports, name, callArgs);
    } catch (cause: unknown) {
      if (!MISSING_TOOL.test(errorMessage(cause))) throw cause;
      await reports?.drain();
      io.writeStderr(
        `${errorMessage(cause)}\n${failureReceipt(name)}${missingToolHint(name, await listAllTools(client))}\n`,
      );
      return 1;
    }
    await reports?.drain();
    const text = resultText(result);
    io.writeStdout(`${full ? text : compactResultText(text)}\n`);
    // A receipt on stderr, which a filter on stdout (jq, head) leaves alone,
    // so the workbench's topic gate sees the declaration either way.
    if (name === "record_topic" && result.isError !== true)
      for (const id of declaredTopicIds(text))
        io.writeStderr(declarationReceipt(id));
    // A pipe (`| jq`, `| head`) hides the exit status from the agent's shell
    // and from the transcript; this line, on stderr, survives it.
    if (result.isError !== true) return 0;
    io.writeStderr(failureReceipt(name));
    // On stderr too, so a filter on stdout leaves the fix in view.
    const hint = await failureHint(client, name, text);
    if (hint !== undefined) io.writeStderr(`${hint}\n`);
    return 1;
  });
};

/** Remove a socket file no daemon answers on; refuse one that is live. */
const clearStaleSocket = async (path: string): Promise<boolean> => {
  if (!existsSync(path)) return true;
  try {
    (await connectSocket(path)).destroy();
    return false;
  } catch {
    unlinkSync(path);
    return true;
  }
};

const runDaemon = async (
  args: readonly string[],
  io: ToolCliIo,
): Promise<number> => {
  let socketPath = io.env.REA_DAEMON_SOCKET;
  let exitWithStdin = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--socket" && args[index + 1] !== undefined) {
      socketPath = args[index + 1];
      index += 1;
    } else if (args[index] === "--exit-with-stdin") exitWithStdin = true;
    else {
      io.writeStderr(USAGE);
      return 2;
    }
  }
  if (socketPath === undefined || socketPath === "") {
    io.writeStderr(
      "rene daemon needs a socket path: --socket <path> or REA_DAEMON_SOCKET.\n",
    );
    return 2;
  }
  const path = socketPath;
  if (!(await clearStaleSocket(path))) {
    io.writeStderr(`A REA daemon already answers at ${path}.\n`);
    return 1;
  }
  const serve: RuntimeDependencies["serve"] = (factory, options) => {
    // Every connection is served from the same factory, so all of them share
    // the runtime's one BinarySession and its opened targets.
    const connections = new Set<StdioServerHandle>();
    const listener = createServer((socket) => {
      const handle = serveStdio(factory, {
        ...options,
        transport: new StdioServerTransport(socket, socket),
      });
      connections.add(handle);
      socket.once("close", () => {
        connections.delete(handle);
        void handle.close().catch(() => undefined);
      });
    });
    listener.on("error", (error) => {
      options?.onerror?.(error);
      io.writeStderr(`REA daemon socket failed: ${error.message}\n`);
    });
    listener.listen(path, () => {
      void chmod(path, 0o600).then(
        () => io.writeStderr(`REA daemon listening on ${path}\n`),
        (error: unknown) =>
          io.writeStderr(
            `REA daemon could not restrict ${path}: ${errorMessage(error)}\n`,
          ),
      );
    });
    return {
      close: async () => {
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        const results = await Promise.allSettled(
          [...connections].map((handle) => handle.close()),
        );
        if (existsSync(path)) unlinkSync(path);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0)
          throw new AggregateError(failures, "REA daemon cleanup failed");
      },
    };
  };
  return run(runtimeDependencies(io, serve, () => undefined, exitWithStdin));
};

/** Run `rene tools`, `rene call` or `rene daemon` and return the exit status. */
export const runToolCli = async (
  args: readonly string[],
  io: ToolCliIo,
): Promise<number> => {
  const [command, ...rest] = args;
  if (rest.includes("--help") || rest.includes("-h")) {
    io.writeStdout(USAGE);
    return 0;
  }
  try {
    if (command === "tools") return await runTools(rest, io);
    if (command === "call") return await runCall(rest, io);
    if (command === "daemon") return await runDaemon(rest, io);
    if (command === "skill") return await runSkill(rest, io);
  } catch (cause: unknown) {
    io.writeStderr(`${errorMessage(cause)}\n`);
    return 1;
  }
  io.writeStderr(USAGE);
  return 2;
};

/**
 * `io` with the provider paths the workbench saved, for each variable its
 * environment doesn't set: the file REA_WORKBENCH_SETTINGS names (an agent
 * session's bridge sets it), or `defaultPath`, the checkout's own. rene run
 * by hand then finds the providers the workbench was told about. A file that
 * can't be read costs one line on stderr and applies nothing.
 */
export const withWorkbenchSettings = (
  io: ToolCliIo,
  defaultPath: string,
): ToolCliIo => {
  const path = io.env.REA_WORKBENCH_SETTINGS || defaultPath;
  const saved = readSavedSettings(path);
  if (!saved.ok) {
    io.writeStderr(
      `rene: ${path} could not be read (${saved.reason}); saved provider paths aren't applied.\n`,
    );
    return io;
  }
  return { ...io, env: withSavedProviderSettings(io.env, saved.environment) };
};

/**
 * `rene skill status|install`: the reverse-engineer-anything skill for the
 * agents on this machine, through setup's skill installer (atomic writes,
 * backups and rollback), which outlives `rea setup`. The installer and the
 * agents' skill folders load only for this command.
 */
const runSkill = async (
  args: readonly string[],
  io: ToolCliIo,
): Promise<number> => {
  const [action, ...rest] = args;
  const clients: string[] = [];
  for (let at = 0; at < rest.length; at += 2) {
    const client = rest[at + 1];
    if (rest[at] !== "--client" || client === undefined) {
      io.writeStderr(USAGE);
      return 2;
    }
    clients.push(client);
  }
  if (
    (action !== "status" && action !== "install") ||
    (action === "status" && clients.length > 0)
  ) {
    io.writeStderr(USAGE);
    return 2;
  }
  const [skill, { clientSkillDirectories }, { homeDirectoryFromEnvironment }] =
    await Promise.all([
      import("./application/SetupSkill.js"),
      import("./application/SupportedClients.js"),
      import("./config/homeDirectory.js"),
    ]);
  const home = homeDirectoryFromEnvironment(io.env, process.platform);
  const known = new Set(
    clientSkillDirectories(home, undefined, io.env).map(({ client }) => client),
  );
  const unknown = clients.filter((client) => !known.has(client));
  if (unknown.length > 0) {
    io.writeStderr(
      `rene skill: no skill folder is known for ${unknown.join(", ")}; choose from ${[...known].join(", ")}.\n`,
    );
    return 2;
  }
  const existing = await skill.existingSkillDestinations(home, io.env);
  const status = async () => {
    const identity = await skill.readInstalledSkillIdentity(
      home,
      undefined,
      io.env,
    );
    return {
      installed: identity !== undefined,
      version: identity?.version ?? null,
      tool_count: identity?.toolCount ?? null,
      // Whether every installed copy matches this build's skill.
      current: identity?.canonical ?? false,
      issues: identity?.issues ?? [],
      destinations: (await skill.existingSkillDestinations(home, io.env)).map(
        ({ client, path }) => ({ client, path }),
      ),
      // Every skill folder install --client can name, with where it is.
      folders: clientSkillDirectories(home, undefined, io.env).map(
        ({ client, directory }) => ({ client, directory }),
      ),
    };
  };
  if (action === "status") {
    io.writeStdout(`${JSON.stringify(await status(), null, 2)}\n`);
    return 0;
  }
  const targets = [
    ...new Set(["shared", ...existing.map(({ client }) => client), ...clients]),
  ];
  const installed = await skill.installCanonicalSkill(home, targets, io.env);
  if (!installed.ok) {
    io.writeStderr(`rene skill: ${installed.error.message}\n`);
    return 1;
  }
  io.writeStdout(
    `${JSON.stringify({ result: installed.value, ...(await status()) }, null, 2)}\n`,
  );
  return 0;
};

/** Read all of standard input as UTF-8. */
export const readProcessStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
