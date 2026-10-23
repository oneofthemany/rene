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
import { failureReceipt, reneCallFailed } from "./ReaCallCommand.js";

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

  it("reads the status of a shell command Copilot counted as a success", () => {
    const result = (content: string) =>
      copilotEvents({
        type: "tool.execution_complete",
        timestamp: "t1",
        data: { toolCallId: "c", success: true, result: { content } },
      })[0];
    // Copilot counts the call a success whatever the command returned.
    expect(
      result("jq: parse error\n<shellId: 65 completed with exit code 5>"),
    ).toMatchObject({ is_error: true });
    expect(result("ok\n<shellId: 7 completed with exit code 0>")).toMatchObject(
      { is_error: false },
    );
    // A command still running, or one the user stopped, reports no status.
    expect(
      result("<shellId: 9 moved to background by the user. You will be…>"),
    ).toMatchObject({ is_error: false });
  });
});

describe("what Claude Code records about usage and interruptions", () => {
  it("reads Claude Code's usage, interruptions, mid-turn messages, compactions and turn ends", () => {
    const events = [
      {
        type: "user",
        isCompactSummary: true,
        timestamp: "t0",
        message: { content: "This session is being continued…" },
      },
      {
        type: "assistant",
        timestamp: "t1",
        message: {
          id: "msg_1",
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 50,
            output_tokens: 40,
          },
          content: [{ type: "text", text: "Working." }],
        },
      },
      {
        type: "assistant",
        timestamp: "t1",
        message: {
          model: "<synthetic>",
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "No response requested." }],
        },
      },
      {
        type: "attachment",
        timestamp: "t2",
        attachment: {
          type: "queued_command",
          prompt: "also rename it",
          origin: { kind: "human" },
        },
      },
      {
        type: "user",
        timestamp: "t3",
        message: {
          content: [{ type: "text", text: "[Request interrupted by user]" }],
        },
      },
      {
        type: "system",
        subtype: "compact_boundary",
        timestamp: "t4",
        compactMetadata: { preTokens: 900, postTokens: 100, durationMs: 3000 },
      },
      {
        type: "system",
        subtype: "turn_duration",
        timestamp: "t5",
        durationMs: 1200,
      },
    ].flatMap(claudeEvents);
    expect(events).toEqual([
      {
        kind: "usage",
        at: "t1",
        scope: "call",
        call: "msg_1",
        model: "claude-opus-5-5",
        input: 2,
        cache_read: 900,
        cache_write: 50,
        output: 40,
        ai_credits_nano: null,
        context_limit: null,
      },
      { kind: "reply", at: "t1", text: "Working." },
      { kind: "reply", at: "t1", text: "No response requested." },
      { kind: "interjection", at: "t2", text: "also rename it" },
      { kind: "interrupt", at: "t3" },
      {
        kind: "compaction",
        at: "t4",
        tokens_before: 900,
        tokens_after: 100,
        duration_ms: 3000,
      },
      { kind: "turn_end", at: "t5", duration_ms: 1200 },
    ]);
  });
});

describe("what Copilot CLI records about usage and interruptions", () => {
  it("reads Copilot CLI's steering messages, aborts, usage and session totals", () => {
    const events = [
      {
        type: "user.message",
        timestamp: "t1",
        data: { content: "use the other folder", delivery: "steering" },
      },
      { type: "abort", timestamp: "t2", data: { reason: "user_initiated" } },
      {
        type: "model.model_call_success",
        timestamp: "t3",
        data: {
          callId: "c1",
          modelCall: { model: "gpt-5.4-nano" },
          usage: {
            prompt_tokens: 600,
            completion_tokens: 35,
            prompt_tokens_details: {
              cached_tokens: 100,
              cache_write_tokens: 0,
            },
          },
        },
      },
      {
        // Its main model's own call, written as the call finished.
        type: "session.usage_record",
        timestamp: "t35",
        data: {
          usage: {
            model: "claude-opus-4.8",
            inputTokens: 1000,
            outputTokens: 50,
            cacheReadTokens: 800,
            cacheWriteTokens: 150,
            maxPromptTokens: 200000,
            accounting: { usageId: "msg_9" },
            copilotUsage: { totalNanoAiu: 4500000000 },
          },
        },
      },
      {
        type: "session.shutdown",
        timestamp: "t4",
        data: {
          totalPremiumRequests: 7,
          modelMetrics: {
            "claude-opus-4.8": {
              usage: {
                inputTokens: 1000,
                outputTokens: 50,
                cacheReadTokens: 800,
                cacheWriteTokens: 150,
              },
            },
          },
        },
      },
    ].flatMap(copilotEvents);
    expect(events).toEqual([
      { kind: "interjection", at: "t1", text: "use the other folder" },
      { kind: "interrupt", at: "t2" },
      {
        kind: "usage",
        at: "t3",
        scope: "call",
        call: "c1",
        model: "gpt-5.4-nano",
        input: 500,
        cache_read: 100,
        cache_write: 0,
        output: 35,
        context_limit: null,
        ai_credits_nano: null,
      },
      {
        kind: "usage",
        at: "t35",
        scope: "call",
        call: "msg_9",
        model: "claude-opus-4.8",
        input: 50,
        cache_read: 800,
        cache_write: 150,
        output: 50,
        context_limit: 200000,
        ai_credits_nano: 4500000000,
      },
      { kind: "billing", at: "t4", premium_requests: 7 },
      {
        // The shutdown total repeats the call above: a reader counts a
        // session total only for a model it saw no call of.
        kind: "usage",
        at: "t4",
        scope: "session",
        call: null,
        model: "claude-opus-4.8",
        input: 50,
        cache_read: 800,
        cache_write: 150,
        output: 50,
        context_limit: null,
        ai_credits_nano: null,
      },
    ]);
  });
});

describe("conversation turns", () => {
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

describe("failed rene calls behind a pipe", () => {
  it("counts a result carrying rene call's failure receipt as failed", () => {
    const output = `{"isError":true}\n${failureReceipt("search_text")}`;
    const claude = claudeEvents({
      type: "user",
      timestamp: "t1",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "a",
            is_error: false,
            content: output,
          },
        ],
      },
    });
    const copilot = copilotEvents({
      type: "tool.execution_complete",
      timestamp: "t2",
      data: { toolCallId: "b", success: true, result: { content: output } },
    });
    expect(
      [...claude, ...copilot].map(
        (event) => (event as { is_error: boolean }).is_error,
      ),
    ).toEqual([true, true]);
    // Text that only quotes the words is not a receipt.
    expect(
      reneCallFailed("see `rene call: x failed; its result is above.` in docs"),
    ).toBe(false);
  });
});
