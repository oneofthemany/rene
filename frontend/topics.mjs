// Topics: the thread > topic > turn > call hierarchy of a project's work.
//
// Topics are declared with rene's record_topic tool. A declaration is a
// recorded call, so the tree is rebuilt from the project's history and every
// change to it is in the audit trail; the latest declaration of a topic_id is
// its current state. A thread is the chat relationship at the top; topics of
// a kind (feature, question, bug, ...) sit under it.
//
// A turn belongs to the topic declared in it (the last, when it declared
// more than one) and to no other: nothing is carried over from an earlier
// turn, so a turn without a declaration is listed as undeclared rather than
// filed under a topic it may not be about. Workbench agents are held to a
// declaration in every turn (topicGate.mjs). Calls join through their turns
// (the timestamp link in conversations.mjs). Factual links between topics are
// identities, not judgments: two topics whose calls read or changed the same
// file, or named or returned the same Evidence, are linked, with what they
// share.

export const TOPIC_TOOL = "record_topic";
const MAX_SHARED = 5;
// Arguments naming one file a call read or changed.
const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

/** The structured payload of a stored MCP result. */
const payloadOf = (result) => {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = (result?.content ?? []).filter(
    (block) => block.type === "text",
  );
  if (texts.length !== 1) return undefined;
  try {
    return JSON.parse(texts[0].text);
  } catch {
    return undefined;
  }
};

/**
 * Current topics from the project's recorded declarations, by topic_id.
 * Reads each declaration's stored result for the id a new topic was given.
 */
export async function currentTopics(history) {
  const declarations = (await history.list())
    .filter((entry) => entry.name === TOPIC_TOOL && entry.outcome === "ok")
    .sort((a, b) => a.startedAt - b.startedAt);
  const topics = new Map();
  const declaredBy = new Map();
  for (const entry of declarations) {
    const declared = payloadOf(
      await history.result(entry.id),
    )?.normalized_result;
    if (!declared?.topic_id) continue;
    const previous = topics.get(declared.topic_id);
    topics.set(declared.topic_id, {
      ...declared,
      first_declared_at: previous?.first_declared_at ?? declared.declared_at,
      declarations: (previous?.declarations ?? 0) + 1,
      declared_by: entry.source === "agent" ? (entry.agent ?? "Agent") : "You",
    });
    declaredBy.set(entry.id, declared.topic_id);
  }
  return { topics, declaredBy };
}

/** What a call touched that another topic's call could share: files and Evidence. */
const touched = (entry) => {
  const keys = [];
  if (FILE_TOOLS.has(entry.name) && typeof entry.args?.path === "string")
    keys.push({ kind: "file", value: entry.args.path });
  for (const id of entry.evidence ?? [])
    keys.push({ kind: "evidence", value: id });
  for (const link of entry.links ?? [])
    if (link.evidence) keys.push({ kind: "evidence", value: link.evidence });
  return keys;
};

/**
 * The topic tree.
 * @param {{ topics: Map, declaredBy: Map }} declared from currentTopics
 * @param {object[]} turns conversation turns (conversationTurns), oldest first
 * @param {object[]} history the project's call summaries
 */
export function topicTree({ topics, declaredBy }, turns, history) {
  const calls = new Map(history.map((entry) => [entry.id, entry]));
  const nodes = new Map(
    [...topics.values()].map((topic) => [
      topic.topic_id,
      { ...topic, children: [], turns: [], calls: [], facts: [] },
    ]),
  );
  // Each turn joins the topic it declared.
  const loose = [];
  const byTime = [...turns].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const turn of byTime) {
    let topicId;
    for (const event of turn.events)
      if (
        event.kind === "tool_use" &&
        event.tool === TOPIC_TOOL &&
        event.historyId
      )
        topicId = declaredBy.get(event.historyId) ?? topicId;
    const node = nodes.get(topicId);
    const summary = {
      session: turn.session,
      index: turn.index,
      at: turn.at,
      prompt: turn.prompt,
      calls: turn.events
        .filter(
          (event) => event.kind === "tool_use" && event.rea && event.historyId,
        )
        .map((event) => event.historyId),
    };
    if (!node) {
      loose.push(summary);
      continue;
    }
    node.turns.push(summary);
    node.calls.push(...summary.calls);
  }
  // Factual links: topics whose calls touched the same file or Evidence.
  const owners = new Map();
  for (const node of nodes.values())
    for (const id of node.calls) {
      const entry = calls.get(id);
      if (!entry || entry.name === TOPIC_TOOL) continue;
      for (const key of touched(entry)) {
        const k = `${key.kind}\u0000${key.value}`;
        const set = owners.get(k) ?? new Set();
        set.add(node.topic_id);
        owners.set(k, set);
      }
    }
  for (const [k, ids] of owners) {
    if (ids.size < 2) continue;
    const [kind, value] = k.split("\u0000");
    for (const id of ids)
      for (const other of ids) {
        if (other === id) continue;
        const node = nodes.get(id);
        let fact = node.facts.find((candidate) => candidate.topic_id === other);
        if (!fact) {
          fact = { topic_id: other, shared: [], more: 0 };
          node.facts.push(fact);
        }
        if (fact.shared.length < MAX_SHARED) fact.shared.push({ kind, value });
        else fact.more += 1;
      }
  }
  // The hierarchy: children under parents; topics whose parent is unknown
  // stay at the top, marked, rather than disappearing.
  const roots = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    if (parent) parent.children.push(node);
    else roots.push({ ...node, orphan: node.kind !== "thread" });
  }
  const order = (list) =>
    list
      .sort(
        (a, b) =>
          Date.parse(a.first_declared_at) - Date.parse(b.first_declared_at),
      )
      .map((node) => ({ ...node, children: order(node.children) }));
  return { threads: order(roots), loose_turns: loose };
}
