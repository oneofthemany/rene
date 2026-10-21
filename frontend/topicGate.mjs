// The topic gate: Claude Code hooks that hold a workbench agent to declaring
// the topic of every turn with rene's record_topic tool.
//
// An agent reaches rene's tools one of two ways, the session's toolkit
// (REA_AGENT_TOOLKIT): "mcp", as MCP tools (mcp__rea__*), or "cli", as
// `rea call <tool> '<json>'` in its shell. With "cli" the shell runs rea and
// nothing else (reaOnlyShellLine), and a `rea call record_topic` is the
// declaration; its printed Evidence is how the gate sees it succeed.
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
// rules, whatever the topic state: the user makes every commit, so a shell
// command that would write or publish git history is refused
// (gitHistoryWrite); and the agent works through rene's tools, so a Claude
// Code built-in that a rene tool replaces is refused with that tool's name
// (builtInToolRefusal). The hook file is read on every event, so the rules
// hold in every session the bridge starts or resumes, running ones included.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  declaredTopicIds,
  reaOnlyShellLine,
} from "../dist/toolbox/ReaCallCommand.js";

const ALWAYS_ALLOWED = new Set(["ToolSearch"]);
const SESSION = /^[\w-]{1,120}$/;

const TOPIC_CHOICE =
  "pass the topic_id of the topic it continues (the project assessment's Topics section lists them, with their threads), " +
  "or declare a new feature, question, bug, investigation, refactor, docs, decision or other topic under its thread " +
  "(declare a thread first when none fits). Every turn needs its own declaration.";
const DECLARE = {
  mcp: `Declare this request's topic with the rene record_topic tool (mcp__rea__record_topic) before anything else: ${TOPIC_CHOICE}`,
  cli: `Declare this request's topic before anything else with \`rea call record_topic '<json>'\` in your shell: ${TOPIC_CHOICE}`,
};

// The user's standing rule on limitations, given with every prompt so it
// needn't be repeated: a missing tool, program or capability is closed, not
// worked around.
const CLOSE_GAPS =
  "When a limitation blocks the work (a missing rene tool, a program missing from the container, a capability rene lacks), " +
  "close it: build the rene tool, or add the program to frontend/container/Containerfile, and use it. " +
  "Don't skip, stub, downgrade or work around it, and don't wait to be asked. " +
  "If closing it needs a download, an install or a rebuild, ask for that approval and say what it unblocks.";

// The user's standing rule on tools: rene is the agent's toolbox, so every
// action goes through it and its calls are recorded in the project history.
const RENE_TOOLS =
  "run_command for shell commands, read_file, write_file and edit_file for files, " +
  "search_text and find_files to search, and the source graph (explore_source_graph) to understand code. " +
  "Where rene has no tool for an action, build it as a rene tool.";
const USE_RENE = {
  mcp: `Work through rene's tools (mcp__rea__*), not your built-in ones: ${RENE_TOOLS}`,
  cli:
    "Work through rene's tools with `rea call <tool> '<json>'` in your shell (`rea call <tool> -` reads the JSON from stdin), " +
    "not your built-in ones; `rea tools search <words>` finds a tool and `rea tools describe <tool>` shows its input. " +
    `Your shell runs only rea commands, whose output you may pipe into head, tail, wc or jq. ${RENE_TOOLS}`,
};

/** How the agent calls one rene tool in its toolkit. */
const howToCall = (tool, toolkit) =>
  toolkit === "cli" ? `\`rea call ${tool} '<json>'\`` : `mcp__rea__${tool}`;

/**
 * Claude Code built-ins and the rene tool that replaces each. Built-ins with
 * no rene counterpart yet (WebFetch, WebSearch, NotebookEdit) stay allowed
 * until rene has one; so does Read for an image or PDF, which rene's
 * read_file reports only as binary.
 */
const RENE_REPLACEMENTS = new Map([
  ["Bash", "run_command"],
  ["Read", "read_file"],
  ["Write", "write_file"],
  ["Edit", "edit_file"],
  ["MultiEdit", "edit_file"],
  ["Grep", "search_text"],
  ["Glob", "find_files"],
  ["LS", "find_files"],
]);
const SHOWN_BY_READ_ONLY = /\.(?:png|jpe?g|gif|webp|bmp|pdf)$/iu;

/**
 * The refusal for a built-in tool that a rene tool replaces, if it is one.
 * With the cli toolkit the shell tool is how rene is reached, so a line that
 * runs rea and nothing else passes.
 */
