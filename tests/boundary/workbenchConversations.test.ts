import { appendFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { claudeTranscriptFolder } from "../../src/toolbox/AgentConversations.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

// The workbench's conversation capture (frontend/conversations.mjs): it
// follows the transcripts rene finds for a project folder into the project's
// store, splits them into turns, and ties each rene tool use to the call the
// relay recorded.

interface StoredEvent {
  readonly kind: string;
  readonly text?: string;
  readonly tool?: string;
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
}
interface Turn {
  readonly prompt: string | null;
  readonly events: readonly StoredEvent[];
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
  ): Turn[];
  auditFor(historyId: string, turns: readonly Turn[]): unknown;
};

const jsonLines = (records: readonly unknown[]) =>
  records.map((record) => `${JSON.stringify(record)}\n`).join("");

/** One Copilot CLI session that ran in `project`, with one rene tool call. */
const writeCopilotSession = async (
  copilotHome: string,
  project: string,
  at: string,
) => {
  const session = join(copilotHome, "session-state", "c1");
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "workspace.yaml"), `id: c1\ncwd: ${project}\n`);
  await writeFile(
    join(session, "events.jsonl"),
    jsonLines([
      { type: "user.message", timestamp: at, data: { content: "add a test" } },
      {
        type: "tool.execution_start",
        timestamp: at,
        data: {
          toolCallId: "c",
          toolName: "rea-search_text",
          arguments: { query: "x" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: at,
        data: { toolCallId: "c", success: true, result: { content: "found" } },
      },
      { type: "assistant.message", timestamp: at, data: { content: "Added." } },
    ]),
  );
};

it("follows Claude Code and Copilot CLI conversations into turns and audit trails", async () => {
  const root = await createTestTempDirectory("rea-workbench-conversations-");
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
  const transcript = join(claude, "s1.jsonl");
  const pending = JSON.stringify({
    type: "user",
    timestamp: at,
    message: { content: "next" },
  });
  await writeFile(
    transcript,
    jsonLines([
      { type: "user", timestamp: at, message: { content: "fix the bug" } },
      {
        type: "assistant",
        timestamp: at,
        message: {
          content: [
            { type: "thinking", thinking: "look first" },
            { type: "text", text: "Looking." },
            {
              type: "tool_use",
              id: "a",
              name: "mcp__rea__read_file",
              input: { path: "/x" },
            },
            {
              type: "tool_use",
              id: "b",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: at,
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a", content: "contents" },
            { type: "tool_result", tool_use_id: "b", content: "listing" },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: at,
        message: { content: [{ type: "text", text: "Done." }] },
      },
    ]) + pending, // Still being written: no newline yet.
  );
  // Last written before `since`: not followed.
  const stale = join(claude, "stale.jsonl");
  await writeFile(
    stale,
    jsonLines([{ type: "user", message: { content: "old" } }]),
  );
  await utimes(stale, new Date(since - 3_600_000), new Date(since - 3_600_000));

  await writeCopilotSession(environment.COPILOT_HOME, project, at);

  const store = conversations.createConversationStore(join(root, "store"));
  const follow = () =>
    conversations
      .followConversations({ store, environment, folder: project, since })
      .stop();
  await follow();

  const sessions = await store.sessions();
  expect(
    sessions.map(({ session, agent }) => `${agent}:${session}`).sort(),
  ).toEqual(["Claude Code:s1", "GitHub Copilot CLI:c1"]);
  const kinds = async (id: string) =>
    (await store.events(id)).map(({ kind }) => kind);
  expect(await kinds("c1")).toEqual([
    "prompt",
    "tool_use",
    "tool_result",
    "reply",
  ]);
  const firstTurn = [
    "prompt",
    "reasoning",
    "reply",
    "tool_use",
    "tool_use",
    "tool_result",
    "tool_result",
    "reply",
  ];
  expect(await kinds("s1")).toEqual(firstTurn);
  // Only rene tools' arguments are kept.
  const uses = (await store.events("s1")).filter(
    ({ kind }) => kind === "tool_use",
  );
  expect(uses.map(({ tool, args }) => [tool, args])).toEqual([
    ["read_file", { path: "/x" }],
    ["Bash", undefined],
  ]);

  // The line being written is read once it is complete, and only once.
  await appendFile(transcript, "\n");
  await follow();
  await follow();
  const events = await store.events("s1");
  expect(events.map(({ kind }) => kind)).toEqual([...firstTurn, "prompt"]);

  // A rene tool use is tied to the recorded call with the same tool and
  // arguments, closest after it in time.
  const call = (id: string, args: unknown, offsetMs: number) => ({
    id,
    source: "agent",
    name: "read_file",
    args,
    startedAt: usedAt + offsetMs,
  });
  const claudeMeta = sessions.find(({ session }) => session === "s1")!;
  const turns = conversations.conversationTurns(claudeMeta, events, [
    call("other-arguments", { path: "/y" }, 100),
    call("too-late", { path: "/x" }, 10 * 60_000),
    call("relay", { path: "/x" }, 500),
  ]);
  expect(turns.map(({ prompt }) => prompt)).toEqual(["fix the bug", "next"]);
  expect(
    turns[0]!.events
      .filter(({ kind }) => kind === "tool_use")
      .map(({ historyId }) => historyId),
  ).toEqual(["relay", undefined]);
  expect(conversations.auditFor("relay", turns)).toMatchObject({
    request: "fix the bug",
    why: [{ text: "look first" }, { text: "Looking." }],
    produced: { isError: false, text: "contents" },
    outcome: [{ kind: "reply", text: "Done." }],
  });
});

it("starts a turn at a message sent while the agent works, so its work isn't bundled into the request before", () => {
  const at = (second: number) =>
    new Date(Date.parse("2026-10-23T10:00:00Z") + second * 1_000).toISOString();
  const events = [
    { kind: "prompt", at: at(0), text: "look at the usage plan" },
    { kind: "tool_use", at: at(1), tool: "read_file", toolUseId: "a" },
    // Copilot's steering, Claude Code's queued message: a request of its own.
    { kind: "interjection", at: at(5), text: "this should count as waste" },
    { kind: "tool_use", at: at(6), tool: "edit_file", toolUseId: "b" },
  ] as unknown as StoredEvent[];
  const turns = conversations.conversationTurns(
    { session: "c1", agent: "GitHub Copilot CLI" } as Meta,
    events,
    [],
  );
  expect(
    turns.map((turn) => ({
      prompt: turn.prompt,
      tools: turn.events.map(({ tool }) => tool),
    })),
  ).toEqual([
    { prompt: "look at the usage plan", tools: ["read_file"] },
    { prompt: "this should count as waste", tools: ["edit_file"] },
  ]);
});
