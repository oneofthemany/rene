import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// The workbench's guards against agents writing git history: the topic gate
// refuses history-writing shell commands up front, and the git hooks every
// agent session gets refuse the reference updates themselves.

const frontend = new URL("../../../frontend/", import.meta.url);
const hooks = fileURLToPath(new URL("agent-git-hooks", frontend));

interface TopicGate {
  gitHistoryWrite(command: string): string | undefined;
  builtInToolRefusal(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): string | undefined;
  gate(
    input: Record<string, unknown>,
    directory: string | undefined,
  ): Promise<
    { hookSpecificOutput?: { permissionDecision?: string } } | undefined
  >;
}
const topicGate = (await import(
  new URL("topicGate.mjs", frontend).href
)) as TopicGate;

describe("topic gate", () => {
  it.each([
    ["git commit -m x", "commit"],
    ["git -C /a/b commit -am y", "commit"],
    ["cd x && git push origin main", "push"],
    ["git status && git diff", undefined],
    ["git log --oneline -3", undefined],
    ["git add -A", undefined],
    ["git reset", undefined],
    ["git reset --soft HEAD~1", "reset"],
    ["git reset HEAD file", undefined],
    ["git tag", undefined],
    ["git tag -l", undefined],
    ["git tag v1", "tag"],
    ["git stash", "stash"],
    ["git stash list", undefined],
    ["git stash pop", "stash"],
    ["/usr/bin/git merge feature", "merge"],
    ["echo $(git rev-parse HEAD)", undefined],
    ["git -c user.name=x commit-tree t", "commit-tree"],
    ["git fetch origin", undefined],
    ["git switch -c b", undefined],
    ["npm run build", undefined],
  ])("classifies %s", (command, expected) => {
    expect(topicGate.gitHistoryWrite(command)).toBe(expected);
  });

  it.each(["Bash", "mcp__rea__run_command"])(
    "denies a commit sent through %s",
    async (tool) => {
      const answer = await topicGate.gate(
        {
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: { command: "git commit -m x" },
        },
        undefined,
      );
      expect(answer?.hookSpecificOutput?.permissionDecision).toBe("deny");
    },
  );

  it.each([
    ["Bash", { command: "ls" }, "run_command"],
    ["Read", { file_path: "/a/b.ts" }, "read_file"],
    ["Write", { file_path: "/a/b.ts" }, "write_file"],
    ["Edit", { file_path: "/a/b.ts" }, "edit_file"],
    ["Grep", { pattern: "x" }, "search_text"],
    ["Glob", { pattern: "**/*.ts" }, "find_files"],
  ])(
    "refuses the built-in %s, naming rene's tool, before any topic is declared",
    async (tool, toolInput, replacement) => {
      const answer = (await topicGate.gate(
        {
          hook_event_name: "PreToolUse",
          tool_name: tool,
          tool_input: toolInput,
        },
        undefined,
      )) as {
        hookSpecificOutput?: {
          permissionDecision?: string;
          permissionDecisionReason?: string;
        };
      };
      expect(answer.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(answer.hookSpecificOutput?.permissionDecisionReason).toContain(
        `mcp__rea__${replacement}`,
      );
    },
  );

  it.each([
    ["Read", { file_path: "/a/shot.png" }],
    ["Read", { file_path: "/a/report.PDF" }],
    ["WebFetch", { url: "https://example.invalid" }],
    ["mcp__rea__read_file", { path: "/a/b.ts" }],
    ["mcp__rea__run_command", { command: "ls", cwd: "/a" }],
  ])("lets %s through the tool rule", (tool, toolInput) => {
    expect(topicGate.builtInToolRefusal(tool, toolInput)).toBeUndefined();
  });

  it("gives every prompt the user's standing rules, the way Claude Code runs the hook", async () => {
    const directory = await createTestTempDirectory("rea-topic-gate-");
    const hook = run(
      process.execPath,
      [fileURLToPath(new URL("topicGate.mjs", frontend))],
      { env: { ...process.env, REA_TOPIC_GATE_DIR: directory } },
    );
    hook.child.stdin?.end(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "prompt-session",
        prompt: "continue",
      }),
    );
    const { stdout } = await hook;
    const context = (
      JSON.parse(stdout) as {
        hookSpecificOutput: {
          hookEventName: string;
          additionalContext: string;
        };
      }
    ).hookSpecificOutput;

    expect(context.hookEventName).toBe("UserPromptSubmit");
    // Declare the turn's topic first.
    expect(context.additionalContext).toContain(
      "Declare this request's topic with the rene record_topic tool",
    );
    // Work through rene's tools, not the agent's built-in ones.
    expect(context.additionalContext).toContain(
      "Work through rene's tools (mcp__rea__*), not your built-in ones",
    );
    // Close a limitation instead of working around it, unprompted.
    expect(context.additionalContext).toContain(
      "build the rene tool, or add the program to frontend/container/Containerfile",
    );
    expect(context.additionalContext).toContain(
      "Don't skip, stub, downgrade or work around it, and don't wait to be asked.",
    );
    // A new prompt starts an undeclared turn.
    expect(
      JSON.parse(
        await readFile(join(directory, "prompt-session.json"), "utf8"),
      ),
    ).toEqual({ pending: false, declared: false });
  });
});

