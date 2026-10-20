import { Client } from "@modelcontextprotocol/client";
import { statSync } from "node:fs";
import { join } from "node:path";

import {
  OwnedMcpTransport,
  type OwnedMcpLauncher,
} from "../process/OwnedMcpTransport.js";
import {
  codeGraphEnvironment,
  type CodeGraphInstall,
} from "./CodeGraphConfiguration.js";

/** How long a project's server stays up after its last call. */
export const CODEGRAPH_IDLE_MS = 5 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

/** CodeGraph's answer to one tool call: its text and whether it reported failure. */
export interface CodeGraphReply {
  readonly text: string;
  readonly isError: boolean;
}

/**
 * The identity (device and inode) of a project's index database, or
 * undefined when it can't be read. A build replaces the file, so a changed
 * identity means a server opened before it reads the old, deleted index.
 */
const databaseIdentity = (root: string): string | undefined => {
  try {
    const stats = statSync(join(root, ".codegraph", "codegraph.db"));
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
};

interface Session {
  readonly root: string;
  readonly install: CodeGraphInstall;
  /** The index database the server opened (databaseIdentity at its start). */
  readonly database: string | undefined;
  readonly transport: OwnedMcpTransport;
  readonly client: Client;
  connected: boolean;
  /** Calls run one at a time; each waits for the one before. */
  queue: Promise<unknown>;
  idle: NodeJS.Timeout | undefined;
  closing: Promise<void> | undefined;
}

const replyText = (response: unknown): CodeGraphReply => {
  const record =
    typeof response === "object" && response !== null
      ? (response as { content?: unknown; isError?: unknown })
      : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
  return { text, isError: record.isError === true };
};

/**
 * One warm CodeGraph MCP server per project folder, run as a REA-owned child
 * (`codegraph serve --mcp --path <root>` in direct, read-only mode: no shared
 * daemon, no file watcher, no writer lock, so other REA processes can query
 * the same project at once). A server starts on its project's first call,
 * answers its calls one at a time, and stops after CODEGRAPH_IDLE_MS without
 * calls, when the project is re-indexed (here, or by another process that
 * rebuilt its database), or when REA closes. A cancelled call stops its
 * server, so the next call starts a fresh one. A server whose cleanup
 * couldn't be confirmed is kept and stopped again on the next close.
 */
export class CodeGraphSessions {
  readonly #sessions = new Map<string, Session>();
  readonly #retained = new Set<Session>();

  constructor(
    readonly environment: Readonly<Record<string, string | undefined>>,
    readonly launcher?: OwnedMcpLauncher,
    readonly idleMs: number = CODEGRAPH_IDLE_MS,
  ) {}

  /** Calls one CodeGraph tool on the project's server. */
  call(
    install: CodeGraphInstall,
    root: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<CodeGraphReply> {
    const session = this.#session(install, root);
    const run = session.queue.then(() =>
      this.#call(session, tool, args, options),
    );
    session.queue = run.catch(() => undefined);
    return run;
  }

  /** Stops the project's server, if one is running (before re-indexing). */
  async closeProject(root: string): Promise<void> {
    const session = this.#sessions.get(root);
    if (session !== undefined) await this.#close(session);
  }

  /** Stops every server, retrying those whose cleanup failed before. */
  async close(): Promise<void> {
    const sessions = [...this.#sessions.values(), ...this.#retained];
    const results = await Promise.allSettled(
      sessions.map((session) => this.#close(session)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }

  #session(install: CodeGraphInstall, root: string): Session {
    const existing = this.#sessions.get(root);
    const database = databaseIdentity(root);
    // A server started from another install, or on an index another process
    // has since rebuilt (servers are read-only and never see that), is
    // replaced, not reused.
    if (
      existing !== undefined &&
      existing.closing === undefined &&
      existing.install.cli === install.cli &&
      existing.database === database
    )
      return existing;
    if (existing !== undefined) void this.#close(existing).catch(() => {});
    const transport = new OwnedMcpTransport(
      { id: "codegraph", label: "CodeGraph" },
      {
        command: process.execPath,
        arguments: [
          install.cli,
          "serve",
          "--mcp",
          "--no-watch",
          "--path",
          root,
        ],
        cwd: root,
        hostEnvironment: codeGraphEnvironment(this.environment),
      },
      this.launcher,
    );
    const session: Session = {
      root,
      install,
      database,
      transport,
      client: new Client({ name: "rea-codegraph-adapter", version: "1" }),
      connected: false,
      queue: Promise.resolve(),
      idle: undefined,
      closing: undefined,
    };
    // A server that exits on its own still goes through the owned close, so
    // its process group and pipes are released; the next call starts anew.
    transport.onclose = () => {
      void this.#close(session).catch(() => {});
    };
    this.#sessions.set(root, session);
    return session;
  }

  async #call(
    session: Session,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly timeoutMs: number;
    },
  ): Promise<CodeGraphReply> {
    const { signal, timeoutMs } = options;
    if (session.closing !== undefined)
      throw new Error("The CodeGraph server stopped before this call ran.");
    clearTimeout(session.idle);
    const abort = () => {
      void this.#close(session, signal?.reason).catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      session.transport.beginOperation();
      if (!session.connected) {
        await session.client.connect(session.transport, {
          timeout: CONNECT_TIMEOUT_MS,
        });
        session.connected = true;
      }
      const response = await session.client.callTool(
        { name: tool, arguments: { ...args } },
        signal === undefined
          ? { timeout: timeoutMs }
          : { timeout: timeoutMs, signal },
      );
      return replyText(response);
    } catch (cause: unknown) {
      // A server left mid-request can't be trusted with the next one.
      await this.#close(session, cause).catch(() => {});
      throw cause;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (session.closing === undefined) {
        session.idle = setTimeout(() => {
          void this.#close(session).catch(() => {});
        }, this.idleMs);
        session.idle.unref();
      }
    }
  }

  /** Stops one server; a failed cleanup keeps it for the next close. */
  #close(session: Session, reason?: unknown): Promise<void> {
    if (this.#sessions.get(session.root) === session)
      this.#sessions.delete(session.root);
    clearTimeout(session.idle);
    session.closing ??= (async () => {
      try {
        if (reason !== undefined) await session.transport.interrupt(reason);
        else
          await session.client.close().catch(() => {
            // The transport's own close below still proves the process exited.
          });
        await session.transport.close();
        this.#retained.delete(session);
      } catch (cause: unknown) {
        this.#retained.add(session);
        session.closing = undefined;
        throw cause;
      }
    })();
    return session.closing;
  }
}
