import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

// What an agent is handed when its session starts: the session process, the
// plan's live limits, the project briefing the workbench writes with the
// assessment (frontend/assessment.mjs) and TODO.md's open items
// (frontend/sessionBriefing.mjs); and the topic gate letting steps 1 to 4
// read before a declaration (frontend/topicGate.mjs).

const frontend = new URL("../../frontend/", import.meta.url);
const execute = promisify(execFile);

const briefingModule = (await import(
  new URL("sessionBriefing.mjs", frontend).href
)) as {
  SESSION_PROCESS: string;
  TOOL_FORMS: [string, Record<string, unknown>][];
  sessionBriefing(cwd: string, statusFile?: string): Promise<string>;
};
interface Task {
  id: string;
  stable: boolean;
  under: string;
  section: string;
  number: number | null;
  title: string;
  status: string;
  note: boolean;
  estimate: { model_calls: { low: number; high: number } } | null;
  topic?: { id: string; status: string } | null;
}
const tasksModule = (await import(new URL("tasks.mjs", frontend).href)) as {
  tasksOf(file: string, markdown: string): Task[];
  linkTasks(tasks: Task[], topics: Iterable<Record<string, unknown>>): Task[];
};
const { writeAssessment } = (await import(
  new URL("assessment.mjs", frontend).href
)) as {
  writeAssessment(
    folder: string,
    name: string,
    parts: Record<string, unknown>,
  ): Promise<string>;
};
type Answer =
  | {
      hookSpecificOutput?: {
        permissionDecision?: string;
        additionalContext?: string;
      };
      additionalContext?: string;
    }
  | undefined;
const { gate, copilotGate } = (await import(
  new URL("topicGate.mjs", frontend).href
)) as {
  gate(input: Record<string, unknown>, directory: string): Promise<Answer>;
  copilotGate(
    event: string,
    input: Record<string, unknown>,
    directory: string,
  ): Promise<Answer>;
};

const TODO = [
  "## Now",
  "",
  "- **Trim the copy.** Done: no hooks.",
  "- **A long-running process tool.** Nothing keeps a server up.",
  "",
  "## Agent usage and budget",
  "",
  "1. **Done: a window starting mid-turn drops that turn** (`turnsOf`).",
  "4. **Started: budget panel in the usage bar.** Built.",
  "6. **Usage store**: one row per model call. <!-- task: usage-store -->",
  "   Needs 5. 60–100 calls (3–20%).",
  "",
  "## CodeGraph",
  "",
  "- **Baseline (SQLite):** 7,010 tests.",
].join("\n");

const node = (
  topic_id: string,
  title: string,
  kind: string,
  status: string,
  children: object[] = [],
) => ({ topic_id, title, kind, status, children, turns: [], facts: [] });

/** A project with an assessment the workbench wrote, a TODO.md and limits. */
async function project() {
  const root = await createTestTempDirectory("rea-session-briefing-");
  const folder = join(root, "project");
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "TODO.md"), TODO);
  await writeAssessment(folder, "demo", {
    summary: { pathways: [], links: [], unresolved: 0, usage: [], calls: 0 },
    topics: {
      threads: [
        node("t-usage", "Agent usage", "thread", "open", [
          node("f-bar", "Usage bar", "feature", "open"),
          node("b-old", "Old bug", "bug", "done"),
        ]),
        node("t-closed", "Finished work", "thread", "done", [
          node("f-done", "Shipped", "feature", "done"),
        ]),
      ],
    },
  });
  const statusFile = join(root, "claude-status.json");
  await writeFile(
    statusFile,
    JSON.stringify({
      at: Date.parse("2026-10-24T15:00:00Z"),
      rate_limits: {
        five_hour: { used_percentage: 9, resets_at: 1792870800 },
        seven_day: { used_percentage: 69, resets_at: 1793199600 },
      },
    }),
  );
  return { root, folder, statusFile };
}

