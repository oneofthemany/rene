// The Usage view's charts and tables (usageView.js holds its state): bars
// with their wasted part shaded, columns over time, a turn's calls, and each
// task's estimated range with what it used marked. Each takes what it shows;
// none reads or changes the view.

import { h } from "./render.js";
import { MEASURE_LABELS, tokens } from "./usage.js";

const MAX_TASKS = 50;

export const count = (value) => (value >= 1e4 ? tokens(value) : String(value));
export const share = (part, whole) =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : "–";
export const formatOf = (measure) =>
  measure === "output" || measure === "context" ? tokens : count;
export const time = (ms) =>
  ms === null || ms === undefined ? "–" : new Date(ms).toLocaleString();

/**
 * What a chart shows: the measure, its label, and the measure that is its
 * wasted part (null when it has none).
 * @typedef {{ measure: string, label: string, wasted: string | null }} Shown
 */

export const wastedOf = (shown, measures) =>
  shown.wasted ? measures[shown.wasted] : 0;

/** A bar of `value` against `max`, its wasted part shaded. */
export function bar(value, wasted, max, label) {
  const track = h("span", {
    class: "usage-view-bar",
    role: "img",
    "aria-label": label,
    title: label,
  });
  const used = h("span", { class: "usage-seg usage-productive" });
  const waste = h("span", { class: "usage-seg usage-wasted" });
  // Through the DOM, which the page's style policy allows.
  used.style.width = `${max > 0 ? (100 * Math.max(0, value - wasted)) / max : 0}%`;
  waste.style.width = `${max > 0 ? (100 * wasted) / max : 0}%`;
  track.append(used, waste);
  return track;
}

/** The figures every group, turn and total shows. */
export const figures = (m) => [
  ["Model calls", count(m.model_calls)],
  ["Tool calls", count(m.tool_calls)],
  ["Output", tokens(m.output)],
  ["Context read", tokens(m.context)],
  ["Wasted calls", share(m.wasted_model_calls, m.model_calls)],
  ["Deviations", count(m.deviations)],
  ["Turns", count(m.turns)],
];

export const figureCells = (m) =>
  figures(m).map(([label, value]) =>
    h("span", { class: "usage-view-num", title: label }, value),
  );

/** The total's figures, large. */
export const totals = (m) =>
  h(
    "div",
    { class: "usage-stats" },
    ...figures(m).map(([label, value]) =>
      h(
        "div",
        { class: "usage-stat" },
        h("span", { class: "usage-label" }, label),
        h("span", { class: "usage-value" }, value),
      ),
    ),
  );

/**
 * Columns over time: the measure, its wasted part shaded.
 * @param {{ bucket: string, points: object[] }} timeline
 * @param {Shown} shown
 */
export function timelineChart({ bucket, points }, shown) {
  if (!points.length) return undefined;
  const { measure, label } = shown;
  const max = Math.max(1, ...points.map((point) => point[measure]));
  const format = formatOf(measure);
  const column = (point) => {
    const value = point[measure];
    const wasted = wastedOf(shown, point);
    const element = h("span", {
      class: "usage-view-column",
      title: `${point.key}: ${format(value)}${wasted ? `, ${share(wasted, value)} wasted` : ""}`,
    });
    const used = h("span", { class: "usage-seg usage-productive" });
    const waste = h("span", { class: "usage-seg usage-wasted" });
    used.style.height = `${(100 * Math.max(0, value - wasted)) / max}%`;
    waste.style.height = `${(100 * wasted) / max}%`;
    element.append(used, waste);
    return element;
  };
  return h(
    "figure",
    { class: "usage-view-timeline" },
    h(
      "div",
      {
        class: "usage-view-columns",
        role: "img",
        "aria-label": `${label} by ${bucket}: ${points.map((point) => `${point.key} ${format(point[measure])}`).join(", ")}`,
      },
      ...points.map(column),
    ),
    h(
      "figcaption",
      { class: "usage-detail" },
      `${label} by ${bucket}, ${points[0].key} to ${points.at(-1).key}; most ${format(max)}. Shaded: wasted.`,
    ),
  );
}

const CALL_COLUMNS = [
  "Time",
  "Call",
  "Tokens or result",
  "Outcome",
  "Topic › phase",
  "Waste",
  "Deviation",
];

const callName = (row) =>
  row.kind === "model"
    ? (row.model ?? "model")
    : row.kind === "tool"
      ? h("code", {}, row.tool)
      : row.kind === "interrupt"
        ? "You stopped it"
        : "Your message";

