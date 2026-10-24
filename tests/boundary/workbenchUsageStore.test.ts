import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

// The usage store (frontend/usageStore.mjs): one row per model call, tool
// call and message of yours that turned the work, classified once by
// frontend/usage.mjs and sealed as Parquet through CodeGraph's store addon.

interface Row {
  kind: string;
  id: string | null;
  at: number;
  tool?: string;
  outcome?: string;
  topic: string | null;
  waste: { reason: string; text: string } | null;
  deviation: { cause: string; kind: string; text: string } | null;
}
const { eventsFromRecord } = (await import(
  new URL("../../frontend/conversations.mjs", import.meta.url).href
)) as { eventsFromRecord(record: unknown, format?: string): object[] };
const { topicActuals } = (await import(
  new URL("../../frontend/usage.mjs", import.meta.url).href
)) as {
  topicActuals(input: {
    conversations: { meta: object; events: object[] }[];
    now: number;
  }): { ledger: Row[] };
};
const { createUsageStore } = (await import(
  new URL("../../frontend/usageStore.mjs", import.meta.url).href
)) as {
  createUsageStore(directory: string): {
    write(input: {
      project: string;
      ledger: Row[];
    }):
      | { ok: true; generation: number; rows: number }
      | { ok: false; reason: string };
    query(
      sql: string,
    ):
      | { ok: true; rows: Record<string, unknown>[] }
      | { ok: false; reason: string };
  };
};

interface Measures {
  model_calls: number;
  tool_calls: number;
  output: number;
  wasted_model_calls: number;
  deviations: number;
  turns: number;
}
interface Group {
  dimension: string;
  value: string | null;
  label: string;
  measures: Measures;
  children: Group[];
}
type Store = ReturnType<typeof createUsageStore>;
const view = (await import(
  new URL("../../frontend/usageView.mjs", import.meta.url).href
)) as {
  parseUsageRequest(params: URLSearchParams): object;
  usageSlice(
    stores: { project: string; store: Store }[],
    request: object,
    names?: { label(dimension: string, value: string): string | undefined },
  ): {
    total: Measures;
    groups: Group[];
    timeline: { bucket: string; points: ({ key: string } & Measures)[] };
    unreadable: { project: string; reason: string }[];
  };
  usageTurns(
    stores: { project: string; store: Store }[],
    request: object,
  ): {
    turns: {
      conversation: string;
      turnAt: number | null;
      measures: Measures;
    }[];
  };
  usageTurnRows(
    store: Store,
    turn: { conversation: string; turnAt: number | null },
  ): { rows: Record<string, unknown>[] };
};

