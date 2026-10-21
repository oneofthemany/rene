import { execFile } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// `rene agent` end to end: the real command, real rene tools and real
// history reports, against stand-in model servers that replay a scripted
// conversation and keep every request they were sent.

const execute = promisify(execFile);
const RENE = resolve("scripts/rene.mjs");

interface Received {
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

/** A stand-in server: model replies in order, and the bridge's /api/relay. */
const standIn = async (replies: readonly unknown[]) => {
  const requests: Received[] = [];
  const reports: Record<string, unknown>[] = [];
  let next = 0;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      const body = JSON.parse(text || "{}") as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/relay") {
        reports.push(body);
        response.end("{}");
        return;
      }
      requests.push({
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      response.end(
        JSON.stringify(replies[Math.min(next++, replies.length - 1)]),
      );
    });
  });
  await new Promise<void>((listening) =>
    server.listen(0, "127.0.0.1", listening),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reports,
    close: () => new Promise((closed) => server.close(closed)),
  };
};

const chatReply = (message: Record<string, unknown>) => ({
  choices: [{ finish_reason: "stop", message }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: {
    name: "call_tool",
    arguments: JSON.stringify({ name, arguments: args }),
  },
});

const rene = async (args: readonly string[], env: Record<string, string>) => {
  try {
    const { stdout, stderr } = await execute(
      process.execPath,
      [RENE, ...args],
      {
        env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent", ...env },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (cause: unknown) {
    const failure = cause as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const reportFile = async (root: string, url: string) => {
  const path = join(root, "relay-report.json");
  await writeFile(
    path,
    JSON.stringify({ url: `${url}/api/relay`, token: "t" }),
    {
      mode: 0o600,
    },
  );
  return path;
};

it("rene agent runs a local model's requests through rene, topic first, with the call history recorded", async () => {
  const root = await createTestTempDirectory("rene-agent-local-");
  const file = join(root, "note.txt");
  await writeFile(file, "hello from the target\n");
  const server = await standIn([
    // Tries a tool before declaring a topic: refused, and told why.
    chatReply({
      content: "",
      tool_calls: [toolCall("a", "read_file", { path: file })],
    }),
    chatReply({
      content: "",
      tool_calls: [
        toolCall("b", "record_topic", {
          kind: "thread",
          title: "Agent test",
        }),
      ],
    }),
    chatReply({
      content: "",
      tool_calls: [toolCall("c", "read_file", { path: file })],
    }),
    chatReply({
      content: "<think>it says hello</think>The file says hello.",
    }),
  ]);
  try {
    const run = await rene(["agent", "What does note.txt say?"], {
      REA_TOOLBOX_ROOTS: root,
      RENE_AGENT_BASE_URL: `${server.url}/v1`,
      REA_HISTORY_REPORT: await reportFile(root, server.url),
    });
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("The file says hello.");
    expect(run.stderr).toContain("→ read_file");
    const [first, second, , last] = server.requests;
    expect(first?.path).toBe("/v1/chat/completions");
    expect(first?.headers.authorization).toBe("Bearer sk-local");
    expect(first?.body).toMatchObject({
      model: "qwen3",
      tool_choice: "auto",
    });
    expect(typeof first?.body.num_ctx).toBe("number");
    expect(
      (first?.body.tools as { function: { name: string } }[]).map(
        ({ function: tool }) => tool.name,
      ),
    ).toEqual(["search_tools", "describe_tool", "call_tool"]);
    // Local models get tool calls and results back as plain text.
    const messages = (body?: Record<string, unknown>) =>
      body?.messages as { role: string; content: string }[];
    expect(messages(second?.body).at(-2)).toEqual({
      role: "assistant",
      content: expect.stringContaining("[Called tool call_tool("),
    });
    expect(messages(second?.body).at(-1)).toMatchObject({
      role: "user",
      content: expect.stringMatching(
        /^Result of the tool call \(failed\):\nNo topic is declared/u,
      ),
    });
    expect(messages(last?.body).at(-1)?.content).toContain(
      "hello from the target",
    );
    // Only the calls rene ran reach the history: not the refused one.
    expect(
      server.reports.map(({ type, name, outcome }) => [type, name ?? outcome]),
    ).toEqual([
      ["started", "record_topic"],
      ["settled", "ok"],
      ["started", "read_file"],
      ["settled", "ok"],
    ]);
  } finally {
    await server.close();
  }
}, 120_000);

it("rene agent sends Claude the request the API guidance calls for and returns tool results in one message", async () => {
  const root = await createTestTempDirectory("rene-agent-claude-");
  const message = (content: unknown[], stopReason: string) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 50, output_tokens: 5 },
  });
  const server = await standIn([
    message(
      [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "call_tool",
          input: {
            name: "record_topic",
            arguments: { kind: "thread", title: "Claude test" },
          },
        },
      ],
      "tool_use",
    ),
    message([{ type: "text", text: "Declared." }], "end_turn"),
  ]);
  try {
    const run = await rene(
      ["agent", "--provider", "anthropic", "Declare a topic."],
      {
        REA_TOOLBOX_ROOTS: root,
        ANTHROPIC_BASE_URL: server.url,
        ANTHROPIC_API_KEY: "test-key",
      },
    );
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("Declared.");
    const [first, second] = server.requests;
    expect(first?.path).toMatch(/^\/v1\/messages/u);
    expect(first?.headers["anthropic-beta"]).toContain(
      "server-side-fallback-2026-07-01",
    );
    expect(first?.body).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      fallbacks: "default",
      system: [{ type: "text", cache_control: { type: "ephemeral" } }],
    });
    const sent = second?.body.messages as {
      role: string;
      content: unknown;
    }[];
    // The reply goes back whole, then every tool result in one message.
    expect(sent.at(-2)).toEqual({
      role: "assistant",
      content: [expect.objectContaining({ type: "tool_use", id: "toolu_1" })],
    });
    expect(sent.at(-1)).toEqual({
      role: "user",
      content: [
        expect.objectContaining({
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: false,
        }),
      ],
    });
  } finally {
    await server.close();
  }
}, 120_000);

it("rene agent explains an unreachable local model server", async () => {
  const root = await createTestTempDirectory("rene-agent-down-");
  const run = await rene(["agent", "hello"], {
    REA_TOOLBOX_ROOTS: root,
    RENE_AGENT_BASE_URL: "http://127.0.0.1:9/v1",
  });
  expect(run.code).toBe(1);
  expect(run.stderr).toContain("isn't reachable");
  expect(run.stderr).toContain("RENE_AGENT_BASE_URL");
}, 120_000);
