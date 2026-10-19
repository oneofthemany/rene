// The History tab's Topics view: threads, the topics under them, and the
// turns and calls filed under each. The tree comes from the bridge
// (frontend/topics.mjs); editing a topic is a record_topic call, so every
// change is a recorded call like any other.

import { h } from "./render.js";

const KINDS = [
  "feature",
  "question",
  "bug",
  "investigation",
  "refactor",
  "docs",
  "decision",
  "other",
];
const STATUSES = ["open", "done", "abandoned"];
// Topics and turns opened, kept across redraws.
const opened = new Set();
const callsOpened = new Set();
const turnKey = (turn) => `${turn.session}:${turn.index}`;

const when = (at) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const firstLine = (text, limit = 120) => {
  const line =
    String(text ?? "")
      .trim()
      .split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

/**
 * A form declaring or updating one topic. `topic` is the current state when
 * editing; `parent` the thread a new topic goes under (none for a thread).
 */
function topicForm({ topic, parent, kind }, onDeclare, onDone) {
  const title = h("input", {
    value: topic?.title ?? "",
    required: true,
    maxlength: "200",
  });
  const kindSelect = h(
    "select",
    {},
    ...(kind === "thread" ? ["thread"] : KINDS).map((option) =>
      h(
        "option",
        { value: option, selected: (topic?.kind ?? kind) === option },
        option,
      ),
    ),
  );
  const status = h(
    "select",
    {},
    ...STATUSES.map((option) =>
      h(
        "option",
        { value: option, selected: (topic?.status ?? "open") === option },
        option,
      ),
    ),
  );
  const summary = h(
    "textarea",
    { rows: "3", maxlength: "2000" },
    topic?.summary ?? "",
  );
  const error = h("p", { class: "form-error" });
  const form = h(
    "form",
    { class: "topic-form" },
    h("label", {}, "Title", title),
    h(
      "div",
      { class: "topic-form-row" },
      h("label", {}, "Kind", kindSelect),
      h("label", {}, "Status", status),
    ),
    h("label", {}, "Summary", summary),
    error,
    h(
      "div",
      { class: "topic-form-row" },
      h("button", { type: "submit" }, topic ? "Save" : "Declare"),
      h(
        "button",
        { type: "button", class: "quiet", onclick: onDone },
        "Cancel",
      ),
    ),
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!title.value.trim()) return;
    error.textContent = "";
    const args = {
      ...(topic ? { topic_id: topic.topic_id } : {}),
      title: title.value.trim(),
      kind: kindSelect.value,
      parent_id:
        kindSelect.value === "thread" ? null : (topic?.parent_id ?? parent),
      status: status.value,
      relations: topic?.relations ?? [],
      summary: summary.value.trim(),
    };
    try {
      await onDeclare(args);
      onDone();
    } catch (cause) {
      error.textContent = cause.message;
    }
  });
  return form;
}

/** One topic and everything under it. */
function topicNode(node, names, handlers, open) {
  const body = h("div", { class: "topic-body" });
  const editing = h("div");
  const closeForm = () => editing.replaceChildren();
  const showForm = (spec) =>
    editing.replaceChildren(topicForm(spec, handlers.onDeclare, closeForm));

  if (node.summary)
    body.append(h("p", { class: "topic-summary" }, node.summary));
  for (const relation of node.relations ?? [])
    body.append(
      h(
        "p",
        { class: "topic-fact" },
        `${relation.relation.replace("_", " ")} `,
        names.get(relation.topic_id) ?? relation.topic_id,
      ),
    );
  for (const fact of node.facts ?? [])
    body.append(
      h(
        "p",
        {
          class: "topic-fact",
          title: fact.shared.map((item) => item.value).join("\n"),
        },
        `shares ${fact.shared.length + fact.more} ${fact.shared.length + fact.more === 1 ? "file or Evidence" : "files or Evidence"} with `,
        names.get(fact.topic_id) ?? fact.topic_id,
      ),
    );
  if (node.turns.length)
    body.append(
      h(
        "ol",
        { class: "topic-turns" },
        ...node.turns.map((turn) =>
          h(
            "li",
            {},
            h(
              "button",
              {
                type: "button",
                class: "link",
                onclick: () =>
                  handlers.onOpen(`turn:${turn.session}:${turn.index}`),
              },
              h("span", { class: "topic-when" }, when(turn.at)),
              firstLine(turn.prompt) || "(no prompt)",
            ),
            turn.calls.length ? turnCalls(turn, handlers) : "",
          ),
        ),
      ),
    );
  body.append(
    h(
      "div",
      { class: "topic-actions" },
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: () => showForm({ topic: node, kind: node.kind }),
        },
        "Edit",
      ),
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          onclick: () => showForm({ parent: node.topic_id, kind: "feature" }),
        },
        "Add topic",
      ),
    ),
    editing,
  );
  for (const child of node.children)
    body.append(topicNode(child, names, handlers, open));

  const details = h(
    "details",
    {
      class: `topic topic-${node.kind} topic-${node.status}`,
      "data-topic": node.topic_id,
    },
    h(
      "summary",
      {},
      h("span", { class: `topic-kind` }, node.kind),
      h("span", { class: "topic-title" }, node.title),
      node.orphan ? h("span", { class: "topic-flag" }, "parent not found") : "",
      h("span", { class: "topic-status" }, node.status),
      h(
        "span",
        { class: "topic-count" },
        `${node.turns.length} turn${node.turns.length === 1 ? "" : "s"}`,
      ),
    ),
    body,
  );
  details.open = open.has(node.topic_id);
  details.addEventListener("toggle", () =>
    details.open ? open.add(node.topic_id) : open.delete(node.topic_id),
  );
  return details;
}