const run = promisify(execFile);

it("agent git hooks refuse history writes and allow reading and branching", async () => {
  const root = await createTestTempDirectory("rea-agent-git-hooks-");
  const repository = join(root, "repository");
  const remote = join(root, "remote.git");
  await mkdir(repository);
  // Isolated from the workstation's git configuration and hooks, including
  // these very hooks when the tests run inside an agent session.
  const isolated = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = async (agent: boolean, ...args: string[]) => {
    try {
      await run(
        "git",
        [
          "-c",
          "user.name=test",
          "-c",
          "user.email=test@example.invalid",
          ...args,
        ],
        {
          cwd: repository,
          env: agent
            ? {
                ...isolated,
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: "core.hooksPath",
                GIT_CONFIG_VALUE_0: hooks,
              }
            : isolated,
        },
      );
      return "allowed";
    } catch {
      return "refused";
    }
  };
  const user = (...args: string[]) => git(false, ...args);
  const agent = (...args: string[]) => git(true, ...args);
  const commit = ["commit", "-q", "--allow-empty", "-m"];

  await user("init", "-q", "-b", "main", ".");
  await user("init", "-q", "--bare", remote);
  expect(await agent(...commit, "first")).toBe("refused");
  expect(await user(...commit, "first")).toBe("allowed");
  expect(await agent(...commit, "second")).toBe("refused");
  expect(await agent("branch", "feature")).toBe("allowed");
  expect(await agent("switch", "-q", "feature")).toBe("allowed");
  expect(await agent("switch", "-q", "--detach", "main")).toBe("allowed");
  expect(await agent(...commit, "detached")).toBe("refused");
  await user("switch", "-q", "main");
  expect(await agent("switch", "-q", "--orphan", "lonely")).toBe("allowed");
  expect(await agent(...commit, "orphan")).toBe("refused");
  await user("switch", "-q", "-f", "main");

  await user(...commit, "user second");
  expect(await agent("reset", "-q", "--hard", "HEAD~1")).toBe("refused");
  expect(await agent("tag", "v1")).toBe("refused");
  await writeFile(join(repository, "file.txt"), "change\n");
  await user("add", "file.txt");
  expect(await agent("stash", "-q")).toBe("refused");
  expect(await agent("reset", "-q")).toBe("allowed");
  expect(await agent("log", "--oneline")).toBe("allowed");
  expect(await agent("status")).toBe("allowed");

  await user("stash", "-q");
  await user("switch", "-q", "feature");
  await user(...commit, "user on feature");
  await user("switch", "-q", "main");
  await user("stash", "pop", "-q");
  expect(await agent("merge", "-q", "--no-edit", "--no-ff", "feature")).toBe(
    "refused",
  );
  expect(await agent("cherry-pick", "feature")).toBe("refused");
  expect(await agent("branch", "-D", "feature")).toBe("refused");
  expect(await agent("push", "-q", remote, "main")).toBe("refused");
  expect(await user("push", "-q", remote, "main")).toBe("allowed");

  const { stdout } = await run("git", ["rev-list", "--count", "main"], {
    cwd: repository,
    env: isolated,
  });
  expect(stdout.trim()).toBe("2");
});
