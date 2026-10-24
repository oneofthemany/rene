import { expect, it } from "vitest";

// The workbench's topic tree (frontend/topics.mjs): threads > topics > turns
// > calls, rebuilt from the record_topic declarations in a project's history.

interface Entry {
  readonly id: string;
  readonly startedAt: number;
  readonly name: string;
  readonly outcome: string;
  readonly source?: string;
  readonly agent?: string;
  readonly args?: Record<string, unknown>;
}
interface TopicNode {
  readonly topic_id: string;
  readonly kind: string;
  readonly status: string;
  readonly declarations: number;
  readonly declared_by: string;
  readonly orphan?: boolean;
  readonly children: readonly TopicNode[];
  readonly turns: readonly { index: number }[];
  readonly calls: readonly string[];
  readonly facts: readonly {
    topic_id: string;
    shared: readonly { kind: string; value: string }[];
  }[];
}
const topicsModule = (await import(
  new URL("../../frontend/topics.mjs", import.meta.url).href
)) as {
  currentTopics(history: {
    list(filter: Record<string, unknown>): Promise<Entry[]>;
    result(id: string): Promise<unknown>;
  }): Promise<unknown>;
  topicTree(
    declared: unknown,
    turns: readonly unknown[],
    history: readonly Entry[],
  ): { threads: TopicNode[]; loose_turns: { index: number }[] };
};

const THREAD = "00000000-0000-4000-8000-000000000001";
const FEATURE = "00000000-0000-4000-8000-000000000002";
const BUG = "00000000-0000-4000-8000-000000000003";
const UNKNOWN_PARENT = "00000000-0000-4000-8000-0000000000ff";

/** A recorded call and the result the store keeps for it. */
const recorded: { entry: Entry; result?: unknown }[] = [];
let clock = Date.parse("2026-10-20T10:00:00Z");
const record = (
  id: string,
  name: string,
  { outcome = "ok", args, result }: Partial<Entry> & { result?: unknown } = {},
) => {
  clock += 1_000;
  recorded.push({
    entry: {
      id,
      startedAt: clock,
      name,
      outcome,
      source: "agent",
      agent: "Claude Code",
      ...(args ? { args } : {}),
    },
    result,
  });
};
const declare = (
  id: string,
  topic: Record<string, unknown>,
  asText = false,
) => {
  const normalized_result = {
    status: "open",
    parent_id: null,
    ...topic,
    declared_at: new Date(clock + 1_000).toISOString(),
  };
  // Stored results carry structured content, or only its JSON text.
  const result = asText
    ? {
        content: [
          { type: "text", text: JSON.stringify({ normalized_result }) },
        ],
      }
    : { structuredContent: { normalized_result } };
  record(id, "record_topic", { result });
};

declare("d-thread", { topic_id: THREAD, kind: "thread", title: "Work" });
declare("d-feature", {
  topic_id: FEATURE,
  kind: "feature",
  title: "Feature",
  parent_id: THREAD,
});
record("h-feature-read", "read_file", { args: { path: "/shared.ts" } });
declare(
  "d-bug",
  { topic_id: BUG, kind: "bug", title: "Bug", parent_id: UNKNOWN_PARENT },
  true,
);
record("h-bug-read", "read_file", { args: { path: "/shared.ts" } });
record("d-failed", "record_topic", { outcome: "error" });
declare("d-thread-again", { topic_id: THREAD, kind: "thread", title: "Work" });
declare("d-feature-done", {
  topic_id: FEATURE,
  kind: "feature",
  title: "Feature",
  parent_id: THREAD,
  status: "done",
});

const history = {
  list: async ({ name, outcome }: Record<string, unknown>) =>
    recorded
      .map(({ entry }) => entry)
      .filter((entry) => entry.name === name && entry.outcome === outcome)
      .reverse(),
  result: async (id: string) =>
    recorded.find(({ entry }) => entry.id === id)?.result,
};

