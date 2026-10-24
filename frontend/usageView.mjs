// The usage view's reading of the usage store (usageStore.mjs): its calls
// sliced by up to three dimensions (agent, project, conversation › topic ›
// phase, waste reason, deviation cause, time…), a timeline, and the drill-down
// to a turn's rows. It owns the SQL; the bridge only picks the stores, one per
// project, and names what the ids are (topic titles, turn requests). A slice
// over several projects merges each store's groups: every measure is a sum,
// a count of rows or of turns (a turn is in one conversation, so in one
// store), or a first or last time.

const NONE = "\u0000none";

/** What a slice can group and filter by: label, SQL, and the name of a missing value. */
export const DIMENSIONS = {
  agent: { label: "Agent", sql: () => "agent", none: "Unknown agent" },
  project: { label: "Project", sql: () => "project", none: "No project" },
  conversation: {
    label: "Conversation",
    sql: () => "conversation",
    none: "No conversation",
  },
  topic: { label: "Topic", sql: () => "topic", none: "In no task" },
  phase: { label: "Phase", sql: () => "phase", none: "No phase" },
  basis: {
    label: "Attributed by",
    sql: () => "basis",
    none: "Not attributed",
  },
  kind: { label: "Row kind", sql: () => "kind", none: "–" },
  model: {
    label: "Model",
    sql: () => "model",
    none: "No model (not a model call)",
  },
  tool: { label: "Tool", sql: () => "tool", none: "No tool (not a tool call)" },
  outcome: { label: "Outcome", sql: () => "outcome", none: "–" },
  waste: {
    label: "Waste reason",
    sql: () => "waste_reason",
    none: "Not wasted",
  },
  deviation: {
    label: "Deviation cause",
    sql: () => "deviation_cause",
    none: "No deviation",
  },
  deviationKind: {
    label: "Deviation kind",
    sql: () => "deviation_kind",
    none: "No deviation",
  },
  day: {
    label: "Day",
    sql: (offset) => `strftime(epoch_ms(at_ms + ${offset}), '%Y-%m-%d')`,
    none: "–",
    time: true,
  },
  hour: {
    label: "Hour",
    sql: (offset) => `strftime(epoch_ms(at_ms + ${offset}), '%Y-%m-%d %H:00')`,
    none: "–",
    time: true,
  },
};

/** Each measure, and the part of it that was wasted (what a bar shades). */
export const MEASURES = {
  model_calls: { label: "Model calls", wasted: "wasted_model_calls" },
  output: { label: "Output tokens", wasted: "wasted_output" },
  context: { label: "Context tokens read", wasted: "wasted_context" },
  tool_calls: { label: "Tool calls", wasted: "wasted_tool_calls" },
  turns: { label: "Turns", wasted: null },
};

const SUMS = `count(*) filter (where kind = 'model')::bigint as model_calls,
  count(*) filter (where kind = 'tool')::bigint as tool_calls,
  coalesce(sum(input_tokens), 0)::bigint as input,
  coalesce(sum(cache_read_tokens), 0)::bigint as cache_read,
  coalesce(sum(cache_write_tokens), 0)::bigint as cache_write,
  coalesce(sum(output_tokens), 0)::bigint as output,
  coalesce(sum(context_tokens), 0)::bigint as context,
  count(*) filter (where kind = 'model' and waste_reason is not null)::bigint as wasted_model_calls,
  count(*) filter (where kind = 'tool' and waste_reason is not null)::bigint as wasted_tool_calls,
  coalesce(sum(output_tokens) filter (where waste_reason is not null), 0)::bigint as wasted_output,
  coalesce(sum(context_tokens) filter (where waste_reason is not null), 0)::bigint as wasted_context,
  count(deviation_cause)::bigint as deviations,
  count(*) filter (where outcome in ('refused', 'error'))::bigint as failed,
  count(distinct conversation || ':' || coalesce(turn_at::varchar, ''))::bigint as turns`;
const TIMES = `min(at_ms)::bigint as first_at, max(at_ms)::bigint as last_at`;
const SUMMED = [
  "model_calls",
  "tool_calls",
  "input",
  "cache_read",
  "cache_write",
  "output",
  "context",
  "wasted_model_calls",
  "wasted_tool_calls",
  "wasted_output",
  "wasted_context",
  "deviations",
  "failed",
  "turns",
];

const emptyMeasures = () => ({
  ...Object.fromEntries(SUMMED.map((name) => [name, 0])),
  first_at: null,
  last_at: null,
});

function addMeasures(into, row) {
  for (const name of SUMMED) into[name] += Number(row[name] ?? 0);
  for (const [name, pick] of [
    ["first_at", Math.min],
    ["last_at", Math.max],
  ])
    if (row[name] !== null && row[name] !== undefined)
      into[name] =
        into[name] === null
          ? Number(row[name])
          : pick(into[name], Number(row[name]));
  return into;
}

export class UsageQueryError extends Error {}