const callSize = (row) =>
  row.kind === "model"
    ? `${tokens(row.output_tokens ?? 0)} out · ${tokens(row.context_tokens ?? 0)} context`
    : row.result_chars === null
      ? ""
      : `${tokens(row.result_chars)} chars`;

const callTopic = (titles, row) =>
  row.topic
    ? `${titles[row.topic] ?? row.topic.slice(0, 8)}${row.phase ? ` › ${row.phase}` : ""}${row.basis && row.basis !== "declared" ? ` (${row.basis})` : ""}`
    : "In no task";

/**
 * A turn's rows: each call, what it cost, and why it was waste or a deviation.
 * @param {object[]} list the turn's rows (usageView.mjs's usageTurnRows)
 * @param {Record<string, string>} titles topic id -> title
 */
export const callTable = (list, titles) =>
  h(
    "table",
    { class: "usage-view-calls" },
    h(
      "thead",
      {},
      h("tr", {}, ...CALL_COLUMNS.map((label) => h("th", {}, label))),
    ),
    h(
      "tbody",
      {},
      ...list.map((row) =>
        h(
          "tr",
          { class: row.waste_reason ? "usage-view-wasted" : "" },
          h("td", {}, new Date(row.at_ms).toLocaleTimeString()),
          h("td", {}, callName(row)),
          h("td", {}, callSize(row)),
          h("td", {}, row.outcome ?? ""),
          h("td", {}, callTopic(titles, row)),
          h("td", { title: row.waste_evidence ?? "" }, row.waste_reason ?? ""),
          h(
            "td",
            { title: row.deviation_evidence ?? "" },
            row.deviation_cause
              ? `${row.deviation_cause}/${row.deviation_kind}`
              : "",
          ),
        ),
      ),
    ),
  );

/**
 * Each task's estimate against what it used.
 * @param {object[]} list usage.mjs's taskProgress, with an accuracy
 * @param {{ withProject: boolean }} options name each task's project
 */
export function taskEstimates(list, { withProject }) {
  if (!list.length)
    return h(
      "p",
      { class: "hint" },
      "No task with an estimate here: tasks declared with estimate on record_topic show here.",
    );
  return h(
    "ul",
    { class: "usage-view-tasks" },
    ...list
      .slice(0, MAX_TASKS)
      .map((task) =>
        h(
          "li",
          {},
          h(
            "div",
            {},
            h("strong", {}, task.title),
            h(
              "span",
              { class: "usage-detail" },
              ` · ${task.status} · ${task.accuracy.confidence} confidence${withProject ? ` · ${task.project}` : ""}`,
            ),
          ),
          ...task.accuracy.measures.map((measure) =>
            estimateBar(measure, task.accuracy.closed),
          ),
        ),
      ),
    list.length > MAX_TASKS
      ? h("li", { class: "hint" }, `and ${list.length - MAX_TASKS} older tasks`)
      : undefined,
  );
}

const verdictOf = (measure, closed) =>
  closed
    ? measure.within
      ? "within"
      : measure.over
        ? "over"
        : "under"
    : measure.over
      ? "over so far"
      : "so far";

/** One measure's estimated range, with what was used marked on it. */
function estimateBar(measure, closed) {
  const [label, format] = MEASURE_LABELS[measure.measure] ?? [
    measure.measure,
    String,
  ];
  const scale = Math.max(measure.high, measure.actual, 1) * 1.1;
  const track = h("span", {
    class: "usage-view-range",
    role: "img",
    "aria-label": `${label}: ${format(measure.actual)} against ${format(measure.low)}–${format(measure.high)}`,
  });
  const band = h("span", { class: "usage-view-band" });
  band.style.left = `${(100 * measure.low) / scale}%`;
  band.style.width = `${(100 * (measure.high - measure.low)) / scale}%`;
  const mark = h("span", {
    class: `usage-view-mark${measure.over ? " usage-over" : ""}`,
  });
  mark.style.left = `${(100 * measure.actual) / scale}%`;
  track.append(band, mark);
  return h(
    "div",
    { class: "usage-view-estimate" },
    h("span", { class: "usage-view-label" }, label),
    track,
    h(
      "span",
      { class: `usage-detail${measure.over ? " usage-over" : ""}` },
      `${format(measure.actual)} of ${format(measure.low)}–${format(measure.high)}, ${verdictOf(measure, closed)}`,
    ),
  );
}
