// Usage of one Agent Terminal session: the tokens its agent used, where its
// time went (working, waiting on you, wasted) and how far its tasks have got.
//
// Everything here is read from the conversation events rene parses from the
// agent's own transcript (conversations.mjs stores them) and from the topics
// the agent declared. Tokens are the agent's own counts; time is measured
// between transcript timestamps. Waste and the signals of wrong assumptions
// are classifications of those events: each names the event it rests on, so
// they can be checked, and none is proof on its own.

import { attributeConversation, TOPIC_TOOL } from "./attribution.mjs";

const MINUTE = 60_000;
// A Copilot turn records no end; one whose last event is this recent is
// taken to be still running.
const COPILOT_QUIET_MS = 90_000;
// Tool results join the context the agent reads; ~4 characters a token.
const CHARS_PER_TOKEN = 4;
const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 160;
const ASKING = new Set(["AskUserQuestion", "ask_user"]);
// Claude Code's word that a command went on running in the background; it
// wakes the agent with a notification when it ends.
const BACKGROUND = /moved to the background/iu;
// Tools that change a file, after which reading it again is not a repeat.
const WRITING =
  /^(Edit|Write|MultiEdit|NotebookEdit|edit|create|write_file|edit_file)$/u;

// Your message stops or redirects what the agent was doing.
const CORRECTION_START =
  /^\s*(no\b|nope\b|not (that|what|quite|like)\b|wrong\b|stop\b|don'?t\b|do not\b|that'?s not\b|that is not\b|i (said|meant|asked|didn'?t|did not|wanted)\b|actually\b|why (did|are|would) you\b|undo\b|revert\b|you (shouldn'?t|should not|weren'?t|were not)\b|instead\b|wait\b)/iu;
const CORRECTION_ANYWHERE =
  /(not what i (asked|wanted|meant)|i didn'?t ask|i did not ask|outside (of )?what i|without asking|you assumed|are you sure|i thought we (were|had|agreed)|wrong assumption|that'?s wrong|please don'?t|i never asked|go back to)/iu;
// Your message says something the agent took to be true isn't.
const CLAIM_CORRECTION =
  /(that'?s not (true|right|correct)|isn'?t (true|right|correct)|doesn'?t exist|does not exist|you made (that|it) up|hallucinat|that'?s incorrect|no such (file|function|tool|thing)|there is no )/iu;

/** Tool feedback that contradicts what the agent assumed, by what it assumed. */
const ASSUMPTIONS = [
  {
    kind: "interface",
    label: "Guessed a tool's arguments",
    // rene's own refusal of the arguments, even when a pipe hid the exit code.
    inOutput: /input validation error: invalid arguments for tool/iu,
    pattern:
      /(input validation error|inputvalidationerror|unrecognized key|invalid arguments for tool|unknown (option|flag|argument)|unrecognized (option|argument))/iu,
  },
  {
    kind: "missing-file",
    label: "Named a file that isn't there",
    inOutput: /(: no such file or directory|cannot access '[^']*')/iu,
    pattern:
      /(enoent|: no such file or directory|file does not exist|path does not exist)/iu,
  },
  {
    kind: "missing-program",
    label: "Ran a program that isn't installed",
    inOutput: /: command not found$/imu,
    pattern: /(command not found|: not found$|is not recognized as an? )/imu,
  },
  {
    kind: "edit-mismatch",
    label: "Edited text that wasn't in the file",
    pattern:
      /(string to replace not found|old_text\b.*\b(not found|occur)|did not match|0 occurrences|no match(es)? for)/iu,
  },
  {
    kind: "unknown-tool",
    label: "Called a tool that doesn't exist",
    pattern:
      /(no such tool|unknown tool|tool [\w-]+ (not found|does not exist))/iu,
  },
];
// A refusal by the workbench's gate: the agent didn't follow the session's
// instructions (rene's tools, a topic first).
const GATE =
  /(hook error|this shell runs only rene commands|has no successful topic declaration)/iu;

/** Wasted-time reasons, strongest first: overlapping time counts once, under the first. */
export const WASTE_REASONS = [
  { reason: "corrected", label: "Work you corrected" },
  { reason: "stopped", label: "Work you stopped" },
  { reason: "refused", label: "Calls the gate refused" },
  { reason: "failed", label: "Failed calls and recovery" },
  { reason: "repeated", label: "Repeated calls" },
  { reason: "compaction", label: "Compacting context" },
];
const RANK = new Map(
  WASTE_REASONS.map((entry, index) => [entry.reason, index]),
);

const timeOf = (event) => {
  const at = Date.parse(event.at ?? "");
  return Number.isFinite(at) ? at : undefined;
};
const example = (text) => {
  const line =
    String(text ?? "")
      .split("\n")
      .find((entry) => entry.trim()) ?? "";
  return line.length > EXAMPLE_CHARS
    ? `${line.slice(0, EXAMPLE_CHARS)}…`
    : line.trim();
};
/** The first line of `text` that `pattern` matches, shortened. */
const matchingLine = (text, pattern) => {
  const line = String(text ?? "")
    .split("\n")
    .find((entry) => pattern.test(entry));
  return line === undefined ? undefined : example(line);
};
// What you say up front: a long request quoting other text isn't a correction.
const OPENING_CHARS = 300;
const isCorrection = (text) =>
  CORRECTION_START.test(text) ||
  CORRECTION_ANYWHERE.test(text.slice(0, OPENING_CHARS));
// Your message adds to what the task covers, rather than correcting it.
const ADDITION =
  /^\s*(also\b|and also\b|plus\b|additionally\b|one more\b|another thing\b|as part of\b|(can|could) (we|you) also\b|(we|i) (also|would also|'d also) (need|want|like)\b|i (also )?(think|would like) we (also )?(need|should)\b|we (also )?need\b)/iu;
const isAddition = (text) => ADDITION.test(text);

/** The key a topic's use is counted under, and its phase's when it has one. */
const keysOf = (topic, phase) =>
  phase ? [topic, `${topic}\u0000${phase}`] : [topic];

const correctsClaim = (text) =>
  CLAIM_CORRECTION.test(text.slice(0, OPENING_CHARS));
const emptyTokens = () => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  aiCreditsNano: 0,
});
const addTokens = (into, usage) => {
  into.input += usage.input;
  into.cacheRead += usage.cacheRead;
  into.cacheWrite += usage.cacheWrite;
  into.output += usage.output;
  into.aiCreditsNano += usage.aiCreditsNano ?? 0;
};
// Credits are billed in billionths, and shown as the agent shows them.
const CREDITS_PER_NANO = 1e-9;

/** Interval lengths per reason, each moment counted once under its strongest reason. */
function exclusiveTime(intervals) {
  const sorted = [...intervals].sort(
    (a, b) => RANK.get(a.reason) - RANK.get(b.reason) || a.start - b.start,
  );
  const covered = [];
  const totals = new Map();
  for (const { reason, start, end } of sorted) {
    let pieces = [[start, end]];
    for (const [from, to] of covered)
      pieces = pieces.flatMap(([a, b]) =>
        to <= a || from >= b
          ? [[a, b]]
          : [...(a < from ? [[a, from]] : []), ...(to < b ? [[to, b]] : [])],
      );
    for (const [a, b] of pieces) {
      if (b <= a) continue;
      covered.push([a, b]);
      totals.set(reason, (totals.get(reason) ?? 0) + (b - a));
    }
  }
  return totals;
}

/**
 * One conversation's events inside the window, as turns: each prompt and the
 * agent's work after it, up to its last event (or now, while it runs). Each
 * event keeps what was in force at it (held, attributeConversation's).
 */
function turnsOf(meta, events, since, now, held) {
  const turns = [];
  let turn;
  // A turn still under way when the window starts: its prompt, or null for
  // work a background task woke after the turn before it ended.
  let earlier;
  for (const [index, event] of events.entries()) {
    const at = timeOf(event);
    if (at === undefined) continue;
    if (at < since) {
      if (event.kind === "prompt") earlier = { prompt: event };
      else if (event.kind === "turn_end") earlier = undefined;
      else earlier ??= { prompt: null };
      continue;
    }
    // Work before the window's first prompt: that turn's is counted from the
    // window's start, and work after an ended turn from its own first event.
    if (!turn && event.kind !== "prompt") {
      if (!earlier && event.kind === "turn_end") continue;
      const start = earlier ? since : at;
      turn = {
        meta,
        start,
        end: start,
        events: [],
        prompt: earlier?.prompt ?? null,
        ended: false,
      };
      turns.push(turn);
    }
    if (event.kind === "prompt") {
      turn = {
        meta,
        start: at,
        end: at,
        events: [],
        prompt: event,
        turnAt: held[index].turn,
        ended: false,
      };
      turns.push(turn);
      continue;
    }
    // Work after a turn ended (a background task finishing wakes the agent)
    // is its own turn, not the ended one stretched over the wait.
    if (turn.ended && event.kind !== "turn_end") {
      turn = {
        meta,
        start: at,
        end: at,
        events: [],
        prompt: null,
        ended: false,
      };
      turns.push(turn);
    }
    turn.events.push({
      ...event,
      time: at,
      inForce: held[index].inForce,
      turnAt: held[index].turn,
    });
    turn.end = Math.max(turn.end, at);
    if (event.kind === "turn_end") turn.ended = true;
  }
  // Only the newest turn can still be running.
  const last = turns.at(-1);
  if (last && !last.ended) {
    const running =
      meta.format === "copilot-cli" ? now - last.end < COPILOT_QUIET_MS : true;
    if (running) {
      last.end = now;
      last.running = true;
    }
  }
  return turns;
}

/**
 * The usage of an Agent Terminal session.
 * @param {object} input
 * @param {{ meta: object, events: object[] }[]} input.conversations the
 *   project's stored conversations (conversations.mjs)
 * @param {number} input.since when the session started
 * @param {number} input.now now, or when the session ended
 * @param {Map<string, object>} input.topics current topics by id (topics.mjs)
 * @param {Map<string, { topic: string, status: string }>} [input.declaredBy]
 *   record_topic history id -> the topic and status it declared (currentTopics), for attribution.mjs
 * @param {Map<string, string>} [input.filed] turn -> the topic a declaration
 *   named it for (currentTopics), for attribution.mjs
 */
export function sessionUsage({
  conversations,
  since,
  now,
  topics,
  actuals,
  declaredBy,
  filed,
}) {
  const tokens = emptyTokens();
  const byModel = new Map();
  let calls = 0;
  let context;
  let contextLimit = null;
  let premiumRequests;
  const intervals = [];
  const waste = new Map(
    WASTE_REASONS.map(({ reason, label }) => [
      reason,
      {
        reason,
        label,
        count: 0,
        outputTokens: 0,
        contextTokens: 0,
        examples: [],
      },
    ]),
  );
  const signals = new Map(
    [
      ...ASSUMPTIONS,
      {
        kind: "claim-corrected",
        label: "You said something it took as true isn't",
      },
    ].map(({ kind, label }) => [kind, { kind, label, count: 0, examples: [] }]),
  );
  const note = (entry, at, text) => {
    entry.count += 1;
    if (entry.examples.length < MAX_EXAMPLES)
      entry.examples.push({
        at: new Date(at).toISOString(),
        text: example(text),
      });
  };
  let working = 0;
  let waitingOnTools = 0;
  let asking = 0;
  let turnCount = 0;
  let running = false;
  let firstActivity;
  const topicTime = new Map();
  /** topic id (and topic id \0 phase) -> call id -> usage. */
  const topicCalls = new Map();
  /** Deviations from each task, by cause: see deviate. */
  const deviations = [];
  /** Model calls and working time made before any topic was declared. */
  const unattributed = { calls: new Set(), output: 0, working: 0 };
  const conversationsUsed = [];
  let compactions = 0;
  /** One row per model call, tool call and message of yours that turned the work: the usage store's (usageStore.mjs). */
  const ledger = [];

  for (const { meta, events } of conversations) {
    // Which topic and phase each event was for, over the whole conversation,
    // so a window starting part-way carries in what was in force.
    const held = attributeConversation(meta, events, { declaredBy, filed });
    const turns = turnsOf(meta, events, since, now, held);
    // Usage: a call's records repeat its counts, so keep one per call; a
    // session total counts only for a model whose calls weren't recorded.
    const perCall = new Map();
    const perSession = new Map();
    let lastCall;
    for (const event of events) {
      const at = timeOf(event);
      if (event.kind === "billing" && at !== undefined && at >= since)
        premiumRequests = Math.max(premiumRequests ?? 0, event.premiumRequests);
      if (event.kind !== "usage" || at === undefined || at < since) continue;
      if (event.scope === "session") perSession.set(event.model, event);
      else {
        perCall.set(event.call ?? `${at}`, event);
        lastCall = event;
      }
    }
    const callModels = new Set([...perCall.values()].map((use) => use.model));
    const counted = [...perCall.values()];
    const sessionTotals = [...perSession.values()].filter(
      (usage) => !callModels.has(usage.model),
    );
    // This conversation's own totals, by its id.
    const own = { ...emptyTokens(), calls: 0 };
    for (const usage of [...counted, ...sessionTotals]) {
      addTokens(tokens, usage);
      addTokens(own, usage);
      if (usage.scope === "call") own.calls += 1;
      const model = usage.model ?? "unknown";
      if (!byModel.has(model))
        byModel.set(model, { model, ...emptyTokens(), calls: 0 });
      addTokens(byModel.get(model), usage);
      if (usage.scope === "call") {
        byModel.get(model).calls += 1;
        calls += 1;
      }
    }
    if (lastCall) {
      context = lastCall.input + lastCall.cacheRead + lastCall.cacheWrite;
      contextLimit = lastCall.contextLimit ?? null;
    }
    if (
      turns.length === 0 &&
      counted.length === 0 &&
      sessionTotals.length === 0
    )
      continue;
    conversationsUsed.push({
      session: meta.session,
      agent: meta.agent,
      ...own,
      total: own.input + own.cacheRead + own.cacheWrite + own.output,
    });

    // A deviation from the task, by its cause, under the topic and phase in
    // force at the event it rests on (its time, inForce and turnAt). A call's
    // row names it; one from your message (a correction, added scope, a stop)
    // is a row of its own, so the store counts every cause the bar does, even
    // before any declaration.
    const deviate = (source, cause, kind, text, row) => {
      const { inForce, time: at } = source;
      if (row && !row.deviation)
        row.deviation = { cause, kind, text: example(text) };
      if (!row)
        ledger.push({
          ...rowOf(kind === "stopped" ? "interrupt" : "message", source),
          deviation: { cause, kind, text: example(text) },
        });
      if (inForce)
        deviations.push({ ...inForce, cause, kind, at, text: example(text) });
    };
    // Each model call once (its records repeat its counts; the last is kept).
    const modelRows = new Map();
    const rowOf = (kind, event) => ({
      kind,
      at: event.time,
      agent: meta.agent ?? null,
      conversation: meta.session,
      topic: event.inForce?.topic ?? null,
      phase: event.inForce?.phase ?? null,
      basis: event.inForce ? (event.inForce.basis ?? "declared") : null,
      turn: event.turnAt ?? null,
      waste: null,
      deviation: null,
    });
    let backgrounded = false;
    for (const [index, turn] of turns.entries()) {
      turnCount += 1;
      firstActivity = Math.min(firstActivity ?? turn.start, turn.start);
      if (turn.running) running = true;
      const next = turns[index + 1];
      // A turn the agent began itself, while a command it sent to the
      // background ran: the gap before it was spent waiting on that
      // command, not on you.
      const previous = turns[index - 1];
      if (turn.prompt) backgrounded = false;
      else if (
        backgrounded &&
        previous &&
        turn.events[0]?.kind !== "interjection"
      )
        waitingOnTools += Math.max(0, turn.start - previous.end);
      if (
        turn.events.some(
          (event) =>
            event.kind === "tool_result" && BACKGROUND.test(event.text ?? ""),
        )
      )
        backgrounded = true;
      const span = turn.end - turn.start;
      // Waiting on you inside the turn: questions it asked you.
      let asked = 0;
      const results = new Map();
      for (const event of turn.events)
        if (event.kind === "tool_result" && event.toolUseId)
          results.set(event.toolUseId, event);
      const seen = new Map();
      const usageAt = turn.events.filter((event) => event.kind === "usage");
      const outputBetween = (start, end) => {
        const ids = new Set();
        let output = 0;
        for (const usage of usageAt)
          if (
            usage.time >= start &&
            usage.time <= end &&
            !ids.has(usage.call)
          ) {
            ids.add(usage.call);
            output += usage.output;
          }
        return output;
      };
      const contextBetween = (start, end) => {
        let chars = 0;
        for (const event of turn.events)
          if (
            event.kind === "tool_result" &&
            event.time >= start &&
            event.time <= end
          )
            chars += event.chars ?? event.text?.length ?? 0;
        return Math.round(chars / CHARS_PER_TOKEN);
      };
      const add = (inForce, reason, start, end, text, measured = true) => {
        if (end <= start) return;
        intervals.push({
          reason,
          start,
          end,
          topic: inForce?.topic,
          session: meta.session,
          text: example(text),
        });
        const entry = waste.get(reason);
        note(entry, start, text);
        if (measured) {
          entry.outputTokens += outputBetween(start, end);
          entry.contextTokens += contextBetween(start, end);
        }
      };
      let segmentStart = turn.start;
      for (const [position, event] of turn.events.entries()) {
        const { inForce } = event;
        // A model call made before anything was declared counts apart, so
        // it is neither lost nor put under a guessed topic.
        if (event.kind === "usage" && event.scope === "call" && !inForce) {
          unattributed.calls.add(event.call ?? `${event.time}`);
          unattributed.output += event.output;
        }
        // Each model call counts toward the topic, and its phase, in force
        // when it was made.
        if (event.kind === "usage" && event.scope === "call")
          modelRows.set(event.call ?? `${event.time}`, {
            ...rowOf("model", event),
            id: event.call ?? null,
            model: event.model ?? null,
            input: event.input,
            cacheRead: event.cacheRead,
            cacheWrite: event.cacheWrite,
            output: event.output,
            context: event.input + event.cacheRead + event.cacheWrite,
            contextLimit: event.contextLimit ?? null,
          });
        if (event.kind === "usage" && event.scope === "call" && inForce)
          for (const key of keysOf(inForce.topic, inForce.phase)) {
            const calls = topicCalls.get(key) ?? new Map();
            calls.set(event.call ?? `${event.time}`, event);
            topicCalls.set(key, calls);
          }
        if (event.kind === "tool_use" && ASKING.has(event.tool)) {
          const answer = results.get(event.toolUseId);
          if (answer) asked += Math.max(0, answer.time - event.time);
        }
        if (event.kind === "interrupt") {
          deviate(event, "you", "stopped", turn.prompt?.text);
          add(
            inForce,
            "stopped",
            segmentStart,
            event.time,
            `Stopped during: ${turn.prompt?.text ?? "work the agent began itself"}`,
          );
          segmentStart = event.time;
        }
        if (event.kind === "interjection") {
          if (isCorrection(event.text)) {
            add(inForce, "corrected", segmentStart, event.time, event.text);
            deviate(event, "assumption", "corrected", event.text);
          } else if (isAddition(event.text))
            deviate(event, "you", "scope-added", event.text);
          if (correctsClaim(event.text))
            note(signals.get("claim-corrected"), event.time, event.text);
          segmentStart = event.time;
        }
        if (event.kind === "compaction") {
          compactions += 1;
          if (event.durationMs)
            add(
              inForce,
              "compaction",
              event.time - event.durationMs,
              event.time,
              "Context compacted",
              false,
            );
        }
        if (event.kind === "tool_use") {
          const result = results.get(event.toolUseId);
          // The call and, when it failed, the agent's recovery: until its
          // next tool use.
          const following = turn.events
            .slice(position + 1)
            .find((later) => later.kind === "tool_use");
          let assumed = false;
          const row = {
            ...rowOf("tool", event),
            id: event.toolUseId ?? null,
            tool: event.tool,
            resultChars: result
              ? (result.chars ?? result.text?.length ?? 0)
              : null,
            outcome: !result
              ? "pending"
              : !result.isError
                ? "ok"
                : GATE.test(result.text)
                  ? "refused"
                  : "error",
          };
          ledger.push(row);
          if (result?.isError) {
            const reason = GATE.test(result.text) ? "refused" : "failed";
            row.waste = {
              reason,
              text: `${event.tool}: ${example(result.text)}`,
            };
            add(
              inForce,
              reason,
              event.time,
              following?.time ?? result.time,
              `${event.tool}: ${example(result.text)}`,
            );
          }
          if (result) {
            // A successful result can quote these words (a tool's
            // description, source code); there only a program's own
            // complaint, in its own words, counts.
            for (const assumption of ASSUMPTIONS) {
              const pattern = result.isError
                ? assumption.pattern
                : assumption.inOutput;
              if (!pattern) continue;
              const line = matchingLine(result.text, pattern);
              if (line === undefined) continue;
              note(
                signals.get(assumption.kind),
                event.time,
                `${event.tool}: ${line}`,
              );
              deviate(
                event,
                "assumption",
                assumption.kind,
                `${event.tool}: ${line}`,
                row,
              );
              assumed = true;
              break;
            }
            // A failure that wasn't a wrong assumption: the session's rules
            // (the gate), or the tools and environment.
            if (result.isError && !assumed)
              deviate(
                event,
                GATE.test(result.text) ? "instructions" : "blocked",
                GATE.test(result.text) ? "refused" : "failed",
                `${event.tool}: ${example(result.text)}`,
                row,
              );
            const key = `${event.tool}\u0000${event.argsKey}`;
            // Each turn declares its topic again, as the gate asks.
            if (
              event.argsKey &&
              seen.has(key) &&
              !result.isError &&
              event.tool !== TOPIC_TOOL
            ) {
              row.waste = {
                reason: "repeated",
                text: `${event.tool}${event.target ? ` ${event.target}` : ""}`,
              };
              add(
                inForce,
                "repeated",
                event.time,
                result.time,
                `${event.tool}${event.target ? ` ${event.target}` : ""}`,
              );
            }
            if (!result.isError && event.argsKey) seen.set(key, event);
          }
          // After a change, the same call again is new work.
          if (WRITING.test(event.tool)) seen.clear();
        }
      }
      // Your next message corrects this turn's work, or adds to its scope:
      // the topic in force as the turn ended.
      const ended = turn.events.at(-1)?.inForce ?? null;
      // Your message is in the turn it starts.
      const message = {
        time: next?.start,
        inForce: ended,
        turnAt: next?.turnAt,
      };
      if (next?.prompt && isCorrection(next.prompt.text)) {
        add(ended, "corrected", segmentStart, turn.end, next.prompt.text);
        deviate(message, "assumption", "corrected", next.prompt.text);
      } else if (next?.prompt && isAddition(next.prompt.text))
        deviate(message, "you", "scope-added", next.prompt.text);
      if (next?.prompt && correctsClaim(next.prompt.text))
        note(signals.get("claim-corrected"), next.start, next.prompt.text);
      const worked = Math.max(0, span - asked);
      working += worked;
      asking += asked;
      unattributed.working += creditTurnTime(topicTime, turn, worked);
    }
    ledger.push(...modelRows.values());
  }
  // A call that wasn't waste itself (refused, failed, repeated) but was made
  // in wasted time (you stopped or corrected it, recovery from a failed
  // call, compaction) is waste for that time's strongest reason.
  const ranked = [...intervals].sort(
    (a, b) => RANK.get(a.reason) - RANK.get(b.reason),
  );
  for (const row of ledger) {
    // A message row's deviation already says how its time was spent.
    if (row.kind !== "model" && row.kind !== "tool") continue;
    row.waste ??=
      ranked.find(
        (interval) =>
          interval.session === row.conversation &&
          row.at >= interval.start &&
          row.at <= interval.end,
      ) ?? null;
    if (row.waste)
      row.waste = { reason: row.waste.reason, text: row.waste.text };
  }
  // A model call comes before the tool calls it made, at the same moment.
  ledger.sort(
    (a, b) =>
      a.at - b.at || Number(b.kind === "model") - Number(a.kind === "model"),
  );

  const exclusive = exclusiveTime(intervals);
  const wastedMs = [...exclusive.values()].reduce((sum, ms) => sum + ms, 0);
  for (const interval of exclusiveTopicTime(intervals)) {
    const entry = topicTime.get(interval.topic);
    if (entry) entry.wasted += interval.ms;
  }
  const start = Math.min(since, firstActivity ?? since);
  const elapsed = Math.max(0, now - start);
  const wasteList = [...waste.values()]
    .map((entry) => ({ ...entry, ms: exclusive.get(entry.reason) ?? 0 }))
    .filter((entry) => entry.count > 0);
  const outputWasted = wasteList.reduce(
    (sum, entry) => sum + entry.outputTokens,
    0,
  );
  const contextWasted = wasteList.reduce(
    (sum, entry) => sum + entry.contextTokens,
    0,
  );

  return {
    since,
    now,
    running,
    conversations: conversationsUsed,
    turns: turnCount,
    tokens: {
      ...tokens,
      total:
        tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output,
      calls,
      context: context ?? null,
      contextLimit,
      aiCredits: tokens.aiCreditsNano
        ? tokens.aiCreditsNano * CREDITS_PER_NANO
        : null,
      compactions,
      premiumRequests: premiumRequests ?? null,
      byModel: [...byModel.values()].sort((a, b) => b.output - a.output),
    },
    time: {
      elapsed,
      working,
      waitingOnYou: Math.max(0, elapsed - working - waitingOnTools),
      waitingOnTools,
      askingYou: asking,
      wasted: Math.min(wastedMs, working),
    },
    waste: {
      outputTokens: outputWasted,
      outputShare: tokens.output ? outputWasted / tokens.output : null,
      contextTokens: contextWasted,
      reasons: wasteList,
    },
    signals: [...signals.values()].filter((entry) => entry.count > 0),
    unattributed: {
      calls: unattributed.calls.size,
      outputTokens: unattributed.output,
      working: unattributed.working,
    },
    // Tasks are judged on all their calls (actuals), not only this window's.
    progress: progressOf(
      topics,
      actuals ?? { topicTime, topicCalls, deviations },
      since,
      now,
    ),
    topicTime,
    topicCalls,
    deviations,
    ledger,
    method: {
      tokens:
        "The agent's own per-call counts, as each call finishes; context is what the last call read, against the prompt window it was allowed where the agent records it. Credits are what the agent's service billed each call, the figure the agent shows itself. A Copilot CLI session old enough to have recorded no calls one by one counts from its totals at shutdown instead, and its premium requests come as it goes.",
      time: "Working is each turn from your message to the agent's last event (to now while it runs), less time it waited on a question to you; waiting on commands is the gap before a turn the agent began itself while a command it sent to the background ran; waiting on you is the rest.",
      waste:
        "Wasted time is work your next message corrected or you stopped, refused and failed calls up to the agent's next call, repeated identical calls, and compaction; overlapping time counts once. Output tokens in wasted time are measured; context tokens are estimated at 4 characters a token from what the calls returned.",
      attribution:
        "Each call counts toward the topic in force when it was made: one its turn declared, one a later declaration named the turn for, or, in a turn that declared nothing, the topic the conversation was last in (carried, counted apart so you can see it). Calls made before any declaration in their conversation are in no task and shown as such.",
      signals:
        "Each signal is a tool or you contradicting something the agent assumed; they point at likely wrong assumptions, not proof of them.",
      estimate:
        "Time left compares this task's elapsed time with this project's finished topics that ran at least as long (wall-clock, waits included).",
    },
  };
}

/**
 * What every topic used across all of a project's stored conversations, by
 * conversation id, whichever session or restart they ran in: each model call
 * and its working time, under the topic in force when it was made.
 */
export function topicActuals({ conversations, now, declaredBy, filed }) {
  const { topicTime, topicCalls, deviations, ledger } = sessionUsage({
    conversations,
    since: -Infinity,
    now,
    topics: undefined,
    declaredBy,
    filed,
  });
  return { topicTime, topicCalls, deviations, ledger };
}

/**
 * A turn's working time, by the topic and phase in force through it: each
 * stretch between events counts toward what was in force at its start (the
 * first toward the first event's), scaled to the share of the turn worked.
 * Returns the working time no topic was in force for.
 */
function creditTurnTime(topicTime, turn, worked) {
  const span = turn.end - turn.start;
  if (span <= 0 || worked <= 0) return 0;
  const share = worked / span;
  let from = turn.start;
  let inForce = turn.events[0]?.inForce ?? null;
  let none = 0;
  const credit = (to) => {
    if (to > from && !inForce) none += (to - from) * share;
    if (inForce && to > from)
      for (const key of keysOf(inForce.topic, inForce.phase)) {
        const entry = topicTime.get(key) ?? { working: 0, wasted: 0 };
        entry.working += (to - from) * share;
        topicTime.set(key, entry);
      }
    from = Math.max(from, to);
  };
  for (const event of turn.events) {
    credit(event.time);
    inForce = event.inForce ?? null;
  }
  credit(turn.end);
  return none;
}

/** Wasted time per topic, each moment once under its strongest reason. */
function exclusiveTopicTime(intervals) {
  const byTopic = new Map();
  for (const interval of intervals) {
    if (!interval.topic) continue;
    const list = byTopic.get(interval.topic) ?? [];
    list.push(interval);
    byTopic.set(interval.topic, list);
  }
  return [...byTopic].map(([topic, list]) => ({
    topic,
    ms: [...exclusiveTime(list).values()].reduce((sum, ms) => sum + ms, 0),
  }));
}

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];

/**
 * The session's topics with their time, and for the current one an estimate
 * of time left from the project's finished topics that ran at least as long.
 */
/** What a topic's model calls used, and its working time, in the estimate's units. */
function actualOf(calls, time) {
  const used = [...(calls?.values() ?? [])];
  return {
    model_calls: used.length,
    output_tokens: used.reduce((sum, usage) => sum + usage.output, 0),
    ai_credits: used.reduce(
      (sum, usage) => sum + (usage.aiCreditsNano ?? 0) * CREDITS_PER_NANO,
      0,
    ),
    context_tokens: used.reduce(
      (sum, usage) => sum + usage.input + usage.cacheRead + usage.cacheWrite,
      0,
    ),
    working_minutes: Math.round((time?.working ?? 0) / MINUTE),
  };
}

/** Model calls by the basis they were allocated on: declared, named or carried. */
function basisOf(calls) {
  const by = { declared: 0, named: 0, carried: 0 };
  for (const usage of calls?.values() ?? [])
    by[usage.inForce?.basis ?? "declared"] += 1;
  return by;
}

const ESTIMATED = [
  "model_calls",
  "output_tokens",
  "context_tokens",
  "working_minutes",
];

/**
 * How the first estimate compares with what was used: per measure, the
 * range, the actual, and for a closed topic whether it landed in the range
 * and how far off its middle it was; for an open one, the share of the
 * range's top used so far.
 */
export function estimateAccuracy(estimate, actual, closed) {
  if (!estimate) return null;
  const measures = ESTIMATED.flatMap((name) => {
    const range = estimate[name];
    if (!range) return [];
    const middle = (range.low + range.high) / 2;
    const value = actual[name];
    return [
      {
        measure: name,
        low: range.low,
        high: range.high,
        actual: value,
        within: closed ? value >= range.low && value <= range.high : null,
        over: value > range.high,
        ratio: middle > 0 ? value / middle : null,
        usedOfHigh: range.high > 0 ? value / range.high : null,
      },
    ];
  });
  return {
    confidence: estimate.confidence,
    basis: estimate.basis ?? "",
    closed,
    measures,
  };
}

/**
 * How a task deviated, by cause: corrected assumptions and tools
 * contradicting it (the agent's), scope you added or work you stopped
 * (yours), the session's rules (instructions), failing tools (blocked), and
 * phases outside the plan, credited to you when you had just added scope.
 */
function phasesOf(topic, topicTime, topicCalls, closed) {
  const phases = topic.phases ?? [];
  return phases.map((phase, index) => {
    const key = `${topic.topic_id}\u0000${phase.name}`;
    const time = topicTime.get(key);
    // A phase is over once the next starts, or the task closes.
    const over = closed || index < phases.length - 1;
    return {
      name: phase.name,
      startedAt: phase.started_at,
      working: time?.working ?? 0,
      wasted: time?.wasted ?? 0,
      accuracy: estimateAccuracy(
        phase.estimate ?? null,
        actualOf(topicCalls.get(key), time),
        over,
      ),
      actual: actualOf(topicCalls.get(key), time),
    };
  });
}

function deviationOf(topic, phases, deviations, closed) {
  const own = deviations.filter((entry) => entry.topic === topic.topic_id);
  const plan = topic.first_plan ?? null;
  const unplanned = plan
    ? phases
        .filter((phase) => !plan.includes(phase.name))
        .map((phase, index, list) => {
          const from = index > 0 ? Date.parse(list[index - 1].startedAt) : 0;
          const to = Date.parse(phase.startedAt);
          const byYou = own.some(
            (entry) =>
              entry.cause === "you" &&
              entry.kind === "scope-added" &&
              entry.at >= from &&
              entry.at <= to,
          );
          return { name: phase.name, cause: byYou ? "you" : "agent" };
        })
    : [];
  const reached = new Set(phases.map((phase) => phase.name));
  const skipped =
    plan && closed ? plan.filter((name) => !reached.has(name)) : [];
  const byCause = {};
  for (const entry of own)
    byCause[entry.cause] = (byCause[entry.cause] ?? 0) + 1;
  for (const phase of unplanned)
    byCause[phase.cause] = (byCause[phase.cause] ?? 0) + 1;
  return {
    plan,
    unplanned,
    skipped,
    byCause,
    latest: own.slice(-5).map((entry) => ({
      ...entry,
      at: new Date(entry.at).toISOString(),
    })),
  };
}

/**
 * Every task of a project, judged on all its calls (topicActuals): estimate
 * against actual, its phases and deviations, as the usage bar judges the
 * session's.
 */
export const taskProgress = (topics, actuals, now) =>
  progressOf(topics, actuals, -Infinity, now).topics;

function progressOf(topics, actuals, since, now) {
  const { topicTime, topicCalls, deviations = [] } = actuals;
  if (!topics) return { topics: [], current: null, estimate: null };
  const all = [...topics.values()].filter((topic) => topic.kind !== "thread");
  const mine = all
    .filter((topic) => Date.parse(topic.declared_at) >= since)
    .sort((a, b) => Date.parse(a.declared_at) - Date.parse(b.declared_at));
  const listed = mine.map((topic) => {
    const first = Date.parse(topic.first_declared_at ?? topic.declared_at);
    const closed = topic.status === "done" || topic.status === "abandoned";
    const time = topicTime.get(topic.topic_id);
    return {
      id: topic.topic_id,
      title: topic.title,
      kind: topic.kind,
      status: topic.status,
      startedAt: first,
      elapsed: Math.max(
        0,
        (closed ? Date.parse(topic.declared_at) : now) - first,
      ),
      working: time?.working ?? null,
      wasted: time?.wasted ?? null,
      // On what basis its calls are counted here (attribution.mjs).
      callsBy: basisOf(topicCalls.get(topic.topic_id)),
      // Only this session's calls: a task that spans sessions is judged on
      // the part seen here.
      accuracy: estimateAccuracy(
        topic.first_estimate ?? null,
        actualOf(topicCalls.get(topic.topic_id), time),
        closed,
      ),
      reestimated:
        topic.first_estimate && topic.estimate !== topic.first_estimate
          ? topic.estimate
          : null,
      phases: phasesOf(topic, topicTime, topicCalls, closed),
    };
  });
  for (const entry of listed)
    entry.deviation = deviationOf(
      topics.get(entry.id),
      entry.phases,
      deviations,
      entry.status === "done" || entry.status === "abandoned",
    );
  const current =
    listed.findLast(
      (topic) => topic.status !== "done" && topic.status !== "abandoned",
    ) ?? null;
  return {
    topics: listed,
    current: current?.id ?? null,
    estimate: current ? estimateLeft(all, current) : null,
  };
}

function estimateLeft(all, current) {
  const durations = all
    .filter((topic) => topic.status === "done" && topic.topic_id !== current.id)
    .map(
      (topic) =>
        Date.parse(topic.declared_at) -
        Date.parse(topic.first_declared_at ?? topic.declared_at),
    )
    .filter((ms) => Number.isFinite(ms) && ms >= MINUTE);
  const longer = durations
    .filter((ms) => ms >= current.elapsed)
    .map((ms) => ms - current.elapsed)
    .sort((a, b) => a - b);
  const basis = { finished: durations.length, ranThisLong: longer.length };
  if (longer.length < 3)
    return {
      ...basis,
      median: null,
      p80: null,
      reason:
        durations.length < 3
          ? "Too few finished topics in this project to estimate from."
          : `Only ${longer.length} of ${durations.length} finished topics ran this long, too few to estimate from: this one is already longer than usual.`,
    };
  return {
    ...basis,
    median: quantile(longer, 0.5),
    p80: quantile(longer, 0.8),
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// Account usage: the plans' limits and this machine's use against them

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** How long each kind of plan window runs, by the service's group name. */
const WINDOW_MS = { session: 5 * HOUR, weekly: 7 * DAY };
// The pace that predicts when a window fills: the last half hour's use.
const PACE_MS = 30 * MINUTE;

const tokensOf = (totals) =>
  totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
const camel = (totals) => ({
  calls: totals.calls,
  input: totals.input,
  cacheRead: totals.cache_read,
  cacheWrite: totals.cache_write,
  output: totals.output,
  premiumRequests: totals.premium_requests,
});

/**
 * One plan window: what the service said was used, and an estimate of where
 * it stands now from this machine's use since, calibrated on this machine's
 * use before the figure (tokens per percent).
 */
function planWindow(window, fetchedAt, ledger, now) {
  const length = WINDOW_MS[window.group] ?? null;
  const resets = Date.parse(window.resets_at ?? "");
  const start = length && Number.isFinite(resets) ? resets - length : null;
  const base = {
    kind: window.kind,
    group: window.group,
    active: window.active,
    severity: window.severity,
    resetsAt: Number.isFinite(resets) ? resets : null,
    percent: window.percent,
    left: Math.max(0, 100 - window.percent),
  };
  // The window has rolled over since Claude Code fetched the figure.
  if (Number.isFinite(resets) && resets <= now)
    return { ...base, rolledOver: true, local: null, estimate: null };
  const local =
    start === null ? null : camel(ledger.totals("claude-code", start, now));
  let estimate = null;
  if (start !== null && window.percent > 0 && fetchedAt > start) {
    const before = tokensOf(
      camel(ledger.totals("claude-code", start, fetchedAt)),
    );
    const since = tokensOf(camel(ledger.totals("claude-code", fetchedAt, now)));
    if (before > 0) {
      const perPercent = before / window.percent;
      const percentNow = Math.min(100, window.percent + since / perPercent);
      const pace =
        tokensOf(camel(ledger.totals("claude-code", now - PACE_MS, now))) /
        PACE_MS;
      const untilFull =
        pace > 0 ? ((100 - percentNow) * perPercent) / pace : null;
      estimate = {
        percent: percentNow,
        left: Math.max(0, 100 - percentNow),
        // Only when it would fill before the window resets.
        fullAt:
          untilFull !== null && now + untilFull < resets
            ? now + untilFull
            : null,
      };
    }
  }
  return { ...base, rolledOver: false, local, estimate };
}

// The status line's names for the plan windows, by the service's group.
const LIVE_WINDOWS = { five_hour: "session", seven_day: "weekly" };
const epochOrDate = (value) =>
  typeof value === "number"
    ? value < 1e12
      ? value * 1000
      : value
    : Date.parse(value ?? "");

/**
 * The plan's windows, from the live limits Claude Code last handed its status
 * line where they are newer than its cached figures. Each window carries the
 * time its figure is from.
 */
function withLiveLimits(plan, live) {
  const cachedAt = plan ? Date.parse(plan.fetched_at) : null;
  const windows = (plan?.windows ?? []).map((window) => ({
    ...window,
    asOf: cachedAt,
  }));
  const fresh = live?.available && live.at > (cachedAt ?? 0);
  if (fresh)
    for (const [name, group] of Object.entries(LIVE_WINDOWS)) {
      const entry = live.rate_limits?.[name];
      if (typeof entry?.used_percentage !== "number") continue;
      const resets = epochOrDate(entry.resets_at);
      const update = {
        percent: entry.used_percentage,
        resets_at: Number.isFinite(resets)
          ? new Date(resets).toISOString()
          : null,
        asOf: live.at,
      };
      const index = windows.findIndex((window) => window.group === group);
      if (index === -1)
        windows.push({
          kind: name,
          group,
          active: false,
          severity: null,
          ...update,
        });
      else windows[index] = { ...windows[index], ...update };
    }
  if (!plan && !fresh) return null;
  return {
    windows,
    live: Boolean(fresh),
    fetchedAt: fresh ? live.at : cachedAt,
  };
}

/**
 * The accounts' usage: Claude Code's plan windows and extra usage, Copilot
 * CLI's monthly premium requests, and this machine's use today, this week
 * and this month.
 * @param {object} input
 * @param {object | null} input.plan Claude Code's plan (readClaudePlan)
 * @param {object} input.ledger this machine's usage (createUsageLedger)
 * @param {number} input.now
 */
export function accountUsage({ plan, live, ledger, now }) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const month = new Date(today);
  month.setDate(1);
  const merged = withLiveLimits(plan, live);
  const fetchedAt = merged ? merged.fetchedAt : null;
  const windows = merged
    ? merged.windows.map((window) =>
        planWindow(window, window.asOf, ledger, now),
      )
    : [];
  const weekly = windows.find((window) => window.group === "weekly");
  const weekStart =
    weekly?.resetsAt && !weekly.rolledOver
      ? weekly.resetsAt - WINDOW_MS.weekly
      : now - 7 * DAY;
  const periods = (agent) => ({
    today: camel(ledger.totals(agent, today.getTime(), now)),
    week: camel(ledger.totals(agent, weekStart, now)),
    month: camel(ledger.totals(agent, month.getTime(), now)),
  });
  const quota = ledger.copilotQuota();
  return {
    weekStartsAt: weekStart,
    claude: {
      plan: merged
        ? {
            fetchedAt,
            live: merged.live,
            windows,
            extraUsage: plan?.extra_usage ?? null,
            claudeCodeShare: plan?.claude_code_share ?? null,
            resets: plan?.resets ?? null,
          }
        : null,
      local: periods("claude-code"),
    },
    copilot: {
      quota: quota
        ? {
            at: Date.parse(quota.at ?? "") || null,
            unlimited: quota.unlimited,
            entitlement: quota.entitlement,
            used: quota.used,
            remainingPercent: quota.remaining_percent,
            resetsAt: Date.parse(quota.resets_at ?? "") || null,
            overageAllowed: quota.overage_allowed,
          }
        : null,
      local: periods("copilot-cli"),
    },
    method:
      "Plan figures are the services' own and count use on every device and app: Claude Code's are live, from the rate limits it hands a workbench session's status line after each reply, or else its last fetch; Copilot CLI's come with each of its model calls. Local figures count this machine's transcripts only. Between figures, where a window stands is an estimate (the last figure plus this machine's tokens since, at the tokens per percent this machine used before it), shown only once it differs; when it fills assumes the last half hour's pace.",
  };
}

// ---------------------------------------------------------------------------
// Budget: what the open tasks would take of each plan window

// A fresh conversation's context per call when this project has too few
// conversations to measure it (measured here on 23 Oct: about 60k).
const FRESH_CONTEXT = 60_000;
// A fresh conversation's context: each one's mean over its first calls, the
// median over this project's most recent conversations with enough calls.
const FRESH_CALLS = 20;
const FRESH_MIN_CALLS = 5;
const FRESH_CONVERSATIONS = 20;

/**
 * What a call in a fresh conversation reads in this project: each
 * conversation's mean context over its first calls, the median of the most
 * recent ones. Null with too few to measure.
 * @param {Array<{ events: object[] }>} conversations
 */
export function freshContext(conversations) {
  const means = conversations.flatMap(({ events }) => {
    const calls = new Map();
    for (const event of events) {
      if (event.kind !== "usage" || event.scope === "session") continue;
      const key = event.call ?? event.at;
      if (!calls.has(key)) calls.set(key, event);
    }
    const first = [...calls.values()]
      .sort((a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0))
      .slice(0, FRESH_CALLS);
    if (first.length < FRESH_MIN_CALLS) return [];
    const read = first.reduce(
      (sum, call) => sum + call.input + call.cacheRead + call.cacheWrite,
      0,
    );
    return [{ at: timeOf(first[0]) ?? 0, perCall: read / first.length }];
  });
  const recent = means
    .sort((a, b) => b.at - a.at)
    .slice(0, FRESH_CONVERSATIONS)
    .map((entry) => entry.perCall)
    .sort((a, b) => a - b);
  if (recent.length < 3) return null;
  return { perCall: quantile(recent, 0.5), conversations: recent.length };
}
// Status line readings this recent measure what a percent costs.
const CALIBRATION_MS = 7 * DAY;
// Readings come in whole percents: fewer points than this are too coarse.
const MIN_POINTS = 5;
// The weekly pace while working: its points over the last day of readings.
const WEEKLY_PACE_MS = DAY;

/** The status line's readings (statusLine.mjs's history), oldest first. */
export function statusReadings(text) {
  const window = (entry) =>
    typeof entry?.used_percentage === "number"
      ? { percent: entry.used_percentage, resets: epochOrDate(entry.resets_at) }
      : null;
  return text
    .split("\n")
    .flatMap((line) => {
      try {
        const record = JSON.parse(line);
        if (typeof record?.at !== "number") return [];
        return [
          {
            at: record.at,
            session: window(record.rate_limits?.five_hour),
            weekly: window(record.rate_limits?.seven_day),
          },
        ];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * What a percent of each window costs in this machine's tokens and calls,
 * summed over consecutive readings inside one window (a reset between two
 * readings says nothing). Falls back to each window's use so far.
 */
function calibrate(readings, windows, ledger, now) {
  const sums = {
    session: { points: 0, tokens: 0, calls: 0 },
    weekly: { points: 0, tokens: 0 },
  };
  const recent = readings.filter((r) => r.at >= now - CALIBRATION_MS);
  for (let index = 1; index < recent.length; index += 1) {
    const [a, b] = [recent[index - 1], recent[index]];
    const used = camel(ledger.totals("claude-code", a.at, b.at));
    for (const group of ["session", "weekly"]) {
      if (!a[group] || !b[group] || a[group].resets !== b[group].resets)
        continue;
      const sum = sums[group];
      sum.points += Math.max(0, b[group].percent - a[group].percent);
      sum.tokens += tokensOf(used);
      if (group === "session") sum.calls += used.calls;
    }
  }
  const perPercent = {};
  for (const group of ["session", "weekly"]) {
    const sum = sums[group];
    const window = windows.find((entry) => entry.group === group);
    if (sum.points >= MIN_POINTS && sum.tokens > 0)
      perPercent[group] = {
        tokens: sum.tokens / sum.points,
        calls: sum.calls ? sum.calls / sum.points : null,
        points: sum.points,
        source: "readings",
      };
    else if (window?.local && window.percent >= MIN_POINTS)
      perPercent[group] = {
        tokens: tokensOf(window.local) / window.percent,
        calls: window.local.calls / window.percent,
        points: window.percent,
        source: "window",
      };
    else perPercent[group] = null;
  }
  return perPercent;
}

/**
 * Weekly points an hour, two ways, each with the time it spans: over the last
 * day's readings (the status line records only while an agent replies, so
 * their span leaves out idle time: the pace while working), and over the
 * window so far (idle time included).
 */
function weeklyPaces(readings, weekly, now) {
  if (!weekly?.resetsAt) return [];
  const paces = [];
  const inWindow = readings.filter(
    (r) => r.weekly?.resets === weekly.resetsAt && r.at >= now - WEEKLY_PACE_MS,
  );
  const [first, last] = [inWindow[0], inWindow.at(-1)];
  if (first && last && last.at - first.at >= HOUR)
    paces.push({
      source: "readings",
      perHour:
        ((last.weekly.percent - first.weekly.percent) / (last.at - first.at)) *
        HOUR,
      spanMs: last.at - first.at,
    });
  const elapsed = now - (weekly.resetsAt - WINDOW_MS.weekly);
  if (elapsed >= HOUR)
    paces.push({
      source: "window",
      perHour: (weekly.percent / elapsed) * HOUR,
      spanMs: elapsed,
    });
  return paces;
}

/** What is left of a task's estimate: its range less what it has used. */
function remainingOf(task) {
  const measures = task.accuracy?.measures ?? [];
  const latest = task.reestimated;
  const left = (name) => {
    const measure = measures.find((entry) => entry.measure === name);
    const range = latest?.[name] ?? measure;
    if (!range) return null;
    const used = measure?.actual ?? 0;
    return {
      low: Math.max(0, range.low - used),
      high: Math.max(0, range.high - used),
    };
  };
  return {
    calls: left("model_calls"),
    output: left("output_tokens"),
    context: left("context_tokens"),
  };
}

/** A task's tokens left, at a context per call, or else its context estimate. */
function tokensLeft(remaining, perCall) {
  const bound = (end) => {
    const read =
      remaining.calls && perCall
        ? remaining.calls[end] * perCall
        : remaining.context?.[end];
    if (read === undefined) return null;
    return read + (remaining.output?.[end] ?? 0);
  };
  const low = bound("low");
  const high = bound("high");
  return low === null || high === null ? null : { low, high };
}

/** A cost in tokens as each window's percent. */
function percentCost(tokens, perPercent) {
  if (!tokens) return null;
  const cost = {};
  for (const group of ["session", "weekly"]) {
    const rate = perPercent[group]?.tokens;
    cost[group] = rate
      ? { low: tokens.low / rate, high: tokens.high / rate }
      : null;
  }
  return cost.session || cost.weekly ? cost : null;
}

/**
 * Whether a cost fits what is left of every window it is known for, the
 * window it uses most of (binding), and when it could start if it doesn't.
 */
function fitOf(cost, windows) {
  if (!cost) return null;
  let binding = null;
  let worst = -1;
  let waitsUntil = null;
  for (const window of windows) {
    const share = cost[window.group];
    if (!share) continue;
    const used = window.left > 0 ? share.high / window.left : Infinity;
    if (used > worst) [worst, binding] = [used, window.group];
    if (share.high > window.left)
      waitsUntil = Math.max(waitsUntil ?? 0, window.resetsAt ?? 0) || null;
  }
  return { fits: worst <= 1, binding, waitsUntil };
}

function taskBudget(task, current, perPercent, windows, context, perCall) {
  const remaining = remainingOf(task);
  const now = percentCost(tokensLeft(remaining, context), perPercent);
  const fresh =
    context && context > perCall && remaining.calls
      ? percentCost(tokensLeft(remaining, perCall), perPercent)
      : null;
  const fitNow = fitOf(now, windows);
  const fitFresh = fitOf(fresh, windows);
  const verdict = !fitNow
    ? "unknown"
    : fitNow.fits
      ? "now"
      : fitFresh?.fits
        ? "fresh"
        : "reset";
  const callsMeasure = task.accuracy?.measures.find(
    (entry) => entry.measure === "model_calls",
  );
  return {
    id: task.id,
    title: task.title,
    current: task.id === current,
    pastEstimate: Boolean(callsMeasure?.over),
    remaining,
    cost: { now, fresh },
    verdict,
    binding: fitNow?.binding ?? null,
    waitsUntil: verdict === "reset" ? (fitFresh ?? fitNow).waitsUntil : null,
  };
}

/**
 * What the session's open tasks would take of Claude's plan windows: each
 * task's estimate less what it has used, in both windows' percents at what
 * a percent has cost this machine, and whether it fits now, fits in a fresh
 * conversation, or waits for a reset; with when the weekly window runs out
 * at the recent pace.
 * @param {object} input
 * @param {object} input.account accountUsage's result
 * @param {Array} input.readings statusReadings's result
 * @param {object} input.ledger this machine's usage (createUsageLedger)
 * @param {object} input.progress sessionUsage's progress
 * @param {number | null} input.context the conversation's context per call now
 * @param {{ perCall: number, conversations: number } | null} input.fresh
 *   a fresh conversation's context per call here (freshContext)
 * @param {number} input.now
 */
export function budgetOf({
  account,
  readings,
  ledger,
  progress,
  context,
  fresh,
  now,
}) {
  const perCall = fresh?.perCall ?? FRESH_CONTEXT;
  const windows = (account.claude.plan?.windows ?? [])
    .filter((window) => window.group in WINDOW_MS)
    .map((window) => {
      const percent = window.rolledOver
        ? 0
        : (window.estimate?.percent ?? window.percent);
      return {
        group: window.group,
        percent,
        left: Math.max(0, 100 - percent),
        resetsAt: window.rolledOver ? null : window.resetsAt,
        local: window.local,
      };
    });
  const perPercent = calibrate(readings, windows, ledger, now);
  const weekly = windows.find((window) => window.group === "weekly");
  // When the weekly window runs out at a pace, if before its reset.
  const runsOutAt = (pace) => {
    const at =
      pace.perHour > 0 ? now + (weekly.left / pace.perHour) * HOUR : Infinity;
    return at < (weekly.resetsAt ?? 0) ? at : null;
  };
  const weeklyPerSession =
    perPercent.session && perPercent.weekly
      ? perPercent.session.tokens / perPercent.weekly.tokens
      : null;
  const tasks = (progress?.topics ?? [])
    .filter(
      (task) =>
        task.status !== "done" && task.status !== "abandoned" && task.accuracy,
    )
    .map((task) =>
      taskBudget(task, progress.current, perPercent, windows, context, perCall),
    )
    .sort((a, b) => Number(b.current) - Number(a.current));
  const big = tasks.find((task) => (task.remaining.calls?.high ?? 0) >= 20);
  return {
    windows: windows.map(({ local: _local, ...window }) => window),
    perPercent,
    weeklyPerSession,
    weekly: weekly
      ? {
          paces: weeklyPaces(readings, weekly, now).map((pace) => ({
            ...pace,
            runsOutAt: runsOutAt(pace),
          })),
          sessionsLeft: weeklyPerSession
            ? weekly.left / (100 * weeklyPerSession)
            : null,
        }
      : null,
    context,
    fresh: fresh
      ? { perCall, conversations: fresh.conversations, source: "measured" }
      : { perCall, conversations: 0, source: "assumed" },
    tasks,
    advice:
      big && context > 2 * perCall
        ? `Start big tasks in a fresh conversation: each call here reads about ${Math.round(context / 1000)}k tokens of context, against about ${Math.round(perCall / 1000)}k in a fresh one.`
        : null,
    method:
      "A task's cost is its latest estimate less what it has used: calls left times this conversation's context per call (or its context estimate), plus output left, as tokens. A percent's cost is this machine's tokens between the status line's readings over the last week, divided by the points each window rose; with fewer than 5 points, the window's use so far. The plan's figures count every device and app, so use elsewhere makes a percent look cheaper. A task fits when the top of its range fits what is left of every window; a fresh conversation reads what this project's recent conversations read a call over their first 20 calls (the median of their means), or 60k a call with fewer than 3 to measure. The weekly window's pace is shown two ways: over the last day's readings, which the status line takes only while an agent replies (the pace while working, idle time left out), and over the window so far (idle time included); each says when the window runs out at it.",
  };
}
