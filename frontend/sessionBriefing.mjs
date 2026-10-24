// What an agent is handed when its session starts (topicGate.mjs gives it to
// Claude Code on SessionStart and to Copilot CLI on sessionStart): the way a
// session works, step by step, and what steps 1 to 3 need, so they cost no
// calls: the plan's live limits, the project's briefing (assessment.mjs
// writes it with the assessment: target, rules, layout, open topics) and the
// open tasks in TODO.md and docs/plans (tasks.mjs). Every part is read when the session starts; a part
// that can't be read is named as missing rather than left out silently.

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { projectTasks } from "./tasks.mjs";

const BRIEFING = join(".rene", "briefing.md");
const TODO = "TODO.md";
// Claude Code hands a hook's context over inline only up to 10,000
// characters; more is saved to a file the agent must read first (seen on
// 24 Oct: a 15.3 KB briefing). The briefing keeps under it: the project part
// is cut at PROJECT_CHARS, and tasks fill what is left.
const SESSION_CHARS = 9_500;
const PROJECT_CHARS = 5_000;
const LEAD_CHARS = 90;
const NUMBERED_CHARS = 50;

/** The way every session works, for Claude Code and Copilot CLI alike. */
export const SESSION_PROCESS = [
  "How this session works:",
  "1. Budget: read the plan's live limits below (the 5-hour and weekly windows) and your context's size.",
  "2. Orient on the project: its target, rules, layout and open topics, below (the full record is .rene/assessment.md).",
  "3. Orient on the open tasks in TODO.md and docs/plans, below, each with its id.",
  "4. Understand the request: match it to a task or an open topic, and see whether another agent worked on it (list_agent_conversations, read_agent_conversation); ask the user only if it is still unclear.",
  "5. Declare with `rene call record_topic`: continue the matching topic with its topic_id, or declare a new one under the thread it belongs to, with `estimate`, `plan` and the `task` it works on; then say whether it fits what is left now, fits better in a fresh conversation, or should wait for a reset, and tell the user before starting if it doesn't fit.",
  "6. Act in phases: declare each phase as it starts, and look at the budget again between phases.",
  "7. Close out: verify (tests, checks), declare the topic done or abandoned with a summary, update the TODO item and the assessment's Findings, report the estimate against what was used, and say what is ready for the user to commit.",
  "Steps 1 to 4 may read before a declaration: read_file, search_text, find_files, list_agent_conversations and read_agent_conversation, and `rene tools search|describe`. Anything else waits for step 5.",
].join("\n");

/** The arguments of the tools every session uses, exactly as they take them. */
export const TOOL_FORMS = [
  [
    "record_topic",
    {
      topic_id: "<to continue one; leave out for a new topic>",
      title: "…",
      kind: "feature",
      parent_id: "<its thread's id>",
      task: "<the task's id, if it works on one>",
      plan: ["…", "…"],
      phase: "…",
      estimate: {
        model_calls: { low: 10, high: 20 },
        working_minutes: { low: 10, high: 30 },
        confidence: "medium",
        basis: "…",
      },
    },
  ],
  ["read_file", { path: "/absolute/path", start_line: 1, max_lines: 200 }],
  [
    "search_text",
    {
      root: "/absolute/folder",
      query: "text",
      regex: false,
      pattern: "**/*.ts",
      context_lines: 0,
    },
  ],
  ["find_files", { root: "/absolute/folder", pattern: "**/*TODO*" }],
  [
    "edit_file",
    {
      path: "/absolute/path",
      old_text: "…",
      new_text: "…",
      replace_all: false,
    },
  ],
  [
    "write_file",
    { path: "/absolute/path", content: "…", create_directories: false },
  ],
  ["run_command", { command: "npm test", cwd: "/absolute/folder" }],
  [
    "list_agent_conversations",
    { project_path: "/absolute/folder", agent: "all", limit: 20 },
  ],
  [
    "read_agent_conversation",
    {
      project_path: "/absolute/folder",
      agent: "copilot-cli",
      conversation_id: "…",
      max_turns: 5,
    },
  ],
];

const toolFormLines = () => [
  "Tool arguments (`rene call <tool> '<json>'`; run_command's must be on the line, not on stdin):",
  ...TOOL_FORMS.map(([tool, args]) => `- ${tool} ${JSON.stringify(args)}`),
];

