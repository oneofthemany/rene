// Usage of one Agent Terminal session: the tokens its agent used, where its
// time went (working, waiting on you, wasted) and how far its tasks have got.
//
// Everything here is read from the conversation events rene parses from the
// agent's own transcript (conversations.mjs stores them) and from the topics
// the agent declared. Tokens are the agent's own counts; time is measured
// between transcript timestamps. Waste and the signals of wrong assumptions
// are classifications of those events: each names the event it rests on, so
// they can be checked, and none is proof on its own.

const MINUTE = 60_000;
// A Copilot turn records no end; one whose last event is this recent is
// taken to be still running.
const COPILOT_QUIET_MS = 90_000;
// Tool results join the context the agent reads; ~4 characters a token.
const CHARS_PER_TOKEN = 4;
const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 160;
const ASKING = new Set(["AskUserQuestion", "ask_user"]);
const TOPIC_TOOL = "record_topic";
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

/**
 * The topic and phase a record_topic call declared: from its arguments, or
 * when they came on stdin and the transcript doesn't show them, from what
 * it printed (`declared topic <id>` and the result's phase).
 */
const declarationOf = (use, result) => {
  const text = result?.isError ? "" : (result?.text ?? "");
  const topic =
    (typeof use.args?.topic_id === "string" ? use.args.topic_id : undefined) ??
    /declared topic ([0-9a-f-]{36})/u.exec(text)?.[1];
  const phase =
    (typeof use.args?.phase === "string" ? use.args.phase : undefined) ??
    /"phase":"((?:[^"\\]|\\.)*)"/u.exec(text)?.[1];
  return { topic, phase };
};

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
 * agent's work after it, up to its last event (or now, while it runs).
 */