/** A turn whose events are tool uses tied to these recorded calls. */
const turn = (index: number, historyIds: readonly string[]) => ({
  session: "s1",
  index,
  at: new Date(Date.parse("2026-10-20T10:00:00Z") + index).toISOString(),
  prompt: `request ${String(index)}`,
  events: historyIds.map((historyId) => ({
    kind: "tool_use",
    tool: recorded.find(({ entry }) => entry.id === historyId)!.entry.name,
    rea: true,
    historyId,
  })),
});

it("builds threads, topics and turns from declarations, with factual links", async () => {
  const declared = await topicsModule.currentTopics(history);
  const { threads, loose_turns } = topicsModule.topicTree(
    declared,
    [
      turn(0, ["d-thread", "d-feature", "h-feature-read"]),
      turn(1, ["d-bug", "h-bug-read"]),
      // Declares nothing: carried under the topic turn 1 ended in.
      turn(2, []),
      // Declares two topics: the turn is listed under both.
      turn(3, ["d-thread-again", "d-feature-done"]),
    ],
    recorded.map(({ entry }) => entry),
  );

  expect(threads.map(({ topic_id, orphan }) => [topic_id, orphan])).toEqual([
    [THREAD, false],
    [BUG, true],
  ]);
  const [thread, bug] = threads as [TopicNode, TopicNode];
  expect(thread.declarations).toBe(2);
  expect(thread.turns.map(({ index }) => index)).toEqual([0, 3]);
  const [feature] = thread.children as [TopicNode];
  expect(feature).toMatchObject({
    topic_id: FEATURE,
    status: "done",
    declarations: 2,
    declared_by: "Claude Code",
  });
  expect(feature.turns.map(({ index }) => index)).toEqual([0, 3]);
  expect(bug.turns).toEqual([
    expect.objectContaining({ index: 1, basis: "declared" }),
    expect.objectContaining({ index: 2, basis: "carried", calls: [] }),
  ]);
  expect(loose_turns).toEqual([]);

  // Topics whose calls read the same file are linked by it; declarations
  // themselves link nothing.
  expect(feature.facts).toEqual([
    { topic_id: BUG, shared: [{ kind: "file", value: "/shared.ts" }], more: 0 },
  ]);
  expect(bug.facts).toEqual([
    {
      topic_id: FEATURE,
      shared: [{ kind: "file", value: "/shared.ts" }],
      more: 0,
    },
  ]);
});

it("carries a topic into turns that declare nothing, marked, and leaves only turns before any declaration loose", async () => {
  const declared = await topicsModule.currentTopics(history);
  const inSession = (
    session: string,
    index: number,
    ids: readonly string[],
  ) => ({
    ...turn(index, ids),
    session,
    at: new Date(Date.parse("2026-10-21T10:00:00Z") + index).toISOString(),
  });
  const { threads, loose_turns } = topicsModule.topicTree(
    declared,
    [
      // Nothing declared yet in this conversation: in no topic.
      inSession("s2", 0, ["h-bug-read"]),
      inSession("s2", 1, ["d-feature"]),
      // Declares nothing: its call is carried under the feature.
      inSession("s2", 2, ["h-feature-read"]),
      // Another conversation carries nothing in from s2.
      inSession("s3", 3, ["h-feature-read"]),
      // A turn that closes its topic carries nothing on.
      inSession("s4", 4, ["d-feature-done"]),
      inSession("s4", 5, ["h-bug-read"]),
    ],
    recorded.map(({ entry }) => entry),
  );
  const [thread] = threads as [TopicNode];
  const [feature] = thread.children as [TopicNode];
  expect(feature.turns).toEqual([
    expect.objectContaining({ index: 1, basis: "declared" }),
    expect.objectContaining({
      index: 2,
      basis: "carried",
      calls: ["h-feature-read"],
    }),
    expect.objectContaining({ index: 4, basis: "declared" }),
  ]);
  expect(loose_turns).toEqual([
    expect.objectContaining({ session: "s2", index: 0, calls: ["h-bug-read"] }),
    expect.objectContaining({ session: "s3", index: 3 }),
    expect.objectContaining({ session: "s4", index: 5 }),
  ]);
});