describe("session briefing", () => {
  it("lists TODO.md's items with ids from the graph's sections, status and estimates", () => {
    const items = tasksModule.tasksOf("TODO.md", TODO);
    expect(items.map(({ id, status, note }) => [id, status, note])).toEqual([
      ["TODO.md#Now › Trim the copy.", "done", false],
      ["TODO.md#Now › A long-running process tool.", "open", false],
      ["TODO.md#Agent usage and budget › 1.", "done", false],
      ["TODO.md#Agent usage and budget › 4.", "started", false],
      ["usage-store", "open", false],
      ["TODO.md#CodeGraph › Baseline (SQLite):", "open", true],
    ]);
    expect(items[3]?.title).toBe("budget panel in the usage bar.");
    expect(items[4]).toMatchObject({
      stable: true,
      under: "TODO.md#Agent usage and budget",
      section: "TODO.md#Agent usage and budget",
      number: 6,
      // From the item's own text, not the next item's.
      estimate: { model_calls: { low: 60, high: 100 } },
    });
    expect(items[3]?.estimate).toBeNull();
  });

  it("keeps a task's own id when items are renumbered, and links it to its topic", () => {
    const before = tasksModule.tasksOf("TODO.md", TODO);
    const renumbered = tasksModule.tasksOf(
      "TODO.md",
      TODO.replace(
        "6. **Usage store**",
        "2. **New first**: x.\n7. **Usage store**",
      ),
    );
    const store = (tasks: Task[]) =>
      tasks.find((task) => task.title === "Usage store");
    expect(store(renumbered)?.id).toBe(store(before)?.id);
    expect(store(renumbered)?.number).toBe(7);
    // Without its own id, the number is the id, and renumbering changes it.
    expect(store(renumbered)?.stable).toBe(true);
    expect(renumbered.find((task) => task.number === 2)?.stable).toBe(false);

    const linked = tasksModule.linkTasks(before, [
      {
        topic_id: "old",
        task: "usage-store",
        status: "done",
        declared_at: "2026-10-24T10:00:00Z",
      },
      {
        topic_id: "now",
        task: "usage-store",
        status: "open",
        declared_at: "2026-10-23T10:00:00Z",
      },
      {
        topic_id: "later",
        task: "usage-store",
        status: "done",
        declared_at: "2026-10-24T12:00:00Z",
      },
    ]);
    // An open topic over a closed one, however recent.
    expect(store(linked)?.topic).toMatchObject({ id: "now", status: "open" });
    expect(linked[0]?.topic).toBeNull();
  });

  it("reads a plan's numbered headings as its steps", () => {
    const plan = [
      "# Plan",
      "## What gets built",
      "### 1. Docs in the graph — built",
      "Done.",
      "### 2. Subsystems <!-- task: subsystems -->",
      "About 30–50 calls.",
      "#### Detail",
      "Not its estimate: 1–2 calls.",
      "## Costs",
      "- **Divergence.** Not a task.",
    ].join("\n");
    const steps = tasksModule.tasksOf("docs/plans/p.md", plan);
    expect(steps.map(({ id, status, title }) => [id, status, title])).toEqual([
      [
        "docs/plans/p.md#Plan#What gets built › 1.",
        "done",
        "Docs in the graph",
      ],
      ["subsystems", "open", "Subsystems"],
    ]);
    expect(steps[1]).toMatchObject({
      under: "docs/plans/p.md#Plan#What gets built",
      estimate: { model_calls: { low: 30, high: 50 } },
    });
  });

  it("hands a starting session the process, limits, open topics and open items", async () => {
    const { folder, statusFile } = await project();
    const briefing = await readFile(
      join(folder, ".rene", "briefing.md"),
      "utf8",
    );
    // Only open work, with the ids a declaration continues it by.
    expect(briefing).toContain("Thread **Agent usage** — open (`t-usage`)");
    expect(briefing).toContain("**Usage bar** — feature, open (`f-bar`)");
    expect(briefing).not.toContain("Old bug");
    expect(briefing).not.toContain("Finished work");
    expect(briefing).toContain("2 closed threads and topics");

    // From a folder inside the project, as an agent's cwd may be.
    const text = await briefingModule.sessionBriefing(
      join(folder, "src"),
      statusFile,
    );
    expect(text.startsWith(briefingModule.SESSION_PROCESS)).toBe(true);
    expect(text).toContain("5-hour window 9% used");
    expect(text).toContain("weekly 69% used");
    expect(text).toContain("`f-bar`");
    // A numbered list reads as one line.
    expect(text).toContain(
      "- 4. budget panel in the usage bar. (started); 6. Usage store [usage-store]",
    );
    expect(text).toContain("TODO.md#Agent usage and budget:");
    expect(text).not.toContain("Trim the copy");
    expect(text).not.toContain("Baseline");
    // Kept under the 10,000 characters Claude Code hands over inline: a
    // long TODO.md is cut, and what was left out is counted.
    await writeFile(
      join(folder, "TODO.md"),
      Array.from(
        { length: 400 },
        (_, index) => `- **Open item ${String(index)} with a longish title.**`,
      ).join("\n"),
    );
    const long = await briefingModule.sessionBriefing(folder, statusFile);
    expect(long.length).toBeLessThan(10_000);
    expect(long).toMatch(
      /- and \d+ more lines of open tasks: read TODO\.md and docs\/plans\./u,
    );
    // A part it can't read is named, not dropped.
    const bare = await briefingModule.sessionBriefing(join(folder, "src"));
    expect(bare).toContain("Live limits: unknown");
  });

  it("names only arguments the tools take", async () => {
    const schemas = await Promise.all(
      briefingModule.TOOL_FORMS.map(async ([tool]) => {
        const { stdout } = await execute(process.execPath, [
          resolve("scripts/rene.mjs"),
          "tools",
          "describe",
          tool,
        ]);
        return (
          JSON.parse(stdout) as {
            input_schema: { properties: Record<string, unknown> };
          }
        ).input_schema.properties;
      }),
    );
    briefingModule.TOOL_FORMS.forEach(([tool, args], index) => {
      for (const name of Object.keys(args))
        expect(Object.keys(schemas[index]!), `${tool}.${name}`).toContain(name);
    });
  }, 60_000);
});

