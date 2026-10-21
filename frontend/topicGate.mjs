// The topic gate: Claude Code hooks that hold a workbench agent to declaring
// the topic of every turn with rene's record_topic tool.
//
// An agent reaches rene's tools as `rene call <tool> '<json>'` in its shell.
// The shell runs rene and nothing else (reaOnlyShellLine), and a
// `rene call record_topic` is the declaration; its printed Evidence is how the
// gate sees it succeed. rene is never reached over MCP: an `mcp__rea__*` tool,
// left by an old registration, is refused like the built-ins rene replaces.
//
// A turn belongs to the topic declared in it and to no other (topics.mjs), so
// a turn without a declaration has no topic at all. The gate makes that
// rare: when a prompt arrives the agent is reminded; until record_topic has
// been called in the turn, every other tool is refused (ToolSearch stays
// allowed); and a turn that would end without a successful declaration is
// sent back once to make one.
//
// The bridge registers this file for UserPromptSubmit, PreToolUse,
// PostToolUse (the shell only) and Stop (terminal.mjs), with
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
import {
  GIT_HISTORY_RULE,
  gitHistoryWrite,
} from "../dist/toolbox/GitHistory.js";
import { CONSENT_RULE, consentNeeded } from "../dist/toolbox/CommandConsent.js";

// The git rule's owner is src/toolbox/GitHistory.ts; re-exported for tests.
export { gitHistoryWrite };

const ALWAYS_ALLOWED = new Set(["ToolSearch"]);
const SESSION = /^[\w-]{1,120}$/;

const TOPIC_CHOICE =
  "pass the topic_id of the topic it continues (the project assessment's Topics section lists them, with their threads), " +
  "or declare a new feature, question, bug, investigation, refactor, docs, decision or other topic under its thread " +
  "(declare a thread first when none fits). Every turn needs its own declaration.";
const DECLARE = `Declare this request's topic before anything else with \`rene call record_topic '<json>'\` in your shell: ${TOPIC_CHOICE}`;

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
const USE_RENE =
  "Work through rene's tools with `rene call <tool> '<json>'` in your shell (`rene call <tool> -` reads the JSON from stdin), " +
  "not your built-in ones; `rene tools search <words>` finds a tool and `rene tools describe <tool>` shows its input. " +
  "Your shell runs only rene commands, whose output you may pipe into head, tail, wc or jq. " +
  "run_command for shell commands, read_file, write_file and edit_file for files, " +
  "search_text and find_files to search, and the source graph (explore_source_graph) to understand code. " +
  "Where rene has no tool for an action, build it as a rene tool.";

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
/** rene's tools as an MCP server registered under the name rea. */
const RENE_MCP_TOOL = /^mcp__rea__(.+)$/u;

/**
 * The refusal for a tool that a rene call replaces, if it is one: a built-in
 * with a rene counterpart, or rene's own tool reached over MCP. The shell is
 * how rene is reached, so a line that runs rene and nothing else passes.
 */
export function builtInToolRefusal(toolName, toolInput) {
  const overMcp = RENE_MCP_TOOL.exec(toolName ?? "");
  if (overMcp)
    return `${toolName} is refused: rene isn't reached over MCP. Run \`rene call ${overMcp[1]} '<json>'\` in your shell instead, so the call is recorded in the project history. ${USE_RENE}`;
  const replacement = RENE_REPLACEMENTS.get(toolName);
  if (replacement === undefined) return undefined;
  if (
    toolName === "Read" &&
    SHOWN_BY_READ_ONLY.test(String(toolInput?.file_path ?? ""))
  )
    return undefined;
  if (toolName === "Bash") {
    const line = reaOnlyShellLine(String(toolInput?.command ?? ""));
    if (line.ok) return undefined;
    return `This shell runs only rene commands, and this one doesn't (${line.reason}). Run a shell command with \`rene call run_command '{"command":"…","cwd":"…"}'\`, so it is recorded in the project history. ${USE_RENE}`;
  }
  return `${toolName} is refused: use rene's ${replacement} (\`rene call ${replacement} '<json>'\`) instead, so the call is recorded in the project history. ${USE_RENE}`;
}

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

/** The rene calls a shell tool use makes, when its line runs only rene. */
const reaCalls = (toolName, toolInput) => {
  if (toolName !== "Bash") return [];
  const line = reaOnlyShellLine(String(toolInput?.command ?? ""));
  return line.ok ? line.calls : [];
};

/** Whether a tool use declares the turn's topic with `rene call record_topic`. */
const declaresTopic = (toolName, toolInput) =>
  reaCalls(toolName, toolInput).some(({ tool }) => tool === "record_topic");

