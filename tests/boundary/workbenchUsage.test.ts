import { expect, it } from "vitest";

// The Agent Terminal's usage bar (frontend/usage.mjs): one session's tokens,
// where its time went and what was wasted, from a Claude Code or Copilot CLI
// transcript as rene parses it and the workbench stores it.

interface Usage {
  readonly turns: number;
  readonly tokens: {
    readonly output: number;
    readonly calls: number;
    readonly cacheRead: number;
    readonly context: number | null;
    readonly contextLimit: number | null;
  };
  readonly time: Record<string, number>;
  readonly waste: {
    readonly reasons: readonly { reason: string; count: number; ms: number }[];
  };
  readonly signals: readonly { kind: string; count: number }[];
  readonly progress: {
    readonly current: string | null;
    readonly estimate: {
      median: number | null;
      p80: number | null;
      ranThisLong: number;
    } | null;
  };
}
const { eventsFromRecord } = (await import(
  new URL("../../frontend/conversations.mjs", import.meta.url).href
)) as { eventsFromRecord(record: unknown, format?: string): object[] };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the account summary is checked field by field.
const usageModule = (await import(
  new URL("../../frontend/usage.mjs", import.meta.url).href
)) as any;
const { sessionUsage } = usageModule as {
  sessionUsage(input: {
    conversations: { meta: object; events: object[] }[];
    since: number;
    now: number;
    topics?: Map<string, object>;
    actuals?: object;
  }): Usage;
};

const T0 = Date.parse("2026-10-23T09:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (ms: number) => new Date(T0 + ms).toISOString();

const prompt = (ms: number, text: string) => ({
  type: "user",
  timestamp: at(ms),
  message: { content: text },
});
const call = (
  ms: number,
  id: string,
  output: number,
  name: string,
  input: object,
) => ({
  type: "assistant",
  timestamp: at(ms),
  message: {
    id: `msg_${id}`,
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 10,
      output_tokens: output,
    },
    content: [{ type: "tool_use", id, name, input }],
  },
});
const result = (ms: number, id: string, text: string, isError = false) => ({
  type: "user",
  timestamp: at(ms),
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: id,
        is_error: isError,
        content: text,
      },
    ],
  },
});
const turnEnd = (ms: number) => ({
  type: "system",
  subtype: "turn_duration",
  timestamp: at(ms),
  durationMs: ms,
});

const transcript = [
  prompt(0, "add a cache to the reader"),
  call(10 * SECOND, "u1", 100, "Read", { file_path: "/p/a.ts" }),
  result(12 * SECOND, "u1", "source of a.ts"),
  // The same read, nothing changed in between.
  call(20 * SECOND, "u2", 20, "Read", { file_path: "/p/a.ts" }),
  result(21 * SECOND, "u2", "source of a.ts"),
  call(30 * SECOND, "u3", 30, "Bash", { command: "jq . x.json" }),
  result(
    31 * SECOND,
    "u3",
    "Exit code 127\n/bin/bash: line 1: jq: command not found",
    true,
  ),
  call(40 * SECOND, "u4", 50, "Edit", { file_path: "/p/a.ts" }),
  result(41 * SECOND, "u4", "ok"),
  turnEnd(60 * SECOND),
  // Five minutes later: the work went where you didn't want it.
  prompt(5 * MINUTE, "no, that's not what I asked: keep the old cache"),
  {
    type: "assistant",
    timestamp: at(5 * MINUTE + 10 * SECOND),
    message: {
      id: "msg_r",
      model: "claude-opus-5-5",
      usage: { input_tokens: 1, output_tokens: 5 },
      content: [{ type: "text", text: "Reverted." }],
    },
  },
  turnEnd(5 * MINUTE + 20 * SECOND),
];

const conversations = [
  {
    meta: { session: "s", agent: "Claude Code", format: "claude-code" },
    events: transcript.flatMap((record) => eventsFromRecord(record)),
  },
];

