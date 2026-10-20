// The topic gate: Claude Code hooks that hold a workbench agent to declaring
// the topic of every turn with rene's record_topic tool.
//
// A turn belongs to the topic declared in it and to no other (topics.mjs), so
// a turn without a declaration has no topic at all. The gate makes that
// rare: when a prompt arrives the agent is reminded; until record_topic has
// been called in the turn, every other tool is refused (ToolSearch stays
// allowed, so a deferred record_topic can be loaded); and a turn that would
// end without a successful declaration is sent back once to make one.
//
// The bridge registers this file for UserPromptSubmit, PreToolUse,
// PostToolUse (record_topic only) and Stop (terminal.mjs), with
// REA_TOPIC_GATE_DIR naming a private folder for the gate's state: one file
// per Claude Code session, holding whether its current turn has a
// declaration. The hooks see each event as it happens, which the transcript
// doesn't give them: Claude Code writes it a little later, so a call sent in
// the same message as record_topic found no declaration there.
//
//   UserPromptSubmit   a new turn: nothing declared
//   PreToolUse         record_topic marks the turn pending, so calls sent
//                      with it pass; any other tool needs pending or declared
//   PostToolUse        record_topic returned without an error: declared
//   Stop               needs declared
//
// When the state can't be read or written the gate lets the action through:
// a broken gate mustn't stop the agent, and the turn then shows as
// undeclared.
//
// The same PreToolUse hook holds the agent to the user's other standing
// rule: the user makes every commit. A shell command that would write or
// publish git history is refused whatever the topic state (gitHistoryWrite).

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ALWAYS_ALLOWED = new Set(["ToolSearch"]);
const SESSION = /^[\w-]{1,120}$/;

const DECLARE =
  "Declare this request's topic with the rene record_topic tool (mcp__rea__record_topic) before anything else: " +
  "pass the topic_id of the topic it continues (the project assessment's Topics section lists them, with their threads), " +
  "or declare a new feature, question, bug, investigation, refactor, docs, decision or other topic under its thread " +
  "(declare a thread first when none fits). Every turn needs its own declaration.";

// The user's standing rule on limitations, given with every prompt so it
// needn't be repeated: a missing tool, program or capability is closed, not
// worked around.
const CLOSE_GAPS =
  "When a limitation blocks the work (a missing rene tool, a program missing from the container, a capability rene lacks), " +
  "close it: build the rene tool, or add the program to frontend/container/Containerfile, and use it. " +
  "Don't skip, stub, downgrade or work around it, and don't wait to be asked. " +
  "If closing it needs a download, an install or a rebuild, ask for that approval and say what it unblocks.";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const isTopicTool = (name) => /(?:^|__)record_topic$/.test(name ?? "");

/** One session's turn state: { pending, declared }. */
function stateStore(directory, session) {
  if (!directory || !SESSION.test(session ?? ""))
    throw new Error("no gate folder or session id");
  const path = join(directory, `${session}.json`);
  return {
    async read() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch (cause) {
        // No file yet: a session whose first prompt the gate didn't see.
        if (cause?.code === "ENOENT")
          return { pending: false, declared: false };
        throw cause;
      }
    },
    async write(state) {
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

/**
 * The user makes every commit, never the agent. Git subcommands that write
 * history or publish it are refused in any shell command an agent sends
 * (Claude Code's Bash or rene's run_command); reading history, staging and
 * unstaging stay allowed. Checked before the topic gate and independent of
 * its state, so it holds even when that state can't be read.
 */
const HISTORY_WRITES = new Set([
  "commit",
  "commit-tree",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "update-ref",
  "push",
  "pull",
  "subtree",
  "filter-branch",
  "filter-repo",
  "replace",
  "notes",
]);
// Global options whose value is the next word, e.g. git -C <path> commit.
const OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);
const SHELL_TOOLS = new Set(["Bash", "mcp__rea__run_command"]);

/** The history-writing git subcommand a shell command line runs, if any. */
export function gitHistoryWrite(command) {
  for (const segment of String(command).split(/&&|\|\||[;|\n&()`]|\$\(/u)) {
    const words = segment.trim().split(/\s+/u);
    let index = words.findIndex((word) => /(?:^|\/)git$/u.test(word));
    if (index < 0) continue;
    index += 1;
    while (index < words.length && words[index].startsWith("-")) {
      const option = words[index];
      index += OPTIONS_WITH_VALUE.has(option) && !option.includes("=") ? 2 : 1;
    }
    const subcommand = words[index];
    const rest = words.slice(index + 1);
    if (subcommand === undefined) continue;
    if (HISTORY_WRITES.has(subcommand)) return subcommand;
    // Moving a branch to another commit rewrites history; unstaging doesn't.
    if (
      subcommand === "reset" &&
      rest.some((word) => /^--(?:soft|hard|keep|merge)$/u.test(word))
    )
      return "reset";
    // Listing tags and stashes reads; creating or dropping them writes.
    if (
      subcommand === "tag" &&
      rest.some(
        (word) => !/^(?:-l|--list|-n\d*|--sort=.*|--contains)$/u.test(word),
      )
    )
      return "tag";
    if (subcommand === "stash" && !["list", "show"].includes(rest[0]))
      return "stash";
  }
  return undefined;
}

/** The refusal for an agent's history-writing git command, if it sent one. */
const gitHistoryRefusal = (toolName, toolInput) => {
  if (!SHELL_TOOLS.has(toolName)) return undefined;
  const subcommand = gitHistoryWrite(toolInput?.command ?? "");
  if (subcommand === undefined) return undefined;
  return `git ${subcommand} is refused: the user makes every commit and every change to git history, never the agent. Leave the changes in the working tree, say what is ready, and ask the user to commit.`;
};

/** A tool result that reports failure. */
const failed = (response) =>
  response?.isError === true || response?.is_error === true;

/**
 * The hook's answer for one event, or undefined to let it through.
 * @param {object} input the hook's JSON
 * @param {string} directory the gate's state folder
 */
export async function gate(input, directory) {
  const event = input.hook_event_name;
  if (event === "PreToolUse") {
    const refusal = gitHistoryRefusal(input.tool_name, input.tool_input);
    if (refusal !== undefined)
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "deny",
          permissionDecisionReason: refusal,
        },
      };
  }
  const store = stateStore(directory, input.session_id);
  if (event === "UserPromptSubmit") {
    await store.write({ pending: false, declared: false });
    return {
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: `${DECLARE} ${CLOSE_GAPS}`,
      },
    };
  }
  if (event === "PreToolUse") {
    if (ALWAYS_ALLOWED.has(input.tool_name)) return;
    const state = await store.read();
    if (isTopicTool(input.tool_name)) {
      if (!state.pending) await store.write({ ...state, pending: true });
      return;
    }
    if (state.pending || state.declared) return;
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "deny",
        permissionDecisionReason: `No topic is declared for this turn yet. ${DECLARE}`,
      },
    };
  }
  if (event === "PostToolUse") {
    if (!isTopicTool(input.tool_name) || failed(input.tool_response)) return;
    const state = await store.read();
    await store.write({ ...state, declared: true });
    return;
  }
  if (event === "Stop") {
    // Sent back once; a turn that still ends undeclared shows as such.
    if (input.stop_hook_active === true) return;
    if ((await store.read()).declared) return;
    return {
      decision: "block",
      reason: `This turn has no successful topic declaration. ${DECLARE} Then finish your answer.`,
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const answer = await gate(
      await readStdin(),
      process.env.REA_TOPIC_GATE_DIR,
    );
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (cause) {
    process.stderr.write(`topic gate: ${cause?.message ?? cause}\n`);
  }
}
