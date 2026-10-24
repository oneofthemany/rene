// Attribution: which topic and phase each event of a conversation was for.
// The one owner of that answer: the topic tree (topics.mjs, and History and
// the assessment through it) and the usage bar (usage.mjs) both ask here.
//
// Every event is allocated, and says on what basis, so no call silently drops
// out of a topic's figures and none is passed off as declared when it wasn't:
// - declared: the turn declared the topic (record_topic) at or before it;
// - named: a later declaration named the turn (record_topic's turns), and
//   then all of it is that topic's;
// - carried: the turn declared nothing (or not yet), so the event takes what
//   the conversation's previous turn ended with, unless that turn closed the
//   topic (done or abandoned);
// - null (unattributed): nothing was declared before it in the conversation.
//   Consumers count these apart, never under a guessed topic.
// Within a turn, an event counts toward the topic and phase in force when it
// happened. A declaration takes effect at its own call, so the model call
// that wrote it still counts toward what was in force before; declaring
// another topic ends the previous topic's phase. Calls a declaring turn makes
// before its first declaration, with nothing carried in, count toward that
// first declaration.

export const TOPIC_TOOL = "record_topic";

/** A turn's recorded identity: its session and the time of its request. */
export const turnKey = (session, at) => `${session}\u0000${Date.parse(at)}`;

/**
 * A conversation's turns: each request and what followed it, a subagent's
 * events left out (they declare nothing for the conversation). A message you
 * send while the agent works (an interjection: Copilot's steering, Claude
 * Code's queued message) is a request of its own, as the topic gate treats
 * it, so the work after it isn't bundled into the request before.
 * @param {{ session: string, agent?: string }} meta
 * @param {object[]} events the conversation's events, in order
 * @param {(event: object) => object} [keep] what a turn keeps of each event
 */
export function splitTurns(meta, events, keep = (event) => event) {
  const turns = [];
  let turn;
  for (const event of events) {
    if (event.sidechain) continue;
    const request = event.kind === "prompt" || event.kind === "interjection";
    if (request || !turn) {
      turn = {
        session: meta.session,
        agent: meta.agent,
        index: turns.length,
        at: event.at,
        prompt: request ? event.text : null,
        ...(event.kind === "interjection" ? { interjected: true } : {}),
        events: [],
      };
      turns.push(turn);
      if (request) continue;
    }
    turn.events.push(keep(event));
  }
  return turns;
}

/**
 * Turns' attribution, oldest first, each session carrying its previous
 * turn's end into its next.
 * @param {object[]} turns splitTurns' turns, of one or more conversations
 * @param {{ declaredBy?: Map<string, { topic: string, status: string }>, filed?: Map<string, string> }} [options]
 *   filed: turnKey -> the topic a declaration named that turn for
 * @returns {{ turn: object, declared: string[], inForce: object[], ended: object | null }[]}
 *   ended: what was in force as the turn ended (null: unattributed)
 */
export function attributeTurns(turns, { declaredBy, filed } = {}) {
  /** session -> what its previous turn ended with. */
  const carried = new Map();
  return [...turns]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((turn) => {
      const {
        declared,
        inForce,
        carried: next,
      } = attributeTurn(carried.get(turn.session) ?? null, turn.events, {
        declaredBy,
        named: filed?.get(turnKey(turn.session, turn.at)),
      });
      carried.set(turn.session, next);
      return { turn, declared, inForce, ended: next };
    });
}

/**
 * What was in force at each of a conversation's events, by position: a
 * subagent's event and a prompt take what was in force just before them.
 * @param {{ session: string }} meta
 * @param {object[]} events
 * @param {{ declaredBy?: Map<string, { topic: string, status: string }>, filed?: Map<string, string> }} [options]
 * @returns {({ topic: string, phase: string | null } | null)[]}
 */
export function attributeConversation(meta, events, options) {
  const held = new Map();
  for (const { turn, inForce } of attributeTurns(
    splitTurns(meta, events),
    options,
  ))
    for (const [position, event] of turn.events.entries())
      held.set(event, inForce[position]);
  let current = null;
  return events.map((event) => {
    if (held.has(event)) current = held.get(event);
    return current;
  });
}

/**
 * The topic, phase and whether it closed the topic, that a record_topic call
 * declared: the topic and status from its recorded result when the call is
 * in the history (declaredBy), else from its arguments, or when they came on
 * stdin and the transcript doesn't show them, from what it printed
 * (`declared topic <id>`, the result's phase and status).
 * @param {object} use the tool_use event
 * @param {object | undefined} result its tool_result event
 * @param {Map<string, { topic: string, status: string }>} [declaredBy]
 */
function declarationOf(use, result, declaredBy) {
  const text = result?.isError ? "" : (result?.text ?? "");
  const recorded = use.historyId ? declaredBy?.get(use.historyId) : undefined;
  const topic =
    recorded?.topic ??
    (typeof use.args?.topic_id === "string" ? use.args.topic_id : undefined) ??
    /declared topic ([0-9a-f-]{36})/u.exec(text)?.[1];
  const phase =
    (typeof use.args?.phase === "string" ? use.args.phase : undefined) ??
    /"phase":"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1];
  const status =
    recorded?.status ??
    (typeof use.args?.status === "string" ? use.args.status : undefined) ??
    /"status":"(open|done|abandoned)"/u.exec(text)?.[1];
  return {
    topic,
    phase: phase ?? null,
    closed: status === "done" || status === "abandoned",
  };
}

/**
 * One turn's attribution.
 * @param {{ topic: string, phase: string | null } | null} carried what the
 *   conversation's previous turn ended with (attributeTurn's carried)
 * @param {object[]} events the turn's events, in order
 * @param {{ declaredBy?: Map<string, { topic: string, status: string }>, named?: string }} [options]
 *   named: the topic a declaration named this turn for
 * @returns {{ declared: string[], inForce: ({ topic: string, phase: string | null, basis: "declared" | "named" | "carried" } | null)[], carried: { topic: string, phase: string | null } | null }}
 *   declared: the topics the turn declared, in order; inForce: per event;
 *   carried: what the next turn carries in
 */
function attributeTurn(carried, events, { declaredBy, named } = {}) {
  const results = new Map();
  for (const event of events)
    if (event.kind === "tool_result" && event.toolUseId)
      results.set(event.toolUseId, event);
  const declarations = new Map();
  for (const [position, event] of events.entries())
    if (event.kind === "tool_use" && event.tool === TOPIC_TOOL) {
      const declared = declarationOf(
        event,
        results.get(event.toolUseId),
        declaredBy,
      );
      if (declared.topic) declarations.set(position, declared);
    }
  const inherited = carried ? { ...carried, basis: "carried" } : null;
  if (declarations.size === 0) {
    const held = named
      ? { topic: named, phase: null, basis: "named" }
      : inherited;
    return { declared: [], inForce: events.map(() => held), carried: held };
  }
  const first = declarations.values().next().value;
  let current = inherited ?? {
    topic: first.topic,
    phase: first.phase,
    basis: "declared",
  };
  let closed = false;
  const inForce = events.map((_event, position) => {
    const declared = declarations.get(position);
    if (declared) {
      current = {
        topic: declared.topic,
        phase:
          declared.phase ??
          (declared.topic === current.topic ? current.phase : null),
        basis: "declared",
      };
      closed = declared.closed;
    }
    return current;
  });
  return {
    declared: [
      ...new Set([...declarations.values()].map(({ topic }) => topic)),
    ],
    inForce,
    // A turn that closed its topic (done, abandoned) carries nothing on: the
    // next turn's work isn't that finished task's.
    carried: closed ? null : current,
  };
}
