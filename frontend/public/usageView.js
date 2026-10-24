// The Usage view: what the agents' calls cost, from the usage store
// (frontend/usageStore.mjs), sliced by up to three dimensions (agent,
// project, conversation › topic › phase, waste reason, deviation cause,
// time…), over time, each task's estimate against what it used, and the
// drill-down from any group to its turns and a turn's calls. The bridge
// works it out (frontend/usageView.mjs); this holds the view's choices and
// lays it out, with usageCharts.js drawing.

import { apiJson } from "./api.js";
import { h, renderError } from "./render.js";
import { tokens } from "./usage.js";
import {
  bar,
  callTable,
  figureCells,
  figures,
  formatOf,
  share,
  taskEstimates,
  time,
  timelineChart,
  totals,
  wastedOf,
} from "./usageCharts.js";

const SAVED_KEY = "rea-usage-view";
const PERIODS = [
  ["all", "All time", null],
  ["day", "Last 24 hours", 24 * 60 * 60_000],
  ["week", "Last 7 days", 7 * 24 * 60 * 60_000],
  ["month", "Last 30 days", 30 * 24 * 60 * 60_000],
];
const GROUPINGS = [
  "conversation",
  "topic",
  "phase",
  "agent",
  "project",
  "waste",
  "deviation",
  "deviationKind",
  "model",
  "tool",
  "outcome",
  "basis",
  "kind",
  "day",
  "hour",
];
const DEFAULTS = {
  scope: "project",
  period: "all",
  by: ["conversation", "topic", "phase"],
  measure: "model_calls",
};

const saved = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SAVED_KEY)) };
  } catch {
    return { ...DEFAULTS };
  }
};
const save = ({ scope, period, by, measure }) => {
  try {
    localStorage.setItem(
      SAVED_KEY,
      JSON.stringify({ scope, period, by, measure }),
    );
  } catch {
    // Not kept in this browser; the view still works.
  }
};

const clip = (text, length) =>
  text.length > length ? `${text.slice(0, length)}…` : text;

/** What the bars show now (usageCharts.js's Shown). */
const shownOf = (view) => {
  const { measure } = view.state;
  const definition = view.latest?.measures?.[measure];
  return {
    measure,
    label: definition?.label ?? measure,
    wasted: definition?.wasted ?? null,
  };
};

/**
 * Opens the usage view in `container`.
 * @param {HTMLElement} container
 * @param {{ getProject: () => { id: string } | undefined, openTurn: (turn: { project: string, session: string, index: number }) => void }} options
 */
export function showUsage(container, { getProject, openTurn }) {
  const view = {
    state: { ...saved(), filters: {}, labels: {} },
    latest: undefined,
    getProject,
    openTurn,
    head: h("div", { class: "usage-view-head" }),
    content: h("div", { class: "usage-view-body", "aria-live": "polite" }),
    drill: h("div", { class: "usage-view-drill" }),
  };
  container.replaceChildren(
    h(
      "section",
      { class: "usage-view", "aria-label": "Usage" },
      h("h2", {}, "Usage"),
      h(
        "p",
        { class: "hint" },
        "Every model call, tool call and turning message of the agents' conversations, as the usage store holds them. Shaded parts were wasted: refused, failed or repeated calls, and work you corrected or stopped.",
      ),
      view.head,
      view.content,
      view.drill,
    ),
  );
  void refresh(view);
}

/** The project the view reads: the open one, or "all". */
const which = (view) =>
  view.state.scope === "all" ? "all" : (view.getProject()?.id ?? null);

function params(view, extra = {}) {
  const { state } = view;
  const period = PERIODS.find(([id]) => id === state.period)?.[2] ?? null;
  return new URLSearchParams({
    by: state.by.join(","),
    measure: state.measure,
    filters: JSON.stringify(state.filters),
    tz: String(-new Date().getTimezoneOffset()),
    ...(period ? { from: String(Date.now() - period) } : {}),
    ...extra,
  });
}

async function refresh(view) {
  save(view.state);
  const project = which(view);
  view.drill.replaceChildren();
  if (!project)
    view.content.replaceChildren(
      h(
        "p",
        { class: "hint" },
        "Open a project to see its usage, or choose All projects.",
      ),
    );
  else {
    view.content.replaceChildren(
      h("p", { class: "hint" }, "Reading the usage store…"),
    );
    try {
      view.latest = await apiJson(
        `/api/projects/${project}/usage?${params(view)}`,
      );
      view.content.replaceChildren(...render(view, view.latest));
    } catch (cause) {
      view.content.replaceChildren(renderError(undefined, cause.message));
    }
  }
  view.head.replaceChildren(controls(view), filterChips(view) ?? "");
}

function select(label, options, value, onChange) {
  const element = h(
    "select",
    { "aria-label": label },
    ...options.map(([id, text]) =>
      h("option", { value: id, selected: id === value }, text),
    ),
  );
  element.addEventListener("change", () => onChange(element.value));
  return h("label", { class: "usage-view-control" }, label, " ", element);
}