it("splits a session's time into working, waiting on you and wasted, counting each moment once", () => {
  const usage = sessionUsage({
    conversations,
    since: T0,
    now: T0 + 6 * MINUTE,
  });
  expect(usage.turns).toBe(2);
  expect(usage.tokens).toMatchObject({ output: 205, calls: 5 });
  expect(usage.time).toMatchObject({
    elapsed: 6 * MINUTE,
    working: 80 * SECOND,
    waitingOnYou: 6 * MINUTE - 80 * SECOND,
    // The corrected turn holds the failed and repeated calls: counted once.
    wasted: 60 * SECOND,
  });
  expect(
    Object.fromEntries(
      usage.waste.reasons.map((entry) => [
        entry.reason,
        [entry.count, entry.ms],
      ]),
    ),
  ).toEqual({ corrected: [1, 60 * SECOND], failed: [1, 0], repeated: [1, 0] });
  expect(usage.signals).toEqual([
    expect.objectContaining({ kind: "missing-program", count: 1 }),
  ]);
});

it("estimates time left only from finished topics that ran at least as long", () => {
  const topic = (id: string, status: string, first: number, last: number) => [
    id,
    {
      topic_id: id,
      title: id,
      kind: "feature",
      status,
      first_declared_at: at(first),
      declared_at: at(last),
    },
  ];
  const finished = [10, 20, 30, 40].map((minutes, index) =>
    topic(
      `done-${index}`,
      "done",
      -100 * MINUTE,
      -100 * MINUTE + minutes * MINUTE,
    ),
  );
  const usage = sessionUsage({
    conversations,
    since: T0,
    now: T0 + 6 * MINUTE,
    topics: new Map([...finished, topic("current", "open", 0, 1)] as [
      string,
      object,
    ][]),
  });
  expect(usage.progress.current).toBe("current");
  expect(usage.progress.estimate).toMatchObject({
    ranThisLong: 4,
    median: 14 * MINUTE,
    p80: 24 * MINUTE,
  });
  const tooFew = sessionUsage({
    conversations,
    since: T0,
    now: T0 + 6 * MINUTE,
    topics: new Map([finished[0], topic("current", "open", 0, 1)] as [
      string,
      object,
    ][]),
  });
  expect(tooFew.progress.estimate).toMatchObject({ median: null, p80: null });
});

it("judges a task's first estimate on all its calls, across conversations", () => {
  const { topicActuals } = usageModule;
  const declare = (ms: number, id: string) => ({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1, output_tokens: 3 },
      content: [
        {
          type: "tool_use",
          id,
          name: "mcp__rea__record_topic",
          input: { topic_id: "t1" },
        },
      ],
    },
  });
  const reply = (ms: number, id: string, output: number) => ({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id: `msg_${id}`,
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 99,
        output_tokens: output,
      },
      content: [{ type: "text", text: "done" }],
    },
  });
  // One task, two conversations: begun before a restart, finished after.
  const first = [
    prompt(0, "build it"),
    declare(SECOND, "a"),
    result(2 * SECOND, "a", "declared"),
    reply(30 * SECOND, "b", 20),
    turnEnd(MINUTE),
  ];
  const second = [
    prompt(10 * MINUTE, "carry on"),
    declare(10 * MINUTE + SECOND, "c"),
    result(10 * MINUTE + 2 * SECOND, "c", "declared"),
    reply(10 * MINUTE + 40 * SECOND, "d", 30),
    turnEnd(11 * MINUTE),
  ];
  const conversation = (session: string, records: object[]) => ({
    meta: { session, agent: "Claude Code", format: "claude-code" },
    events: records.flatMap((record) => eventsFromRecord(record)),
  });
  const later = conversation("two", second);
  const both = [conversation("one", first), later];
  const topics = new Map([
    [
      "t1",
      {
        topic_id: "t1",
        title: "Build it",
        kind: "feature",
        status: "done",
        first_declared_at: at(SECOND),
        declared_at: at(11 * MINUTE),
        first_estimate: {
          model_calls: { low: 1, high: 3 },
          output_tokens: { low: 100, high: 200 },
          confidence: "medium",
          basis: "one small change",
        },
      },
    ],
  ]);
  const usage = sessionUsage({
    conversations: [later],
    since: T0 + 10 * MINUTE,
    now: T0 + 12 * MINUTE,
    topics,
    actuals: topicActuals({ conversations: both, now: T0 + 12 * MINUTE }),
  }) as unknown as {
    progress: { topics: { accuracy: { measures: object[] } }[] };
  };
  // The window holds the second conversation only; the task is judged on both.
  expect(usage.progress.topics[0]?.accuracy.measures).toEqual([
    expect.objectContaining({
      measure: "model_calls",
      actual: 2,
      within: true,
    }),
    expect.objectContaining({
      measure: "output_tokens",
      actual: 50,
      within: false,
      over: false,
    }),
  ]);
});