const T0 = Date.parse("2026-10-24T09:00:00.000Z");
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const at = (ms: number) => new Date(T0 + ms).toISOString();
const prompt = (ms: number, text: string) => ({
  type: "user",
  timestamp: at(ms),
  message: { content: text },
});
const call = (ms: number, id: string, name: string, input: object) => ({
  type: "assistant",
  timestamp: at(ms),
  message: {
    id: `msg_${id}`,
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 10,
      output_tokens: 20,
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

const conversations = [
  {
    meta: { session: "s", agent: "Claude Code", format: "claude-code" },
    events: [
      prompt(0, "add a cache to the reader"),
      call(10 * SECOND, "u1", "Read", { file_path: "/p/a.ts" }),
      result(12 * SECOND, "u1", "source of a.ts"),
      call(20 * SECOND, "u2", "Read", { file_path: "/p/a.ts" }),
      result(21 * SECOND, "u2", "source of a.ts"),
      call(30 * SECOND, "u3", "Bash", { command: "jq . x.json" }),
      result(
        31 * SECOND,
        "u3",
        "/bin/bash: line 1: jq: command not found",
        true,
      ),
      turnEnd(60 * SECOND),
      prompt(5 * MINUTE, "no, that's not what I asked: keep the old cache"),
      call(5 * MINUTE + 10 * SECOND, "u4", "Edit", { file_path: "/p/a.ts" }),
      result(5 * MINUTE + 11 * SECOND, "u4", "ok"),
      turnEnd(5 * MINUTE + 20 * SECOND),
      prompt(6 * MINUTE, "also add a test for the cache"),
      turnEnd(6 * MINUTE + 5 * SECOND),
    ].flatMap((record) => eventsFromRecord(record)),
  },
];

it("classifies every model call, tool call and turning message once, in time order", () => {
  const { ledger } = topicActuals({ conversations, now: T0 + 7 * MINUTE });
  const shape = ledger.map((row) => [
    row.kind,
    row.tool ?? null,
    row.outcome ?? null,
    row.waste?.reason ?? null,
    row.deviation ? `${row.deviation.cause}/${row.deviation.kind}` : null,
  ]);
  expect(shape).toEqual([
    // The turn you corrected: its calls are waste for that, unless the call
    // was waste in itself (a repeat, a failure).
    ["model", null, null, "corrected", null],
    ["tool", "Read", "ok", "corrected", null],
    ["model", null, null, "corrected", null],
    ["tool", "Read", "ok", "repeated", null],
    ["model", null, null, "corrected", null],
    ["tool", "Bash", "error", "failed", "assumption/missing-program"],
    // Your messages: the correction and the added scope are rows too.
    ["message", null, null, null, "assumption/corrected"],
    ["model", null, null, null, null],
    ["tool", "Edit", "ok", null, null],
    ["message", null, null, null, "you/scope-added"],
  ]);
  expect(ledger.find((row) => row.tool === "Bash")?.deviation?.text).toBe(
    "Bash: /bin/bash: line 1: jq: command not found",
  );
  // Nothing was declared: the rows say so rather than guess a topic.
  expect(ledger.every((row) => row.topic === null)).toBe(true);
});

it("seals the ledger as Parquet and reads it back after a restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rene-usage-store-"));
  try {
    const { ledger } = topicActuals({ conversations, now: T0 + 7 * MINUTE });
    const written = createUsageStore(directory).write({
      project: "/p",
      ledger,
    });
    expect(written).toEqual({ ok: true, generation: 1, rows: ledger.length });
    // Writing again replaces the rows, as a new generation.
    expect(
      createUsageStore(directory).write({ project: "/p", ledger }),
    ).toMatchObject({
      ok: true,
      generation: 2,
    });
    const reopened = createUsageStore(directory).query(
      "select kind, count(*)::integer as n, sum(output_tokens)::integer as output, count(deviation_cause)::integer as deviations from calls group by kind order by kind",
    );
    expect(reopened).toEqual({
      ok: true,
      rows: [
        { kind: "message", n: 2, output: null, deviations: 2 },
        { kind: "model", n: 4, output: 80, deviations: 0 },
        { kind: "tool", n: 4, output: null, deviations: 1 },
      ],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("gives each row the turn it was in: its request's time", () => {
  const { ledger } = topicActuals({ conversations, now: T0 + 7 * MINUTE });
  const turns = ledger.map(
    (row) => [row.kind, (row as { turn?: number }).turn] as const,
  );
  // Your correction starts the second turn and the added scope the third:
  // each message row is in the turn it starts.
  expect(turns).toEqual([
    ...Array.from({ length: 6 }, (_, index) => [
      index % 2 ? "tool" : "model",
      T0,
    ]),
    ["message", T0 + 5 * MINUTE],
    ["model", T0 + 5 * MINUTE],
    ["tool", T0 + 5 * MINUTE],
    ["message", T0 + 6 * MINUTE],
  ]);
});

it("slices the store by nested dimensions, over time, and drills to a turn's rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rene-usage-view-"));
  const other = await mkdtemp(join(tmpdir(), "rene-usage-view-"));
  try {
    const { ledger } = topicActuals({ conversations, now: T0 + 7 * MINUTE });
    const store = createUsageStore(directory);
    store.write({ project: "/p", ledger });
    // A second project's store: its own conversation, merged into the slice.
    const second = createUsageStore(other);
    second.write({
      project: "/q",
      ledger: ledger.map((row) => ({ ...row, conversation: "t" })),
    });
    const stores = [
      { project: "/p", store },
      { project: "/q", store: second },
    ];
    const request = view.parseUsageRequest(
      new URLSearchParams({ by: "project,waste", measure: "model_calls" }),
    );
    const slice = view.usageSlice(stores, request);
    expect(slice.unreadable).toEqual([]);
    expect(slice.total).toMatchObject({
      model_calls: 8,
      tool_calls: 8,
      output: 160,
      wasted_model_calls: 6,
      deviations: 6,
      turns: 6,
    });
    expect(
      slice.groups.map((group) => [
        group.value,
        group.measures.model_calls,
        group.children.map((child) => [
          child.label,
          child.measures.model_calls,
          child.measures.tool_calls,
        ]),
      ]),
    ).toEqual([
      [
        "/p",
        4,
        [
          ["corrected", 3, 1],
          ["Not wasted", 1, 1],
          ["failed", 0, 1],
          ["repeated", 0, 1],
        ],
      ],
      ["/q", 4, expect.any(Array)],
    ]);
    // A period of minutes is shown by the hour, in the page's time zone.
    expect(slice.timeline.bucket).toBe("hour");
    expect(
      view
        .usageSlice(
          stores,
          view.parseUsageRequest(new URLSearchParams({ by: "", tz: "120" })),
        )
        .timeline.points.map((point) => [point.key, point.model_calls]),
    ).toEqual([["2026-10-24 11:00", 8]]);
    // Filters: a missing value is null; a name comes from the bridge.
    const unwasted = view.usageSlice(
      stores,
      view.parseUsageRequest(
        new URLSearchParams({
          by: "topic",
          filters: JSON.stringify({ project: "/p", waste: null }),
        }),
      ),
      { label: () => "never asked: every topic is null" },
    );
    expect(
      unwasted.groups.map((group) => [group.label, group.measures.model_calls]),
    ).toEqual([["In no task", 1]]);
    // The turns the filtered calls were in, newest first, then one's rows.
    const turns = view.usageTurns(
      stores,
      view.parseUsageRequest(
        new URLSearchParams({ filters: JSON.stringify({ project: "/p" }) }),
      ),
    );
    expect(
      turns.turns.map((turn) => [turn.turnAt, turn.measures.model_calls]),
    ).toEqual([
      [T0 + 6 * MINUTE, 0],
      [T0 + 5 * MINUTE, 1],
      [T0, 3],
    ]);
    const rows = view.usageTurnRows(store, {
      conversation: "s",
      turnAt: T0,
    }).rows;
    expect(rows.map((row) => [row.kind, row.tool, row.waste_reason])).toEqual([
      ["model", null, "corrected"],
      ["tool", "Read", "corrected"],
      ["model", null, "corrected"],
      ["tool", "Read", "repeated"],
      ["model", null, "corrected"],
      ["tool", "Bash", "failed"],
    ]);
    expect(() =>
      view.parseUsageRequest(new URLSearchParams({ by: "topic; drop" })),
    ).toThrow("Unknown dimension");
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