/** Changes the view's state and reads the usage again. */
const change = (view, update) => (value) => {
  update(view.state, value);
  void refresh(view);
};

function controls(view) {
  const { state, latest } = view;
  const names = latest?.dimensions ?? {};
  // A level more than is in use, to add one.
  const levels = [0, 1, 2].slice(0, Math.min(3, state.by.length + 1));
  const measures = latest?.measures ?? {
    model_calls: { label: "Model calls" },
  };
  return h(
    "div",
    { class: "usage-view-controls" },
    select(
      "Projects",
      [
        ["project", "This project"],
        ["all", "All projects"],
      ],
      state.scope,
      change(view, (s, value) => {
        s.scope = value;
        s.filters = {};
      }),
    ),
    select(
      "Period",
      PERIODS.map(([id, text]) => [id, text]),
      state.period,
      change(view, (s, value) => {
        s.period = value;
      }),
    ),
    ...levels.map((level) =>
      select(
        level === 0 ? "Group by" : "then",
        [
          ...(level === 0 ? [] : [["", "—"]]),
          ...GROUPINGS.map((name) => [name, names[name] ?? name]),
        ],
        state.by[level] ?? "",
        change(view, (s, value) => {
          const by = [...s.by];
          if (value) by[level] = value;
          else by.length = level;
          s.by = by.filter(Boolean).slice(0, 3);
        }),
      ),
    ),
    select(
      "Bars show",
      Object.entries(measures).map(([id, { label }]) => [id, label]),
      state.measure,
      change(view, (s, value) => {
        s.measure = value;
      }),
    ),
    h(
      "button",
      { type: "button", class: "quiet", onclick: () => void refresh(view) },
      "Refresh",
    ),
  );
}

function filterChips(view) {
  const { state } = view;
  const entries = Object.entries(state.filters);
  if (!entries.length) return undefined;
  return h(
    "div",
    { class: "usage-view-filters" },
    h("span", { class: "usage-label" }, "Only"),
    ...entries.map(([name, value]) =>
      h(
        "button",
        {
          type: "button",
          class: "usage-view-chip",
          title: "Remove this filter",
          onclick: change(view, (s) => {
            delete s.filters[name];
          }),
        },
        `${view.latest?.dimensions?.[name] ?? name}: ${state.labels[name] ?? value ?? "none"} ×`,
      ),
    ),
  );
}

/** A group's path as filters: itself and the groups it is nested in. */
const pathFilters = (path) =>
  Object.fromEntries(path.map((group) => [group.dimension, group.value]));

/** Only the calls of a group: its path becomes filters, grouped by the rest. */
function narrow(view, path) {
  const { state } = view;
  state.filters = { ...state.filters, ...pathFilters(path) };
  state.labels = {
    ...state.labels,
    ...Object.fromEntries(path.map((group) => [group.dimension, group.label])),
  };
  // Grouping by what is now fixed shows one group: group by the rest.
  const rest = state.by.filter((name) => !Object.hasOwn(state.filters, name));
  state.by = rest.length ? rest : ["day"];
  void refresh(view);
}