/** The open tasks (tasks.mjs), by the section their ids start with. */
const taskLines = (found) => {
  if (found.unavailable) return [`_Tasks unavailable: ${found.unavailable}_`];
  if (!found.files.includes(TODO) && !found.tasks.length)
    return ["_No TODO.md or docs/plans in this project._"];
  const open = found.tasks.filter(
    (item) => item.status !== "done" && !item.note,
  );
  if (!open.length) return ["_No open tasks._"];
  const shown = (item, chars) =>
    `${item.title.length > chars ? `${item.title.slice(0, chars)}…` : item.title}${item.status === "started" ? " (started)" : ""}${item.stable ? ` [${item.id}]` : ""}`;
  const lines = [
    "A task's id is the one in brackets, which it keeps when moved or renumbered; without one, its section, then ` › ` and its number or lead (`TODO.md#Now › A long-running process tool.`), which renumbering changes. Name it as record_topic's `task`; give a task you work on its own id by adding `<!-- task: short-name -->` to its text.",
  ];
  for (const section of new Set(open.map((item) => item.under))) {
    const items = open.filter((item) => item.under === section);
    lines.push(`${section}:`);
    // A numbered list reads as one line: "6. Usage store; 7. Usage view".
    const numbered = items.filter((item) => item.number !== null);
    if (numbered.length)
      lines.push(
        `- ${numbered.map((item) => `${item.number}. ${shown(item, NUMBERED_CHARS)}`).join("; ")}`,
      );
    for (const item of items.filter((entry) => entry.number === null))
      lines.push(`- ${shown(item, LEAD_CHARS)}`);
  }
  return lines;
};

const when = (seconds) =>
  new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");

/** The plan's live limits, as Claude Code's status line last recorded them. */
const limitLines = (status) => {
  const windows = status?.rate_limits;
  if (!windows)
    return [
      "Live limits: unknown (no reading from Claude Code's status line yet). Copilot CLI's premium requests are counted in its own quota.",
    ];
  const window = (label, entry) =>
    entry
      ? `${label} ${entry.used_percentage}% used, resets ${when(entry.resets_at)} UTC`
      : `${label} unknown`;
  return [
    `Live limits (as of ${new Date(status.at).toISOString().slice(0, 16).replace("T", " ")} UTC): ${window("5-hour window", windows.five_hour)}; ${window("weekly", windows.seven_day)}.`,
    "Measured: about 20 model calls per 1% of the 5-hour window in a fresh conversation (60k context), 2 to 5 in a long one (250k to 450k): a big task fits better in a fresh conversation.",
  ];
};

/** The project folder holding `from`: the nearest one with .rene or .git. */
export async function projectFolder(from) {
  let folder = from;
  for (;;) {
    for (const marker of [".rene", ".git"])
      if (await stat(join(folder, marker)).catch(() => undefined))
        return folder;
    const parent = dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

/**
 * The session-start text for an agent working in `cwd`.
 * @param {string | undefined} cwd the session's folder
 * @param {string | undefined} statusFile claude-status.json (terminal.mjs)
 */
export async function sessionBriefing(cwd, statusFile) {
  const folder = cwd ? await projectFolder(cwd) : undefined;
  const read = (path) =>
    path ? readFile(path, "utf8").catch(() => undefined) : undefined;
  const [briefing, found, status] = await Promise.all([
    folder ? read(join(folder, BRIEFING)) : undefined,
    folder
      ? projectTasks(folder)
      : { tasks: [], files: [], missing: [], unavailable: null },
    read(statusFile),
  ]);
  let parsedStatus;
  try {
    parsedStatus = status ? JSON.parse(status) : undefined;
  } catch {
    parsedStatus = undefined;
  }
  const project =
    briefing === undefined
      ? `_No ${BRIEFING} yet: the workbench writes it with the assessment; read .rene/assessment.md's Rules and Topics instead._`
      : briefing.length > PROJECT_CHARS
        ? `${briefing.slice(0, PROJECT_CHARS)}…\n_(cut to fit: the rest is in ${BRIEFING})_`
        : briefing;
  const head = [
    SESSION_PROCESS,
    "",
    "## Step 1: budget",
    ...limitLines(parsedStatus),
    "",
    "## Step 2: the project",
    folder ? `Project folder: ${folder}` : "Project folder: unknown.",
    project,
    "",
    "## Step 3: open tasks in TODO.md and docs/plans",
  ].join("\n");
  const tail = ["", ...toolFormLines()].join("\n");
  // Tasks fill what the budget leaves; the rest are counted.
  const items = taskLines(found);
  let room = SESSION_CHARS - head.length - tail.length - 80;
  const kept = [];
  for (const line of items) {
    if (line.length + 1 > room) break;
    kept.push(line);
    room -= line.length + 1;
  }
  if (kept.length < items.length)
    kept.push(
      `- and ${items.length - kept.length} more lines of open tasks: read ${TODO} and docs/plans.`,
    );
  return [head, ...kept, tail].join("\n");
}