const MAX_LEVELS = 3;
// Groups shown under each parent, largest first; the rest are counted.
const MAX_GROUPS = 100;
const MAX_TURNS = 100;
const MAX_ROWS = 500;

/**
 * A slice's request from the page's query string, checked: `by` (comma
 * separated dimensions), `measure`, `filters` (JSON: dimension -> value, null
 * for a missing one), `from` and `to` (ms) and `tz` (the page's offset from
 * UTC, in minutes, for days and hours).
 * @param {URLSearchParams} params
 */
export function parseUsageRequest(params) {
  const by = (params.get("by") ?? "topic,phase")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (by.length > MAX_LEVELS)
    throw new UsageQueryError(`Group by at most ${MAX_LEVELS} dimensions.`);
  for (const name of by)
    if (!Object.hasOwn(DIMENSIONS, name))
      throw new UsageQueryError(`Unknown dimension ${name}.`);
  const measure = params.get("measure") ?? "model_calls";
  if (!Object.hasOwn(MEASURES, measure))
    throw new UsageQueryError(`Unknown measure ${measure}.`);
  let filters = {};
  const filterText = params.get("filters");
  if (filterText) {
    try {
      filters = JSON.parse(filterText);
    } catch {
      throw new UsageQueryError("filters must be a JSON object.");
    }
    if (
      typeof filters !== "object" ||
      filters === null ||
      Array.isArray(filters)
    )
      throw new UsageQueryError("filters must be a JSON object.");
    for (const [name, value] of Object.entries(filters)) {
      if (!Object.hasOwn(DIMENSIONS, name))
        throw new UsageQueryError(`Unknown dimension ${name}.`);
      if (value !== null && typeof value !== "string")
        throw new UsageQueryError(
          `The ${name} filter must be a string or null.`,
        );
    }
  }
  const time = (name) => {
    const text = params.get(name);
    if (text === null || text === "") return null;
    const value = Number(text);
    if (!Number.isSafeInteger(value))
      throw new UsageQueryError(`${name} must be a time in milliseconds.`);
    return value;
  };
  const tzText = params.get("tz") ?? "0";
  const tz = Number(tzText);
  // UTC-12 to UTC+14.
  if (!Number.isInteger(tz) || tz < -12 * 60 || tz > 14 * 60)
    throw new UsageQueryError("tz must be minutes from UTC.");
  return { by, measure, filters, from: time("from"), to: time("to"), tz };
}

/** The where clause and its values for a request's filters and period. */
function whereOf({ filters = {}, from = null, to = null, tz = 0 }) {
  const offset = tz * 60_000;
  const clauses = [];
  const values = [];
  for (const [name, value] of Object.entries(filters)) {
    const sql = DIMENSIONS[name].sql(offset);
    if (value === null) clauses.push(`${sql} is null`);
    else {
      clauses.push(`${sql} = ?`);
      values.push(value);
    }
  }
  if (from !== null) {
    clauses.push("at_ms >= ?");
    values.push(from);
  }
  if (to !== null) {
    clauses.push("at_ms < ?");
    values.push(to);
  }
  return {
    sql: clauses.length ? `where ${clauses.join(" and ")}` : "",
    values,
  };
}

function run(store, sql, values) {
  const result = store.query(sql, values);
  if (!result.ok) throw new Error(result.reason);
  return result.rows;
}

/**
 * Each store's rows, with the stores that couldn't be read named rather than
 * dropped silently.
 */