/** A turn's calls, folded behind a count until opened. */
function turnCalls(turn, handlers) {
  const key = turnKey(turn);
  const list = h(
    "span",
    { class: "topic-calls" },
    ...turn.calls.map((id) =>
      h(
        "button",
        { type: "button", class: "chip", onclick: () => handlers.onOpen(id) },
        handlers.callName(id) ?? "call",
      ),
    ),
  );
  const toggle = h("button", { type: "button", class: "h-fold" });
  const show = (open) => {
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = `${open ? "▾" : "▸"} ${turn.calls.length} call${turn.calls.length === 1 ? "" : "s"}`;
  };
  toggle.addEventListener("click", () => {
    const open = !callsOpened.has(key);
    if (open) callsOpened.add(key);
    else callsOpened.delete(key);
    show(open);
  });
  show(callsOpened.has(key));
  return h("span", { class: "topic-turn-calls" }, toggle, list);
}

/** Opens or folds every topic and every turn's calls at once. */
export function setTopicsExpanded(open, tree) {
  opened.clear();
  callsOpened.clear();
  if (!open || !tree) return;
  const walk = (node) => {
    opened.add(node.topic_id);
    for (const turn of node.turns)
      if (turn.calls.length) callsOpened.add(turnKey(turn));
    node.children.forEach(walk);
  };
  tree.threads.forEach(walk);
}

/**
 * Draws the topic tree into `container`.
 * @param {{ threads: object[], loose_turns: object[] } | undefined} tree
 * @param {{ onOpen(historyId), onDeclare(args): Promise, callName(historyId) }} handlers
 */
export function renderTopics(container, tree, handlers) {
  const names = new Map();
  const index = (node) => {
    names.set(node.topic_id, node.title);
    node.children.forEach(index);
  };
  tree?.threads.forEach(index);
  const adding = h("div");
  const newThread = h(
    "button",
    {
      type: "button",
      class: "quiet",
      onclick: () =>
        adding.replaceChildren(
          topicForm({ kind: "thread" }, handlers.onDeclare, () =>
            adding.replaceChildren(),
          ),
        ),
    },
    "New thread",
  );
  const scroll = container.scrollTop;
  container.replaceChildren(
    h("div", { class: "topic-actions" }, newThread),
    adding,
    ...(tree === undefined
      ? [h("p", { class: "hint" }, "Loading topics…")]
      : tree.failure
        ? [
            h(
              "p",
              { class: "form-error" },
              `Topics couldn't be loaded: ${tree.failure}`,
            ),
          ]
        : tree.threads.length === 0
          ? [
              h(
                "p",
                { class: "hint" },
                "No topics yet. Agents declare them with record_topic as requests begin; you can start a thread here.",
              ),
            ]
          : tree.threads.map((thread) =>
              topicNode(thread, names, handlers, opened),
            )),
    tree?.loose_turns.length
      ? h(
          "p",
          { class: "hint" },
          `${tree.loose_turns.length} conversation turns aren't in any topic.`,
        )
      : "",
  );
  container.scrollTop = scroll;
}