// The argument that says what a call was about, in the order tools use them.
const KEY_ARGUMENTS = [
  "path",
  "command",
  "root",
  "query",
  "project_path",
  "title",
  "url",
  "name",
];

/** One call's console line: `rene · <tool> <its main argument>`. */
const reneCallLine = ({ tool, args }) => {
  const key = KEY_ARGUMENTS.find((name) => typeof args?.[name] === "string");
  const detail =
    args === null
      ? "(arguments from stdin)"
      : key === undefined
        ? ""
        : String(args[key]).replace(/\s+/gu, " ");
  const shown = detail.length > 100 ? `${detail.slice(0, 99)}…` : detail;
  return `rene · ${tool}${shown ? ` ${shown}` : ""}`;
};

/**
 * Claude Code shows a rene call only as a shell command, and folds a run of
 * them into one line. The gate names each rene tool the line ran in the
 * console (a hook's systemMessage).
 */
const reneCallNote = (toolName, toolInput) => {
  const calls = reaCalls(toolName, toolInput);
  return calls.length === 0
    ? undefined
    : { systemMessage: calls.map(reneCallLine).join("\n") };
};

/**
 * Whether a shell result shows a successful declaration. The receipt
 * `rene call` writes to stderr survives a filter on stdout.
 */
const declared = (response) => {
  const output =
    typeof response === "string"
      ? response
      : `${response?.stdout ?? ""}\n${response?.stderr ?? ""}`;
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
 * The commands a run_command on a shell line would run. One whose arguments
 * aren't on the line (read from stdin) can't be checked, so it is reported
 * as undefined.
 */
const runCommandLines = (toolName, toolInput) =>
  reaCalls(toolName, toolInput)
    .filter(({ tool }) => tool === "run_command")
    .map(({ args }) =>
      args === null ? undefined : String(args.command ?? ""),
    );

/**
 * The user makes every commit, never the agent. Git subcommands that write
 * history or publish it (src/toolbox/GitHistory.ts finds them) are refused in
 * a shell line and in each `rene call run_command` on it. Checked before the
 * topic gate and independent of its state, so it holds even when that state
 * can't be read. A run_command read from stdin is refused, as unchecked.
 */
const gitHistoryRefusal = (toolName, toolInput) => {
  if (toolName !== "Bash") return undefined;
  const own = String(toolInput?.command ?? "");
  for (const command of [own, ...runCommandLines(toolName, toolInput)]) {
    if (command === undefined)
      return "run_command's arguments must be on the rene call line, not read from stdin, so the workbench can check the command it runs.";
    const subcommand = gitHistoryWrite(command);
    if (subcommand !== undefined)
      return `git ${subcommand} is refused: ${GIT_HISTORY_RULE}`;
  }
  return undefined;
};

/**
 * Claude Code's own approval prompt for a run_command that installs,
 * downloads or launches software, acts on a cloud service, or runs a
 * privileged, destructive or credential-reading command
 * (src/toolbox/CommandConsent.ts): the user decides that command. Other
 * commands run without asking.
 */
const consentAnswer = (event, toolName, toolInput) => {
  for (const command of runCommandLines(toolName, toolInput)) {
    const reason = command === undefined ? undefined : consentNeeded(command);
    if (reason !== undefined)
      return {
        hookSpecificOutput: {
          hookEventName: event,
          permissionDecision: "ask",
          permissionDecisionReason: `rene asks before this command: ${reason}.\n  ${command}\n${CONSENT_RULE}`,
        },
      };
  }
  return undefined;
};

/**
 * The hook's answer for one event, or undefined to let it through.
 * @param {object} input the hook's JSON
 * @param {string} directory the gate's state folder
 */
export async function gate(input, directory) {
  const event = input.hook_event_name;
  if (event === "PreToolUse") {
    const refusal =
      gitHistoryRefusal(input.tool_name, input.tool_input) ??
      builtInToolRefusal(input.tool_name, input.tool_input);
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
        additionalContext: `${DECLARE} ${USE_RENE} ${CLOSE_GAPS}`,
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
    if (state.pending || state.declared)
      return consentAnswer(event, input.tool_name, input.tool_input);
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: "deny",
        permissionDecisionReason: `No topic is declared for this turn yet. ${DECLARE}`,
      },
    };
  }
  if (event === "PostToolUse") {
    if (
      declaresTopic(input.tool_name, input.tool_input) &&
      declared(input.tool_response)
    ) {
      const state = await store.read();
      await store.write({ ...state, declared: true });
    }
    return reneCallNote(input.tool_name, input.tool_input);
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