function turnsOf(meta, events, since, now) {
  const turns = [];
  let turn;
  // The prompt of a turn still under way when the window starts.
  let earlier;
  for (const event of events) {
    const at = timeOf(event);
    if (at === undefined) continue;
    if (at < since) {
      if (event.kind === "prompt") earlier = event;
      else if (event.kind === "turn_end") earlier = undefined;
      continue;
    }
    // That turn's work inside the window is counted from the window's start.
    if (!turn && earlier && event.kind !== "prompt") {
      turn = {
        meta,
        start: since,
        end: since,
        events: [],
        prompt: earlier,
        ended: false,
      };
      turns.push(turn);
      earlier = undefined;
    }
    if (event.kind === "prompt") {
      turn = {
        meta,
        start: at,
        end: at,
        events: [],
        prompt: event,
        ended: false,
      };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
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
    turn.events.push({ ...event, time: at });
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
 */
export function sessionUsage({ conversations, since, now, topics, actuals }) {
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
  const conversationsUsed = [];
  let compactions = 0;

  for (const { meta, events } of conversations) {
    const turns = turnsOf(meta, events, since, now);
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

    let topic;
    let phase = null;
    // A deviation from the task, by its cause, under the topic and phase in
    // force.
    const deviate = (cause, kind, at, text) => {
      if (topic)
        deviations.push({ topic, phase, cause, kind, at, text: example(text) });
    };
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
      const add = (reason, start, end, text, measured = true) => {
        if (end <= start) return;
        intervals.push({ reason, start, end, topic });
        const entry = waste.get(reason);
        note(entry, start, text);
        if (measured) {
          entry.outputTokens += outputBetween(start, end);
          entry.contextTokens += contextBetween(start, end);
        }
      };
      let segmentStart = turn.start;
      for (const [position, event] of turn.events.entries()) {
        if (event.kind === "tool_use" && event.tool === TOPIC_TOOL) {
          const declared = declarationOf(event, results.get(event.toolUseId));
          if (declared.topic && declared.topic !== topic) phase = null;
          if (declared.topic) topic = declared.topic;
          if (declared.phase) phase = declared.phase;
        }
        // Each model call counts toward the topic, and its phase, in force
        // when it was made.
        if (event.kind === "usage" && event.scope === "call" && topic)
          for (const key of keysOf(topic, phase)) {
            const calls = topicCalls.get(key) ?? new Map();
            calls.set(event.call ?? `${event.time}`, event);
            topicCalls.set(key, calls);
          }
        if (event.kind === "tool_use" && ASKING.has(event.tool)) {
          const answer = results.get(event.toolUseId);
          if (answer) asked += Math.max(0, answer.time - event.time);
        }
        if (event.kind === "interrupt") {
          deviate("you", "stopped", event.time, turn.prompt?.text);
          add(
            "stopped",
            segmentStart,
            event.time,
            `Stopped during: ${turn.prompt?.text ?? "work the agent began itself"}`,
          );
          segmentStart = event.time;
        }
        if (event.kind === "interjection") {
          if (isCorrection(event.text)) {
            add("corrected", segmentStart, event.time, event.text);
            deviate("assumption", "corrected", event.time, event.text);
          } else if (isAddition(event.text))
            deviate("you", "scope-added", event.time, event.text);
          if (correctsClaim(event.text))
            note(signals.get("claim-corrected"), event.time, event.text);
          segmentStart = event.time;
        }
        if (event.kind === "compaction") {
          compactions += 1;
          if (event.durationMs)
            add(
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
          if (result?.isError) {
            const reason = GATE.test(result.text) ? "refused" : "failed";
            add(
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
                "assumption",
                assumption.kind,
                event.time,
                `${event.tool}: ${line}`,
              );
              assumed = true;
              break;
            }
            // A failure that wasn't a wrong assumption: the session's rules
            // (the gate), or the tools and environment.
            if (result.isError && !assumed)
              deviate(
                GATE.test(result.text) ? "instructions" : "blocked",
                GATE.test(result.text) ? "refused" : "failed",
                event.time,
                `${event.tool}: ${example(result.text)}`,
              );
            const key = `${event.tool}\u0000${event.argsKey}`;
            // Each turn declares its topic again, as the gate asks.
            if (
              event.argsKey &&
              seen.has(key) &&
              !result.isError &&
              event.tool !== TOPIC_TOOL
            )
              add(
                "repeated",
                event.time,
                result.time,
                `${event.tool}${event.target ? ` ${event.target}` : ""}`,
              );
            if (!result.isError && event.argsKey) seen.set(key, event);
          }
          // After a change, the same call again is new work.
          if (WRITING.test(event.tool)) seen.clear();
        }
      }
      // Your next message corrects this turn's work, or adds to its scope.
      if (next?.prompt && isCorrection(next.prompt.text)) {
        add("corrected", segmentStart, turn.end, next.prompt.text);
        deviate("assumption", "corrected", next.start, next.prompt.text);
      } else if (next?.prompt && isAddition(next.prompt.text))
        deviate("you", "scope-added", next.start, next.prompt.text);
      if (next?.prompt && correctsClaim(next.prompt.text))
        note(signals.get("claim-corrected"), next.start, next.prompt.text);
      const worked = Math.max(0, span - asked);
      working += worked;
      asking += asked;
      if (topic)
        for (const key of keysOf(topic, phase)) {
          const entry = topicTime.get(key) ?? { working: 0, wasted: 0 };
          entry.working += worked;
          topicTime.set(key, entry);
        }
    }
  }

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
    method: {
      tokens:
        "The agent's own per-call counts, as each call finishes; context is what the last call read, against the prompt window it was allowed where the agent records it. Credits are what the agent's service billed each call, the figure the agent shows itself. A Copilot CLI session old enough to have recorded no calls one by one counts from its totals at shutdown instead, and its premium requests come as it goes.",
      time: "Working is each turn from your message to the agent's last event (to now while it runs), less time it waited on a question to you; waiting on commands is the gap before a turn the agent began itself while a command it sent to the background ran; waiting on you is the rest.",
      waste:
        "Wasted time is work your next message corrected or you stopped, refused and failed calls up to the agent's next call, repeated identical calls, and compaction; overlapping time counts once. Output tokens in wasted time are measured; context tokens are estimated at 4 characters a token from what the calls returned.",
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
export function topicActuals({ conversations, now }) {
  const { topicTime, topicCalls, deviations } = sessionUsage({
    conversations,
    since: -Infinity,
    now,
    topics: undefined,
  });
  return { topicTime, topicCalls, deviations };
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