/** The turns a group's calls were made in, newest first. */
async function showTurns(view, path) {
  const { drill } = view;
  drill.replaceChildren(h("p", { class: "hint" }, "Finding the turns…"));
  drill.scrollIntoView({ block: "nearest" });
  let found;
  try {
    found = await apiJson(
      `/api/projects/${which(view)}/usage/turns?${params(view, {
        filters: JSON.stringify({
          ...view.state.filters,
          ...pathFilters(path),
        }),
      })}`,
    );
  } catch (cause) {
    drill.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  drill.replaceChildren(
    h(
      "h3",
      {},
      `Turns: ${path.map((group) => group.label).join(" › ") || "all calls"}`,
    ),
    found.turns.length
      ? h(
          "ol",
          { class: "usage-view-turns" },
          ...found.turns.map((turn) => turnItem(view, turn)),
        )
      : h("p", { class: "hint" }, "No turns."),
    found.more
      ? h("p", { class: "hint" }, "Showing the newest 100 turns.")
      : undefined,
  );
}

/** A turn: its request and figures; opened, its calls, read when first opened. */
function turnItem(view, turn) {
  const m = turn.measures;
  const rows = h("div", { class: "usage-view-rows" });
  const details = h(
    "details",
    {},
    h(
      "summary",
      {},
      h("time", {}, time(turn.turnAt ?? m.first_at)),
      " ",
      h(
        "span",
        { class: "usage-view-prompt", title: turn.prompt ?? "" },
        turn.prompt
          ? clip(turn.prompt.replace(/\s+/g, " "), 160)
          : "Work the agent began itself",
      ),
      h(
        "span",
        { class: "usage-detail" },
        ` · ${turn.agent ?? "agent"} · ${m.model_calls} model calls · ${m.tool_calls} tool calls · ${tokens(m.output)} out${m.wasted_model_calls ? ` · ${share(m.wasted_model_calls, m.model_calls)} wasted` : ""}`,
      ),
    ),
    turn.index === null
      ? undefined
      : h(
          "button",
          {
            type: "button",
            class: "link",
            onclick: () =>
              view.openTurn({
                project: turn.projectId,
                session: turn.conversation,
                index: turn.index,
              }),
          },
          "Show the whole turn",
        ),
    rows,
  );
  details.addEventListener("toggle", () => {
    if (details.open && !rows.childElementCount)
      void showRows(view, turn, rows);
  });
  return h("li", {}, details);
}

async function showRows(view, turn, rows) {
  rows.replaceChildren(h("p", { class: "hint" }, "Reading its calls…"));
  const project = view.state.scope === "all" ? turn.projectId : which(view);
  try {
    const { rows: list, more } = await apiJson(
      `/api/projects/${project}/usage/turn?${new URLSearchParams({
        conversation: turn.conversation,
        ...(turn.turnAt === null ? {} : { turn: String(turn.turnAt) }),
      })}`,
    );
    rows.replaceChildren(
      callTable(list, view.latest?.titles ?? {}),
      more ? h("p", { class: "hint" }, "Showing the first 500.") : "",
    );
  } catch (cause) {
    rows.replaceChildren(renderError(undefined, cause.message));
  }
}

/** A group's row: name, bar, figures, and its Only and Turns actions. */
function groupRow(view, group, path, max) {
  const shown = shownOf(view);
  const value = group.measures[shown.measure];
  const wasted = wastedOf(shown, group.measures);
  const action = (text, title, act) =>
    h(
      "button",
      {
        type: "button",
        class: "link",
        title,
        onclick: (event) => {
          // Not the details' own toggle.
          event.preventDefault();
          act();
        },
      },
      text,
    );
  return h(
    "div",
    { class: "usage-view-row" },
    h(
      "span",
      {
        class: "usage-view-label",
        title:
          group.value && group.value !== group.label
            ? `${group.label}\n${group.value}`
            : group.label,
      },
      group.label,
    ),
    bar(
      value,
      wasted,
      max,
      `${shown.label} ${formatOf(shown.measure)(value)}, ${share(wasted, value)} wasted`,
    ),
    ...figureCells(group.measures),
    h(
      "span",
      { class: "usage-view-actions" },
      action("Only", "Only these calls", () => narrow(view, path)),
      action(
        "Turns",
        "The turns these calls were made in",
        () => void showTurns(view, path),
      ),
    ),
  );
}

/** Groups nested a level per dimension; a group with children opens. */
function groupList(view, groups, path = []) {
  const measure = view.state.measure;
  const max = Math.max(1, ...groups.map((group) => group.measures[measure]));
  return h(
    "ul",
    { class: "usage-view-groups" },
    ...groups.map((group) => {
      const at = [...path, group];
      const row = groupRow(view, group, at, max);
      if (!group.children.length) return h("li", {}, row);
      return h(
        "li",
        {},
        h(
          "details",
          { open: path.length === 0 && groups.length <= 5 },
          h("summary", {}, row),
          groupList(view, group.children, at),
          group.more
            ? h("p", { class: "hint" }, `and ${group.more} smaller groups`)
            : undefined,
        ),
      );
    }),
  );
}

function render(view, slice) {
  const shown = shownOf(view);
  const header = h(
    "div",
    { class: "usage-view-row usage-view-header" },
    h(
      "span",
      {},
      slice.by.map((name) => slice.dimensions[name]).join(" › ") || "All calls",
    ),
    h("span", {}, shown.label),
    ...figures(slice.total).map(([label]) =>
      h("span", { class: "usage-view-num" }, label),
    ),
    h("span", {}),
  );
  const projects = slice.projects.length;
  return [
    totals(slice.total),
    h(
      "p",
      { class: "usage-detail" },
      `${time(slice.total.first_at)} to ${time(slice.total.last_at)} · ${projects} project${projects === 1 ? "" : "s"} · read ${new Date(slice.asOf).toLocaleTimeString()}`,
    ),
    ...slice.unreadable.map((entry) =>
      h(
        "p",
        { class: "form-error" },
        `${entry.project}: its usage store couldn't be read (${entry.reason}).`,
      ),
    ),
    timelineChart(slice.timeline, shown),
    h("h3", {}, "Where it went"),
    slice.groups.length
      ? h(
          "div",
          { class: "usage-view-table" },
          header,
          groupList(view, slice.groups),
        )
      : h("p", { class: "hint" }, "No calls recorded here yet."),
    h("h3", {}, "Estimate against actual"),
    taskEstimates(slice.tasks, { withProject: view.state.scope === "all" }),
  ];
}
