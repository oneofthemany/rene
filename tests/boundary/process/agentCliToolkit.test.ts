import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// A workbench agent session with the cli toolkit: the agent reaches rene
// with `rene call` in its shell. The topic gate holds its shell to rea and
// takes a `rene call record_topic` as the turn's declaration, and the session
// gets a `rea` command and a daemon it shares (frontend/agentToolkit.mjs).

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
  gate(
    input: Record<string, unknown>,
    directory: string,
    toolkit: string,
  ): Promise<Answer>;
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
)) as { agentInstructions(assessment?: string, toolkit?: string): string };

const recordTopic = `rene call record_topic '{"kind":"thread","title":"T"}'`;
const topicEvidence = JSON.stringify({
  operation: "record_topic",
  normalized_result: { topic_id: "00000000-0000-4000-8000-000000000001" },
});

describe("cli toolkit", () => {
  it("holds a turn's shell to rea and takes rene call record_topic as its declaration", async () => {
    const directory = await createTestTempDirectory("rea-cli-gate-");
    const event = (name: string, extra: Record<string, unknown> = {}) =>
      gate(
        { hook_event_name: name, session_id: "s1", ...extra },
        directory,
        "cli",
      );
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
    // Not rea at all: refused, naming the recorded way to run it.
    const ls = await bash("ls -la");
    expect(decision(ls)).toBe("deny");
    expect(ls?.hookSpecificOutput?.permissionDecisionReason).toContain(
      "rene call run_command",
    );
    expect(decision(await bash(`rene call read_file '{"path":"/x"}'`))).toBe(
      "deny", // rea, but no topic yet.
    );
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
    // Built-ins rene replaces are refused with the rene call that does it.

    const read = await event("PreToolUse", {
      tool_name: "Read",
      tool_input: { file_path: "/a/b.ts" },
    });
    expect(read?.hookSpecificOutput?.permissionDecisionReason).toContain(
      "`rene call read_file '<json>'`",
    );
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

  it("reads the session's toolkit from the hook's environment", async () => {
    const directory = await createTestTempDirectory("rea-cli-hook-");
    const hook = execute(
      process.execPath,
      [fileURLToPath(new URL("topicGate.mjs", frontend))],
      {
        env: {
          ...process.env,
          REA_TOPIC_GATE_DIR: directory,
          REA_AGENT_TOOLKIT: "cli",
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

  it("is the default: MCP only when asked for", async () => {
    const { agentToolkit } = (await import(
      new URL("agentToolkit.mjs", frontend).href
    )) as { agentToolkit(env: Record<string, string>): string };
    expect(agentToolkit({})).toBe("cli");
    expect(agentToolkit({ REA_AGENT_TOOLKIT: "cli" })).toBe("cli");
    expect(agentToolkit({ REA_AGENT_TOOLKIT: "mcp" })).toBe("mcp");
  });

  it("tells the agent to use rene call, not MCP tools", () => {
    const cli = agentInstructions(undefined, "cli");
    expect(cli).toContain("`rene call <tool> '<json>'`");
    expect(cli).toContain("declare it with `rene call record_topic`");
    expect(cli).not.toContain("MCP tools");
    expect(agentInstructions(undefined, "mcp")).toContain("`rea` MCP tools");
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

it("counts a declaration whose output was filtered, from its stderr receipt", async () => {
  const directory = await createTestTempDirectory("rea-cli-receipt-");
  const event = (name: string, extra: Record<string, unknown> = {}) =>
    gate(
      { hook_event_name: name, session_id: "s1", ...extra },
      directory,
      "cli",
    );
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
    "cli",
  );
  expect(note).toEqual({
    systemMessage:
      "rene · read_file /x\nrene · run_command (arguments from stdin)",
  });
});