describe("session start in the topic gate", () => {
  it("briefs Claude Code and Copilot CLI at session start, and lets steps 1 to 4 read before a declaration", async () => {
    const { root, folder } = await project();
    // The gate's state folder sits beside the status file.
    const directory = join(root, "topic-gate");
    await mkdir(directory);
    const claude = await gate(
      { hook_event_name: "SessionStart", session_id: "s", cwd: folder },
      directory,
    );
    expect(claude?.hookSpecificOutput?.additionalContext).toContain(
      "5-hour window 9% used",
    );
    const copilot = await copilotGate(
      "sessionStart",
      { sessionId: "c", cwd: folder },
      directory,
    );
    expect(copilot?.additionalContext).toContain("How this session works");
    expect(copilot?.additionalContext).toContain("`f-bar`");

    await gate(
      { hook_event_name: "UserPromptSubmit", session_id: "s" },
      directory,
    );
    const bash = (command: string) =>
      gate(
        {
          hook_event_name: "PreToolUse",
          session_id: "s",
          tool_name: "Bash",
          tool_input: { command },
        },
        directory,
      );
    const decision = (answer: Answer) =>
      answer?.hookSpecificOutput?.permissionDecision;
    expect(
      decision(
        await bash(`rene call read_file '{"path":"/p/TODO.md"}' | head -50`),
      ),
    ).toBeUndefined();
    expect(
      decision(
        await bash(
          `rene call list_agent_conversations '{"project_path":"/p"}'`,
        ),
      ),
    ).toBeUndefined();
    // Working, not orienting: still waits for the declaration.
    expect(
      decision(
        await bash(
          `rene call edit_file '{"path":"/p/a","old_text":"a","new_text":"b"}'`,
        ),
      ),
    ).toBe("deny");
    expect(
      decision(
        await bash(
          `rene call read_file '{"path":"/p/a"}'; rene call run_command '{"command":"ls","cwd":"/p"}'`,
        ),
      ),
    ).toBe("deny");
  });
});
