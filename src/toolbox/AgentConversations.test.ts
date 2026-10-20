import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudeEvents,
  claudeTranscriptFolder,
  copilotEvents,
  findConversations,
  readEvents,
  turnsOf,
} from "./AgentConversations.js";

describe("agent transcripts", () => {
  it("reads a Claude Code turn: prompt, reasoning, reply, rene and built-in tools, results", () => {
    const events = [
      { type: "user", timestamp: "t1", message: { content: "fix the bug" } },
      {
        type: "user",
        timestamp: "t1",
        message: { content: "<system-reminder>ignore</system-reminder>" },
      },
      {
        type: "assistant",
        timestamp: "t2",
        message: {
          content: [
            { type: "thinking", thinking: "", signature: "redacted" },
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
        timestamp: "t3",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "a", content: "text" },
            {
              type: "tool_result",
              tool_use_id: "b",
              is_error: true,
              content: [{ type: "text", text: "no" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        message: { content: [{ type: "text", text: "sub-agent" }] },
      },
    ].flatMap(claudeEvents);
    expect(events.map((event) => event.kind)).toEqual([
      "prompt",
      "reasoning",
      "reply",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
    ]);
    expect(events[3]).toMatchObject({
      tool: "read_file",
      rene: true,
      args: { path: "/x" },
    });
    expect(events[4]).toMatchObject({ tool: "Bash", rene: false });
    expect(events[6]).toMatchObject({ is_error: true, text: "no" });
  });

  it("reads a Copilot CLI turn the same way", () => {
    const events = [
      { type: "session.start", data: {} },
      {
        type: "user.message",
        timestamp: "t1",
        data: { content: "add a test" },
      },
      {
        type: "assistant.message",
        timestamp: "t2",
        data: { content: "", reasoningText: "plan it", toolRequests: [] },
      },
      {
        type: "tool.execution_start",
        timestamp: "t3",
        data: {
          toolCallId: "c",
          toolName: "rea-search_text",
          arguments: { query: "x" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "t4",
        data: {
          toolCallId: "c",
          success: false,
          result: { content: "failed" },
        },
      },
      {
        type: "assistant.message",
        timestamp: "t5",
        data: { content: "Done." },
      },
    ].flatMap(copilotEvents);
    expect(events.map((event) => event.kind)).toEqual([
      "prompt",
      "reasoning",
      "tool_use",
      "tool_result",
      "reply",
    ]);
    expect(events[2]).toMatchObject({ tool: "search_text", rene: true });
    expect(events[3]).toMatchObject({ is_error: true, text: "failed" });
  });

  it("splits turns at prompts and drops what comes before the first", () => {
    const turns = turnsOf([
      { kind: "reply", at: null, text: "tail of a resumed session" },
      { kind: "prompt", at: null, text: "one" },
      { kind: "reply", at: null, text: "a" },
      { kind: "prompt", at: null, text: "two" },
    ]);
    expect(turns.map((turn) => turn.length)).toEqual([2, 1]);
  });
});

describe("finding a folder's conversations", () => {
  let home: string;
  let project: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "rea-conversations-"));
    project = join(home, "project");
    await mkdir(project);
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("finds Claude Code transcripts by folder and Copilot sessions by their cwd", async () => {
    const env = {
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      COPILOT_HOME: join(home, "copilot"),
    };
    const claude = claudeTranscriptFolder(env, project);
    await mkdir(claude, { recursive: true });
    await writeFile(
      join(claude, "s1.jsonl"),
      `${JSON.stringify({ type: "user", message: { content: "hello" } })}\n`,
    );
    for (const [id, cwd] of [
      ["c1", project],
      ["c2", join(home, "elsewhere")],
    ] as const) {
      const session = join(home, "copilot", "session-state", id);
      await mkdir(session, { recursive: true });
      await writeFile(
        join(session, "workspace.yaml"),
        `id: ${id}\ncwd: ${cwd}\n`,
      );
      await writeFile(join(session, "events.jsonl"), "");
    }
    const found = await findConversations(env, project);
    expect(found.map(({ agent, id }) => `${agent}:${id}`).sort()).toEqual([
      "claude-code:s1",
      "copilot-cli:c1",
    ]);
    const claudeSource = found.find(
      (source) => source.agent === "claude-code",
    )!;
    expect(await readEvents(claudeSource)).toEqual([
      { kind: "prompt", at: null, text: "hello" },
    ]);
  });
});