it("counts use per phase and names what caused each deviation from the plan", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const assistantUse = (ms: number, use: string, input: object) => ({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id: `msg_${use}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1, output_tokens: 2 },
      content: [
        { type: "tool_use", id: use, name: "mcp__rea__record_topic", input },
      ],
    },
  });
  const reply = (ms: number, use: string) => ({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id: `msg_${use}`,
      model: "claude-opus-5-5",
      usage: { input_tokens: 1, output_tokens: 10 },
      content: [{ type: "text", text: "ok" }],
    },
  });
  const records = [
    prompt(0, "build it"),
    assistantUse(SECOND, "a", { topic_id: id, phase: "schema" }),
    result(2 * SECOND, "a", "declared"),
    reply(20 * SECOND, "b"),
    turnEnd(MINUTE),
    // You add to the scope; the agent starts a phase the plan didn't have.
    prompt(2 * MINUTE, "also add tests for it"),
    // Arguments on stdin: the phase comes from what the call printed.
    assistantUse(2 * MINUTE + SECOND, "c", {}),
    result(
      2 * MINUTE + 2 * SECOND,
      "c",
      `rene call: declared topic ${id}\n{"phase":"tests"}`,
    ),
    reply(2 * MINUTE + 30 * SECOND, "d"),
    turnEnd(3 * MINUTE),
  ];
  const conversation = {
    meta: { session: "s", agent: "Claude Code", format: "claude-code" },
    events: records.flatMap((record) => eventsFromRecord(record)),
  };
  const topics = new Map([
    [
      id,
      {
        topic_id: id,
        title: "Build it",
        kind: "feature",
        status: "done",
        first_declared_at: at(SECOND),
        declared_at: at(3 * MINUTE),
        first_plan: ["schema", "docs"],
        phases: [
          {
            name: "schema",
            started_at: at(SECOND),
            estimate: { model_calls: { low: 1, high: 2 }, confidence: "low" },
          },
          {
            name: "tests",
            started_at: at(2 * MINUTE + SECOND),
            estimate: null,
          },
        ],
      },
    ],
  ]);
  const usage = sessionUsage({
    conversations: [conversation],
    since: T0,
    now: T0 + 4 * MINUTE,
    topics,
  }) as unknown as {
    progress: {
      topics: {
        phases: {
          name: string;
          actual: { model_calls: number };
          accuracy: { measures: object[] } | null;
        }[];
        deviation: object;
      }[];
    };
  };
  const [task] = usage.progress.topics;
  expect(
    task?.phases.map((phase) => [phase.name, phase.actual.model_calls]),
  ).toEqual([
    // The call declaring the next phase is made while this one is in force.
    ["schema", 2],
    ["tests", 1],
  ]);
  expect(task?.phases[0]?.accuracy?.measures).toEqual([
    expect.objectContaining({
      measure: "model_calls",
      actual: 2,
      within: true,
    }),
  ]);
  expect(task?.deviation).toMatchObject({
    unplanned: [{ name: "tests", cause: "you" }],
    skipped: ["docs"],
    byCause: { you: 2 },
  });
});

it("counts the wait on a backgrounded command as waiting on commands, not on you", () => {
  const records = [
    prompt(0, "run the tests"),
    call(10 * SECOND, "u1", 10, "Bash", { command: "npm test" }),
    result(
      11 * SECOND,
      "u1",
      "Command was moved to the background (ID: b1). You will be notified when it completes.",
    ),
    turnEnd(20 * SECOND),
    // The command ends four minutes later and wakes the agent.
    {
      type: "user",
      timestamp: at(4 * MINUTE + 20 * SECOND),
      message: { content: "<task-notification>done</task-notification>" },
    },
    {
      type: "assistant",
      timestamp: at(4 * MINUTE + 30 * SECOND),
      message: {
        id: "msg_w",
        model: "claude-opus-5-5",
        usage: { input_tokens: 1, output_tokens: 5 },
        content: [{ type: "text", text: "Tests pass." }],
      },
    },
    turnEnd(4 * MINUTE + 40 * SECOND),
  ];
  const usage = sessionUsage({
    conversations: [
      {
        meta: { session: "s", agent: "Claude Code", format: "claude-code" },
        events: records.flatMap((record) => eventsFromRecord(record)),
      },
    ],
    since: T0,
    now: T0 + 5 * MINUTE,
  });
  expect(usage.time).toMatchObject({
    working: 30 * SECOND,
    waitingOnTools: 4 * MINUTE + 10 * SECOND,
    waitingOnYou: 20 * SECOND,
  });
});

it("counts Copilot CLI's calls as it makes them, against the context window it was given", () => {
  const record = (ms: number, id: string, output: number) => ({
    type: "session.usage_record",
    timestamp: at(ms),
    data: {
      usage: {
        model: "claude-opus-5",
        inputTokens: 1000,
        outputTokens: output,
        cacheReadTokens: 900,
        cacheWriteTokens: 90,
        maxPromptTokens: 200_000,
        accounting: { usageId: id },
      },
    },
  });
  const events = [
    {
      type: "user.message",
      timestamp: at(0),
      data: { content: "read the plan" },
    },
    record(SECOND, "u1", 20),
    record(2 * SECOND, "u2", 30),
    {
      type: "session.shutdown",
      timestamp: at(3 * SECOND),
      data: {
        totalPremiumRequests: 2,
        modelMetrics: {
          // Repeats the two calls above, which were counted as they came.
          "claude-opus-5": {
            usage: {
              inputTokens: 2000,
              outputTokens: 50,
              cacheReadTokens: 1800,
              cacheWriteTokens: 180,
            },
          },
          // A model no call was recorded of: its total is all there is.
          "gpt-5.4-nano": {
            usage: {
              inputTokens: 600,
              outputTokens: 5,
              cacheReadTokens: 100,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    },
  ].flatMap((line) => eventsFromRecord(line, "copilot-cli"));
  const usage = sessionUsage({
    conversations: [{ meta: { session: "c1", agent: "copilot-cli" }, events }],
    since: T0,
    now: T0 + MINUTE,
  });
  expect(usage.tokens).toMatchObject({
    calls: 2,
    output: 55,
    cacheRead: 1900,
    // What the last call read, of the window it was allowed.
    context: 1000,
    contextLimit: 200_000,
  });
});

it("keeps a turn under way when the window starts, counted from the window's start", () => {
  const usage = sessionUsage({
    conversations,
    // Inside the first turn, after its first call.
    since: T0 + 15 * SECOND,
    now: T0 + 6 * MINUTE,
  });
  expect(usage.turns).toBe(2);
  expect(usage.time.working).toBe(45 * SECOND + 20 * SECOND);
});

it("takes the plan's live limits from the status line over Claude Code's older cached figures", () => {
  const empty = {
    calls: 0,
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    premium_requests: 0,
  };
  const ledger = { totals: () => empty, copilotQuota: () => null };
  const plan = {
    fetched_at: at(0),
    windows: [
      {
        kind: "session",
        group: "session",
        percent: 54,
        resets_at: at(200 * MINUTE),
        active: true,
        severity: "normal",
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 49,
        resets_at: at(5 * 24 * 60 * MINUTE),
        active: false,
        severity: "normal",
      },
    ],
    extra_usage: null,
    claude_code_share: null,
    resets: null,
  };
  const live = {
    at: T0 + 30 * MINUTE,
    available: true,
    rate_limits: {
      five_hour: {
        used_percentage: 71,
        resets_at: Math.round((T0 + 200 * MINUTE) / 1000),
      },
    },
  };
  const { accountUsage } = usageModule;
  const summary = accountUsage({ plan, live, ledger, now: T0 + 31 * MINUTE });
  expect(summary.claude.plan).toMatchObject({
    live: true,
    fetchedAt: T0 + 30 * MINUTE,
    resets: null,
  });
  expect(
    summary.claude.plan.windows.map(
      (window: { group: string; percent: number }) => [
        window.group,
        window.percent,
      ],
    ),
  ).toEqual([
    ["session", 71],
    ["weekly", 49],
  ]);
  // An older status line loses to a newer cached fetch.
  const stale = accountUsage({
    plan,
    live: { ...live, at: T0 - MINUTE },
    ledger,
    now: T0 + 31 * MINUTE,
  });
  expect(stale.claude.plan).toMatchObject({ live: false });
  expect(stale.claude.plan.windows[0].percent).toBe(54);
});
