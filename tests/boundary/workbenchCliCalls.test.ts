import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { claudeTranscriptFolder } from "../../src/toolbox/AgentConversations.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

// An agent that reaches rene through `rene call` in its shell, not MCP: the
// workbench's capture (frontend/conversations.mjs) reads the shell tool use
// as the rene tool it ran and ties it to the call `rene call` recorded.

interface StoredEvent {
  readonly kind: string;
  readonly tool?: string;
  readonly rea?: boolean;
  readonly args?: unknown;
  readonly historyId?: string | null;
}
interface Meta {
  readonly session: string;
  readonly agent: string;
}
interface Store {
  sessions(): Promise<Meta[]>;
  events(session: string): Promise<StoredEvent[]>;
  meta(session: string): Promise<Record<string, unknown> | undefined>;
  writeMeta(meta: Record<string, unknown>): Promise<void>;
  append(session: string, events: readonly unknown[]): Promise<void>;
}
const conversations = (await import(
  new URL("../../frontend/conversations.mjs", import.meta.url).href
)) as {
  createConversationStore(directory: string): Store;
  followConversations(options: {
    store: Store;
    environment: Record<string, string>;
    folder: string;
    since: number;
  }): { stop(): Promise<void> };
  conversationTurns(
    meta: Meta,
    events: readonly StoredEvent[],
    history: readonly Record<string, unknown>[],
  ): { events: readonly StoredEvent[] }[];
};

const jsonLines = (records: readonly unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

const bash = (id: string, command: string) => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command, description: "Run a rene tool" },
});

it("reads rene call shell commands as rene tool uses and links them to recorded calls", async () => {
  const root = await createTestTempDirectory("rea-workbench-cli-calls-");
  const project = join(root, "project");
  await mkdir(project);
  const environment = {
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    COPILOT_HOME: join(root, "copilot"),
  };
  const since = Date.now() - 60_000;
  const at = new Date(since + 1_000).toISOString();
  const usedAt = Date.parse(at);

  const claude = claudeTranscriptFolder(environment, project);
  await mkdir(claude, { recursive: true });
  await writeFile(
    join(claude, "s1.jsonl"),
    jsonLines([
      { type: "user", timestamp: at, message: { content: "read it" } },
      {
        type: "assistant",
        timestamp: at,
        message: {
          content: [
            // Two calls on one line: each is its own rene tool use.
            bash(
              "a",
              `rene call read_file '{"path":"/x"}' | head -c 400; rene call search_text '{"query":"q"}'`,
            ),
            bash(
              "b",
              `rene call record_topic - <<'EOF'\n{"kind":"thread"}\nEOF`,
            ),
            bash("c", "ls -la"),
          ],
        },
      },
    ]),
  );
  const copilot = join(environment.COPILOT_HOME, "session-state", "c1");
  await mkdir(copilot, { recursive: true });
  await writeFile(join(copilot, "workspace.yaml"), `id: c1\ncwd: ${project}\n`);
  await writeFile(
    join(copilot, "events.jsonl"),
    jsonLines([
      { type: "user.message", timestamp: at, data: { content: "search" } },
      {
        type: "tool.execution_start",
        timestamp: at,
        data: {
          toolCallId: "d",
          toolName: "bash",
          arguments: { command: `rene call search_text '{"query":"q"}'` },
        },
      },
    ]),
  );

  const store = conversations.createConversationStore(join(root, "store"));
  await conversations
    .followConversations({ store, environment, folder: project, since })
    .stop();

  const uses = async (session: string) =>
    (await store.events(session))
      .filter(({ kind }) => kind === "tool_use")
      .map(({ tool, rea, args }) => [tool, rea, args]);
  const s1Uses = [
    ["read_file", true, { path: "/x" }],
    ["search_text", true, { query: "q" }],
    ["record_topic", true, null],
    ["Bash", false, undefined],
  ];
  expect(await uses("s1")).toEqual(s1Uses);
  expect(await uses("c1")).toEqual([["search_text", true, { query: "q" }]]);

  // Known arguments must match; unknown ones (stdin) match by tool and time.
  const call = (id: string, name: string, args: unknown, offsetMs: number) => ({
    id,
    source: "agent",
    name,
    args,
    startedAt: usedAt + offsetMs,
  });
  const meta = (await store.sessions()).find(
    ({ session }) => session === "s1",
  )!;
  const [turn] = conversations.conversationTurns(
    meta,
    await store.events("s1"),
    [
      call("other-path", "read_file", { path: "/y" }, 200),
      call("read", "read_file", { path: "/x" }, 1_500),
      call("search", "search_text", { query: "q" }, 1_600),
      call("topic", "record_topic", { kind: "thread", title: "T" }, 1_800),
    ],
  );
  expect(
    turn!.events
      .filter(({ kind }) => kind === "tool_use")
      .map(({ historyId }) => historyId),
  ).toEqual(["read", "search", "topic", undefined]);
});

it("reads a stored session again when transcripts are parsed differently", async () => {
  const root = await createTestTempDirectory("rea-workbench-reparse-");
  const project = join(root, "project");
  await mkdir(project);
  const environment = { CLAUDE_CONFIG_DIR: join(root, "claude") };
  const since = Date.now() - 60_000;
  const at = new Date(since + 1_000).toISOString();
  const claude = claudeTranscriptFolder(environment, project);
  await mkdir(claude, { recursive: true });
  await writeFile(
    join(claude, "s1.jsonl"),
    jsonLines([
      { type: "user", timestamp: at, message: { content: "two calls" } },
      {
        type: "assistant",
        timestamp: at,
        message: {
          content: [
            bash(
              "a",
              `rene call read_file '{"path":"/x"}'; rene call read_file '{"path":"/y"}'`,
            ),
          ],
        },
      },
    ]),
  );
  const store = conversations.createConversationStore(join(root, "store"));
  const follow = () =>
    conversations
      .followConversations({ store, environment, folder: project, since })
      .stop();
  await follow();
  const fresh = await store.events("s1");
  // A session stored by an older parser: no version, and an event the
  // current parser wouldn't produce.
  const { eventsVersion: _version, ...older } = (await store.meta("s1"))!;
  await store.writeMeta(older);
  await store.append("s1", [
    { kind: "tool_use", tool: "stale", rea: true, args: {} },
  ]);
  await follow();
  expect(await store.events("s1")).toEqual(fresh);
  expect(
    fresh.filter(({ kind }) => kind === "tool_use").map(({ args }) => args),
  ).toEqual([{ path: "/x" }, { path: "/y" }]);
});
