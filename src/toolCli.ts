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
} from "./toolbox/ReaCallCommand.js";

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

/**
 * Calls one tool and reports it to the workbench's history, started and
 * settled, as the MCP relay reports the calls it sees. A call that throws is
 * reported as failed and rethrown.
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
    result = await client.callTool({ name, arguments: args });
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
  const [name, input, ...extra] = args;
  // --stdin-field <field>: that field's value is stdin's raw text, so long
  // or multi-line text (a file's content, a script) needs no JSON escaping.
  const stdinField =
    extra.length === 2 && extra[0] === "--stdin-field" ? extra[1] : undefined;
  if (
    name === undefined ||
    (extra.length > 0 && stdinField === undefined) ||
    (stdinField !== undefined && (input === undefined || input === "-"))
  ) {
    io.writeStderr(USAGE);
    return 2;
  }
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
    const result = await callRecorded(client, reports, name, callArgs);
    await reports?.drain();
    io.writeStdout(`${resultText(result)}\n`);
    // A receipt on stderr, which a filter on stdout (jq, head) leaves alone,
    // so the workbench's topic gate sees the declaration either way.
    if (name === "record_topic" && result.isError !== true)
      for (const id of declaredTopicIds(resultText(result)))
        io.writeStderr(declarationReceipt(id));
    return result.isError === true ? 1 : 0;
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
  } catch (cause: unknown) {
    io.writeStderr(`${errorMessage(cause)}\n`);
    return 1;
  }
  io.writeStderr(USAGE);
  return 2;
};

/** Read all of standard input as UTF-8. */
export const readProcessStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
};
