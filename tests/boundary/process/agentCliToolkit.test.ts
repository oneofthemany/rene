import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A workbench agent session: the agent reaches rene with `rene call` in its
// shell, never over MCP. The topic gate holds its shell to rene and takes a
// `rene call record_topic` as the turn's declaration, and the session gets a
// `rene` command and a daemon it shares (frontend/agentToolkit.mjs).

const frontend = new URL("../../../frontend/", import.meta.url);
const execute = promisify(execFile);

type Answer =
  | {
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
        additionalContext?: string;
      };
      decision?: string;
    }
  | undefined;
const { gate } = (await import(new URL("topicGate.mjs", frontend).href)) as {
  gate(input: Record<string, unknown>, directory: string): Promise<Answer>;
};
const { startCliToolkit } = (await import(
  new URL("agentToolkit.mjs", frontend).href
)) as {
  startCliToolkit(options: {
    rea: { command: string; args: string[] };
    directory: string;
    env: NodeJS.ProcessEnv;
  }): Promise<{
    env: { PATH: string; REA_DAEMON_SOCKET: string };
    stop(): Promise<void>;
  }>;
};
const { agentInstructions } = (await import(
  new URL("terminal.mjs", frontend).href
)) as { agentInstructions(assessment?: string): string };

const recordTopic = `rene call record_topic '{"kind":"thread","title":"T"}'`;
const topicEvidence = JSON.stringify({
  operation: "record_topic",
  normalized_result: { topic_id: "00000000-0000-4000-8000-000000000001" },
});

describe("cli toolkit", () => {
  it("holds a turn's shell to rea and takes rene call record_topic as its declaration", async () => {
    const directory = await createTestTempDirectory("rea-cli-gate-");
    const event = (name: string, extra: Record<string, unknown> = {}) =>
      gate({ hook_event_name: name, session_id: "s1", ...extra }, directory);
    const bash = (command: string, extra: Record<string, unknown> = {}) =>
      event("PreToolUse", {
        tool_name: "Bash",
        tool_input: { command },
        ...extra,
      });
    const decision = (answer: Answer) =>
      answer?.hookSpecificOutput?.permissionDecision;

    const prompt = await event("UserPromptSubmit");
    expect(prompt?.hookSpecificOutput?.additionalContext).toContain(
      "rene call record_topic",
    );
    // Not rea at all: refused, giving the call that runs it, recorded.
    const ls = await bash("ls -la 'a b'", { cwd: "/r" });
    expect(decision(ls)).toBe("deny");
    expect(ls?.hookSpecificOutput?.permissionDecisionReason).toContain(
      `Run it as \`rene call run_command '{"command":"ls -la '\\''a b'\\''","cwd":"/r"}'\``,
    );
    // rea, but no topic yet: refused, with record_topic's arguments spelled out.
    const early = await bash(`rene call read_file '{"path":"/x"}'`);
    expect(decision(early)).toBe("deny");
    expect(early?.hookSpecificOutput?.permissionDecisionReason).toContain(
      `rene call record_topic '{"title":"…","kind":"feature","parent_id":"<thread id>"}'`,
    );
    // Looking the arguments up needs no declaration.
    expect(
      decision(
        await bash("rene tools describe record_topic | jq .input_schema"),
      ),
    ).toBeUndefined();
    expect(decision(await bash(recordTopic))).toBeUndefined();
    // A declaration that failed doesn't count; the one that printed Evidence does.
    await event("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: recordTopic },
      tool_response: { stdout: "Input validation error: …\n", stderr: "" },
    });
    expect((await event("Stop"))?.decision).toBe("block");
    await event("PostToolUse", {
      tool_name: "Bash",
      tool_input: { command: recordTopic },
      tool_response: { stdout: `${topicEvidence}\n`, stderr: "" },
    });
    expect(await event("Stop")).toBeUndefined();
    expect(
      decision(await bash(`rene call read_file '{"path":"/x"}' | head -c 100`)),
    ).toBeUndefined();
    // The git rule reaches into run_command's own command line.
    const commit = await bash(
      `rene call run_command '{"command":"git commit -m x","cwd":"/r"}'`,
    );
    expect(commit?.hookSpecificOutput?.permissionDecisionReason).toContain(
      "git commit is refused",
    );
    const hidden = await bash(`rene call run_command - <<'EOF'\n{}\nEOF`);
    expect(decision(hidden)).toBe("deny");
  });

  it("refuses rene's tools reached over MCP, naming the rene call", async () => {
    const directory = await createTestTempDirectory("rea-mcp-gate-");
    // An old registration can still hand a session rene's MCP tools; the
    // refusal holds before any topic is declared, and after.
    const answer = await gate(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        tool_name: "mcp__rea__read_file",
        tool_input: { path: "/a/b.ts" },
      },
      directory,
    );
    expect(answer?.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(answer?.hookSpecificOutput?.permissionDecisionReason).toContain(
      `rene isn't reached over MCP. Run \`rene call read_file '{"path":"/a/b.ts"}'\``,
    );
  });

  it("reminds the agent to use rene call when run as a hook", async () => {
    const directory = await createTestTempDirectory("rea-cli-hook-");
    const hook = execute(
      process.execPath,
      [fileURLToPath(new URL("topicGate.mjs", frontend))],
      {
        env: {
          ...process.env,
          REA_TOPIC_GATE_DIR: directory,
        },
      },
    );
    hook.child.stdin?.end(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s" }),
    );
    const context = (
      JSON.parse((await hook).stdout) as {
        hookSpecificOutput: { additionalContext: string };
      }
    ).hookSpecificOutput.additionalContext;
    expect(context).toContain("`rene call <tool> '<json>'`");
    expect(context).not.toContain("mcp__rea__record_topic");
  });

  it("tells the agent to use rene call, not MCP tools", () => {
    const instructions = agentInstructions(undefined);
    expect(instructions).toContain("`rene call <tool> '<json>'`");
    expect(instructions).toContain("declare it with `rene call record_topic`");
    expect(instructions).not.toContain("MCP");
  });

  it("gives the session a rea command and a shared daemon that ends with it", async () => {
    const directory = await createTestTempDirectory("rea-cli-session-");
    const env = {
      PATH: process.env.PATH ?? "",
      REA_LOG_LEVEL: "silent",
      REA_TOOLBOX_ROOTS: directory,
    };
    const toolkit = await startCliToolkit({
      rea: { command: process.execPath, args: [resolve("scripts/rea.mjs")] },
      directory,
      env,
    });
    const socket = toolkit.env.REA_DAEMON_SOCKET;
    try {
      expect(existsSync(socket)).toBe(true);
      // `rea` from the session's PATH reaches the session's daemon.
      const { stdout } = await execute(
        "rea",
        ["call", "binary_session", "{}"],
        { env: { ...env, ...toolkit.env } },
      );
      expect(stdout).toContain("binary_session");
    } finally {
      // Closing its stdin ends the daemon; a kill would first wait out the
      // 10 s grace for that.
      const stopping = Date.now();
      await toolkit.stop();
      expect(Date.now() - stopping).toBeLessThan(5_000);
    }
    expect(existsSync(socket)).toBe(false);
    // Stopping twice is the same stop.
    await toolkit.stop();
  }, 120_000);

  it("reports a rea command that can't serve a session", async () => {
    const directory = await createTestTempDirectory("rea-cli-failed-");
    await expect(
      startCliToolkit({
        rea: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('no rea here'); process.exit(3)"],
        },
        directory,
        env: { PATH: process.env.PATH ?? "" },
      }),
    ).rejects.toThrow(/exited \(status 3\).*no rea here/su);
  });
});

