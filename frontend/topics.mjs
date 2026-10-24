// Topics: the thread > topic > turn > call hierarchy of a project's work.
//
// Topics are declared with rene's record_topic tool. A declaration is a
// recorded call, so the tree is rebuilt from the project's history and every
// change to it is in the audit trail; the latest declaration of a topic_id is
// its current state. A thread is the chat relationship at the top; topics of
// a kind (feature, question, bug, ...) sit under it.
//
// Which topic each call was for is attribution.mjs's answer: a call is filed
// under the topic in force when it was made, and a turn is listed under every
// topic it declared or made a call for, with its basis. A turn without a
// declaration is carried under the topic its conversation was last in,
// marked carried, unless a declaration names it by its recorded identity
// (its session and the time of its request, in record_topic's turns); a
// topic's named turns add up across its declarations, and the latest naming
// of a turn wins. Only turns before any declaration stay undeclared. A
// declaration's evidence (the Evidence its conclusion rests on) links the
// topic like Evidence its calls named. Workbench agents are held to a
// declaration in every turn (topicGate.mjs). Calls join through their turns
// (the timestamp link in conversations.mjs). Factual links between topics are
// identities, not judgments: two topics whose calls read or changed the same
// file, or named or returned the same Evidence, are linked, with what they
// share.

import { attributeTurns, TOPIC_TOOL, turnKey } from "./attribution.mjs";

export { TOPIC_TOOL };
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
  const declarations = (
    await history.list({ name: TOPIC_TOOL, outcome: "ok" })
  ).sort((a, b) => a.startedAt - b.startedAt);
  const topics = new Map();
  const declaredBy = new Map();
  const filed = new Map();
  for (const entry of declarations) {
    const declared = payloadOf(
      await history.result(entry.id),
    )?.normalized_result;
    if (!declared?.topic_id) continue;
    const previous = topics.get(declared.topic_id);
    topics.set(declared.topic_id, {
      ...declared,
      // Declarations from before these fields existed name none.
      evidence: [
        ...new Set([
          ...(previous?.evidence ?? []),
          ...(declared.evidence ?? []),
        ]),
      ],
      first_declared_at: previous?.first_declared_at ?? declared.declared_at,
      // The phases declared, in order, each with its first estimate, and the
      // first and latest plan: what deviation is measured against.
      phases: declared.phase
        ? addPhase(previous?.phases ?? [], declared)
        : (previous?.phases ?? []),
      plan: declared.plan?.length ? declared.plan : (previous?.plan ?? null),
      first_plan:
        previous?.first_plan ?? (declared.plan?.length ? declared.plan : null),
      // The TODO or plan task it works on (tasks.mjs), until another is named.
      task: declared.task ?? previous?.task ?? null,
      // The first estimate is the one judged; a later one is a re-estimate.
      estimate: declared.estimate ?? previous?.estimate ?? null,
      first_estimate: previous?.first_estimate ?? declared.estimate ?? null,
      first_estimate_at:
        previous?.first_estimate_at ??
        (declared.estimate ? declared.declared_at : null),
      declarations: (previous?.declarations ?? 0) + 1,
      declared_by: entry.source === "agent" ? (entry.agent ?? "Agent") : "You",
    });
    declaredBy.set(entry.id, {
      topic: declared.topic_id,
      status: declared.status,
    });
    for (const turn of declared.turns ?? [])
      filed.set(turnKey(turn.session, turn.at), declared.topic_id);
  }
  return { topics, declaredBy, filed };
}

/** A topic's phases with a declaration's phase added, or its estimate filled in. */
const addPhase = (phases, declared) => {
  const known = phases.find((phase) => phase.name === declared.phase);
  if (known)
    return known.estimate || !declared.estimate
      ? phases
      : phases.map((phase) =>
          phase === known ? { ...phase, estimate: declared.estimate } : phase,
        );
  return [
    ...phases,
    {
      name: declared.phase,
      started_at: declared.declared_at,
      estimate: declared.estimate ?? null,
    },
  ];
};

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
 * @param {{ topics: Map, declaredBy: Map, filed?: Map }} declared from currentTopics
 * @param {object[]} turns conversation turns (conversationTurns), oldest first
 * @param {object[]} history the project's call summaries
 */