export function builtInToolRefusal(toolName, toolInput, toolkit = "mcp") {
  const replacement = RENE_REPLACEMENTS.get(toolName);
  if (replacement === undefined) return undefined;
  if (
    toolName === "Read" &&
    SHOWN_BY_READ_ONLY.test(String(toolInput?.file_path ?? ""))
  )
    return undefined;
  if (toolkit === "cli" && toolName === "Bash") {
    const line = reaOnlyShellLine(String(toolInput?.command ?? ""));
    if (line.ok) return undefined;
    return `This shell runs only rea commands, and this one doesn't (${line.reason}). Run a shell command with \`rea call run_command '{"command":"…","cwd":"…"}'\`, so it is recorded in the project history. ${USE_RENE.cli}`;
  }
  return `${toolName} is refused: use rene's ${replacement} (${howToCall(replacement, toolkit)}) instead, so the call is recorded in the project history. ${USE_RENE[toolkit]}`;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const isTopicTool = (name) => /(?:^|__)record_topic$/.test(name ?? "");

/** The rea calls a shell tool use makes, when its line runs only rea. */
const reaCalls = (toolName, toolInput) => {
  if (toolName !== "Bash") return [];
  const line = reaOnlyShellLine(String(toolInput?.command ?? ""));
  return line.ok ? line.calls : [];
};

/** Whether a tool use declares the turn's topic, through MCP or rea call. */
const declaresTopic = (toolName, toolInput) =>
  isTopicTool(toolName) ||
  reaCalls(toolName, toolInput).some(({ tool }) => tool === "record_topic");

/** Whether a tool use's result shows a successful declaration. */
const declared = (toolName, response) => {
  if (isTopicTool(toolName)) return !failed(response);
  const output =
    typeof response === "string" ? response : String(response?.stdout ?? "");
  return declaredTopicIds(output).length > 0;
};

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

/**
 * The shell command lines a tool use runs: its own, and with the cli toolkit
 * the command of each `rea call run_command` on it. A run_command whose
 * arguments aren't on the line (read from stdin) can't be checked, so it is
 * reported as undefined and refused.
 */
const shellCommands = (toolName, toolInput) => {
  if (!SHELL_TOOLS.has(toolName)) return [];
  const own = String(toolInput?.command ?? "");
  const nested = reaCalls(toolName, toolInput)
    .filter(({ tool }) => tool === "run_command")
    .map(({ args }) =>
      args === null ? undefined : String(args.command ?? ""),
    );
  return [own, ...nested];
};

const GIT_RULE =
  "the user makes every commit and every change to git history, never the agent. Leave the changes in the working tree, say what is ready, and ask the user to commit.";

/** The refusal for an agent's history-writing git command, if it sent one. */
const gitHistoryRefusal = (toolName, toolInput) => {
  for (const command of shellCommands(toolName, toolInput)) {
    if (command === undefined)
      return "run_command's arguments must be on the rea call line, not read from stdin, so the workbench can check the command it runs.";
    const subcommand = gitHistoryWrite(command);
    if (subcommand !== undefined)
      return `git ${subcommand} is refused: ${GIT_RULE}`;
  }
  return undefined;
};

/** A tool result that reports failure. */
const failed = (response) =>
  response?.isError === true || response?.is_error === true;

/**
 * The hook's answer for one event, or undefined to let it through.
 * @param {object} input the hook's JSON
 * @param {string} directory the gate's state folder
 */
export async function gate(input, directory, toolkit = "mcp") {
  const event = input.hook_event_name;
  if (event === "PreToolUse") {
    const refusal =
      gitHistoryRefusal(input.tool_name, input.tool_input) ??
      builtInToolRefusal(input.tool_name, input.tool_input, toolkit);
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
        additionalContext: `${DECLARE[toolkit]} ${USE_RENE[toolkit]} ${CLOSE_GAPS}`,
      },
    };
  }
  if (event === "PreToolUse") {
    if (ALWAYS_ALLOWED.has(input.tool_name)) return;
    const state = await store.read();
    if (declaresTopic(input.tool_name, input.tool_input)) {
      if (!state.pending) await store.write({ ...state, pending: true });
      return;
    }
    if (state.pending || state.declared) return;
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "deny",
        permissionDecisionReason: `No topic is declared for this turn yet. ${DECLARE[toolkit]}`,
      },
    };
  }
  if (event === "PostToolUse") {
    if (!declaresTopic(input.tool_name, input.tool_input)) return;
    if (!declared(input.tool_name, input.tool_response)) return;
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
      reason: `This turn has no successful topic declaration. ${DECLARE[toolkit]} Then finish your answer.`,
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
      process.env.REA_AGENT_TOOLKIT === "cli" ? "cli" : "mcp",
    );
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch (cause) {
    process.stderr.write(`topic gate: ${cause?.message ?? cause}\n`);
  }
}