// The launcher agent registrations on this machine name refuses MCP before it
// reaches the container, so a stale registration fails instead of connecting.
it.each([
  [["mcp"], {}],
  [["--mcp"], {}],
  [["mcp", "add"], {}],
  [["mcp", "add"], { REA_WORKBENCH_MCP: "page" }],
  [["setup", "--client", "codex"], {}],
  [["setup", "--yes"], { REA_WORKBENCH_MCP: "page" }],
])("the container launcher refuses rea %j for agents", async (args, extra) => {
  const launcher = fileURLToPath(new URL("container/rea", frontend));
  const refused = await execute(launcher, args, {
    env: { ...process.env, REA_WORKBENCH_MCP: "", ...extra },
  }).then(
    () => undefined,
    (cause: { code?: number; stderr?: string }) => cause,
  );
  expect(refused?.code).toBe(77);
  expect(refused?.stderr).toContain("Agents reach rene through `rene call");
});

it("refuses a built-in rene replaces with the rene call that does what it was asked", async () => {
  const directory = await createTestTempDirectory("rea-builtin-gate-");
  const refusal = async (
    tool_name: string,
    tool_input: Record<string, unknown>,
  ) =>
    (
      await gate(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          cwd: "/r",
          tool_name,
          tool_input,
        },
        directory,
      )
    )?.hookSpecificOutput?.permissionDecisionReason;
  expect(
    await refusal("Read", { file_path: "/a/b.ts", offset: 40, limit: 20 }),
  ).toContain(
    `run \`rene call read_file '{"path":"/a/b.ts","start_line":40,"max_lines":20}'\``,
  );
  expect(await refusal("Grep", { pattern: "a.b", glob: "*.ts" })).toContain(
    `run \`rene call search_text '{"root":"/r","query":"a.b","regex":true,"pattern":"*.ts"}'\``,
  );
  // Content the agent must supply again isn't echoed back.
  expect(
    await refusal("Write", { file_path: "/a/b.ts", content: "x".repeat(5000) }),
  ).toContain(
    `run \`rene call write_file '{"path":"/a/b.ts","content":"…"}'\` (or \`--stdin-field content\``,
  );
});

it("counts a declaration whose output was filtered, from its stderr receipt", async () => {
  const directory = await createTestTempDirectory("rea-cli-receipt-");
  const event = (name: string, extra: Record<string, unknown> = {}) =>
    gate({ hook_event_name: name, session_id: "s1", ...extra }, directory);
  const filtered = `${recordTopic} | jq -r .normalized_result.topic_id`;
  await event("UserPromptSubmit");
  await event("PreToolUse", {
    tool_name: "Bash",
    tool_input: { command: filtered },
  });
  await event("PostToolUse", {
    tool_name: "Bash",
    tool_input: { command: filtered },
    tool_response: {
      stdout: "00000000-0000-4000-8000-000000000001\n",
      stderr:
        "rene call: declared topic 00000000-0000-4000-8000-000000000001\n",
    },
  });
  expect(await event("Stop")).toBeUndefined();
});

it("names each rene tool a shell line ran in the console", async () => {
  const directory = await createTestTempDirectory("rea-cli-console-");
  const note = await gate(
    {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: {
        command: `rene call read_file '{"path":"/x"}' | head -c 100 && rene call run_command - <<'EOF'\n{}\nEOF`,
      },
      tool_response: { stdout: "", stderr: "" },
    },
    directory,
  );
  expect(note).toEqual({
    systemMessage:
      "rene · read_file /x\nrene · run_command (arguments from stdin)",
  });
});