function across(stores, read) {
  const rows = [];
  const unreadable = [];
  for (const { project, store } of stores) {
    try {
      rows.push(...read(store).map((row) => ({ ...row, $project: project })));
    } catch (error) {
      unreadable.push({
        project,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rows, unreadable };
}

/**
 * The calls grouped by `by`, nested a level per dimension, each group with
 * its measures; and the same calls over time (days, or hours over a period
 * of two days or less).
 * @param {{ project: string, store: object }[]} stores
 * @param {ReturnType<typeof parseUsageRequest>} request
 * @param {{ label?: (dimension: string, value: string) => string | undefined }} [names]
 */
export function usageSlice(stores, request, { label } = {}) {
  const { by, measure, tz } = request;
  const offset = tz * 60_000;
  const where = whereOf(request);
  const expressions = by.map((name) => DIMENSIONS[name].sql(offset));
  // Every level's own row (rollup): a turn spans groups, so its count isn't
  // the sum of its children's. `rolled` says which keys a row rolled up.
  const keys = expressions.length
    ? [
        ...expressions.map((sql, index) => `${sql} as k${index}`),
        `grouping(${expressions.join(", ")})::integer as rolled`,
      ]
    : [];
  const sliced = across(stores, (store) =>
    run(
      store,
      `select ${[...keys, SUMS, TIMES].join(", ")} from calls ${where.sql}${expressions.length ? ` group by rollup(${expressions.join(", ")})` : ""}`,
      where.values,
    ),
  );
  const root = node(null, null, null);
  for (const row of sliced.rows) {
    let rolledUp = 0;
    for (let bits = row.rolled ?? 0; bits; bits >>= 1) rolledUp += bits & 1;
    const depth = by.length - rolledUp;
    let at = root;
    for (const [index, name] of by.slice(0, depth).entries()) {
      const value = row[`k${index}`] ?? null;
      const id = value ?? NONE;
      let child = at.children.get(id);
      if (!child) {
        child = node(
          name,
          value,
          value === null
            ? DIMENSIONS[name].none
            : (label?.(name, value) ?? value),
        );
        at.children.set(id, child);
      }
      at = child;
    }
    // Its level's measures, each store's added (a turn is in one store).
    addMeasures(at.measures, row);
  }
  const span =
    root.measures.first_at === null
      ? 0
      : (request.to ?? root.measures.last_at) -
        (request.from ?? root.measures.first_at);
  const bucket = span <= 2 * 24 * 60 * 60_000 ? "hour" : "day";
  const timeline = across(stores, (store) =>
    run(
      store,
      `select ${DIMENSIONS[bucket].sql(offset)} as k, ${SUMS}, ${TIMES} from calls ${where.sql} group by k`,
      where.values,
    ),
  );
  const buckets = new Map();
  for (const row of timeline.rows)
    addMeasures(
      buckets.get(row.k) ?? buckets.set(row.k, emptyMeasures()).get(row.k),
      row,
    );
  return {
    by,
    measure,
    total: root.measures,
    groups: finish(root, measure).children,
    timeline: {
      bucket,
      points: [...buckets.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, measures]) => ({ key, ...measures })),
    },
    unreadable: dedupe([...sliced.unreadable, ...timeline.unreadable]),
  };
}

const node = (dimension, value, label) => ({
  dimension,
  value,
  label,
  measures: emptyMeasures(),
  children: new Map(),
});

/** A node's children as a list: largest first (in time order for days and hours), at most MAX_GROUPS. */
function finish(entry, measure) {
  const children = [...entry.children.values()];
  const time = children.length > 0 && DIMENSIONS[children[0].dimension].time;
  children.sort((a, b) =>
    time
      ? String(a.value).localeCompare(String(b.value))
      : b.measures[measure] - a.measures[measure] ||
        String(a.label).localeCompare(String(b.label)),
  );
  const shown = children.slice(0, MAX_GROUPS);
  return {
    dimension: entry.dimension,
    value: entry.value,
    label: entry.label,
    measures: entry.measures,
    children: shown.map((child) => finish(child, measure)),
    ...(children.length > shown.length
      ? { more: children.length - shown.length }
      : {}),
  };
}

const dedupe = (list) => [
  ...new Map(list.map((entry) => [entry.project, entry])).values(),
];

/**
 * The turns the filtered calls were made in, newest first: each turn's
 * project, conversation, its time (turnKey's) and measures. The bridge names
 * each turn's request.
 * @param {{ project: string, store: object }[]} stores
 * @param {ReturnType<typeof parseUsageRequest>} request
 */
export function usageTurns(stores, request) {
  const where = whereOf(request);
  const { rows, unreadable } = across(stores, (store) =>
    run(
      store,
      `select conversation, turn_at, any_value(agent) as agent, ${SUMS}, ${TIMES} from calls ${where.sql} group by conversation, turn_at order by max(at_ms) desc limit ${MAX_TURNS + 1}`,
      where.values,
    ),
  );
  rows.sort((a, b) => Number(b.last_at) - Number(a.last_at));
  return {
    turns: rows.slice(0, MAX_TURNS).map((row) => ({
      project: row.$project,
      conversation: row.conversation,
      turnAt: row.turn_at === null ? null : Number(row.turn_at),
      agent: row.agent,
      measures: addMeasures(emptyMeasures(), row),
    })),
    more: rows.length > MAX_TURNS,
    unreadable,
  };
}

/**
 * One turn's rows, in time order, a model call before the tool calls it made:
 * what each was, its tokens or result, outcome, and the evidence for its
 * waste reason and deviation.
 * @param {object} store the turn's project's store
 * @param {{ conversation: string, turnAt: number | null }} turn
 */
export function usageTurnRows(store, { conversation, turnAt }) {
  const rows = run(
    store,
    `select kind, id, at_ms, agent, topic, phase, basis, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, context_tokens, tool, result_chars, outcome, waste_reason, waste_evidence, deviation_cause, deviation_kind, deviation_evidence from calls where conversation = ? and ${turnAt === null ? "turn_at is null" : "turn_at = ?"} order by at_ms, (kind = 'model') desc limit ${MAX_ROWS + 1}`,
    turnAt === null ? [conversation] : [conversation, turnAt],
  );
  return {
    rows: rows.slice(0, MAX_ROWS).map((row) => ({
      ...row,
      at_ms: Number(row.at_ms),
    })),
    more: rows.length > MAX_ROWS,
  };
}