export function topicTree(
  { topics, declaredBy, filed = new Map() },
  turns,
  history,
) {
  const calls = new Map(history.map((entry) => [entry.id, entry]));
  const nodes = new Map(
    [...topics.values()].map((topic) => [
      topic.topic_id,
      { ...topic, children: [], turns: [], calls: [], facts: [] },
    ]),
  );
  const loose = fileTurns(nodes, turns, declaredBy, filed);
  linkSharedTouches(nodes, calls);
  return { threads: hierarchy(nodes), loose_turns: loose };
}

/**
 * Files each call under the topic in force when it was made, and lists each
 * turn, with its calls for that topic, under every topic it declared or made
 * a call for, or else the topic it ended in (attribution.mjs), with the
 * basis it is there on: declared, named or carried. Returns the turns no
 * topic holds: those before any declaration in their conversation, or under
 * a topic the history doesn't know.
 */
function fileTurns(nodes, turns, declaredBy, filed) {
  const loose = [];
  for (const { turn, declared, inForce, ended } of attributeTurns(turns, {
    declaredBy,
    filed,
  })) {
    /** topic id -> this turn's calls for it and its basis, declared first. */
    const byTopic = new Map(
      declared.map((topicId) => [topicId, { calls: [], basis: "declared" }]),
    );
    const unfiled = [];
    for (const [position, event] of turn.events.entries()) {
      if (event.kind !== "tool_use" || !event.rea || !event.historyId) continue;
      const held = inForce[position];
      if (!nodes.has(held?.topic)) {
        unfiled.push(event.historyId);
        continue;
      }
      if (!byTopic.has(held.topic))
        byTopic.set(held.topic, { calls: [], basis: held.basis });
      byTopic.get(held.topic).calls.push(event.historyId);
    }
    // A turn that made no call for a topic is still the one it ended in.
    if (byTopic.size === 0 && unfiled.length === 0 && nodes.has(ended?.topic))
      byTopic.set(ended.topic, { calls: [], basis: ended.basis });
    const summary = (calls, basis) => ({
      session: turn.session,
      index: turn.index,
      at: turn.at,
      prompt: turn.prompt,
      calls,
      ...(basis ? { basis } : {}),
    });
    let held = false;
    for (const [topicId, { calls, basis }] of byTopic) {
      const node = nodes.get(topicId);
      if (!node) continue;
      held = true;
      node.turns.push(summary(calls, basis));
      node.calls.push(...calls);
    }
    if (!held) loose.push(summary(unfiled));
  }
  return loose;
}

/** The topics that touched each file or Evidence, by `kind\0value`. */
function touchOwners(nodes, calls) {
  const owners = new Map();
  const own = (key, topicId) => {
    const k = `${key.kind}\u0000${key.value}`;
    const set = owners.get(k) ?? new Set();
    set.add(topicId);
    owners.set(k, set);
  };
  for (const node of nodes.values()) {
    for (const id of node.evidence ?? [])
      own({ kind: "evidence", value: id }, node.topic_id);
    for (const id of node.calls) {
      const entry = calls.get(id);
      if (!entry || entry.name === TOPIC_TOOL) continue;
      for (const key of touched(entry)) own(key, node.topic_id);
    }
  }
  return owners;
}

/** Factual links: topics whose calls touched the same file or Evidence. */
function linkSharedTouches(nodes, calls) {
  for (const [k, ids] of touchOwners(nodes, calls)) {
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
}

/**
 * The hierarchy: children under parents, oldest first; topics whose parent
 * is unknown stay at the top, marked, rather than disappearing.
 */
function hierarchy(nodes) {
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
  return order(roots);
}
