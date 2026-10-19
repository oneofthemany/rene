// Agent conversations: what was asked, what the agent said and reasoned, and
// which tool calls it made, kept per project next to the call history.
//
// Claude Code writes every conversation run in a folder to
// <config>/projects/<folder with non-alphanumerics as "->/<id>.jsonl, one
// timestamped record per line. A resumed conversation keeps its own file, and
// /clear starts a new one, so the bridge follows the whole folder: every
// transcript that changes while the project is in use is copied into the
// project's store as events (prompts, reasoning, replies, tool uses and tool
// results), keyed by its id, with a cursor so following resumes after a
// restart and nothing is read twice.
//
// A tool use in the transcript is tied to the call the relay recorded by its
// timestamp and identity, not by similarity: the same tool with identical
// arguments, recorded just after the tool use (the closest such call, within
// a short window). That gives each recorded call its audit trail:
// why it was made (the request and the agent's reasoning and replies before
// it), what it produced (the recorded result and the result the agent saw),
// and what came of it (what the agent said and did next).

import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSION = /^[\w-]{1,120}$/;
const MAX_TEXT = 4000;
const MAX_RESULT_TEXT = 2000;
const FOLLOW_MS = 2000;
// rene's tools as Claude Code names them.
const REA_TOOL = /^mcp__rea__(.+)$/;

const clip = (text, limit = MAX_TEXT) =>
  text.length > limit
    ? `${text.slice(0, limit)}… [${text.length - limit} more characters]`
    : text;

/** Canonical JSON, so identical arguments compare equal whatever their key order. */
export const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);

/** Text a person typed, not a command echo or a harness reminder. */
const isPrompt = (text) =>
  text.trim() !== "" &&
  !/^\s*<(?:local-command|command-|system-reminder|bash-|task-notification)/u.test(
    text,
  );

const blockText = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) => (part?.type === "text" ? part.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";

/** Events from one Claude Code transcript record. Unknown records give none. */
export function eventsFromRecord(record) {
  const at = record?.timestamp;
  const sidechain = record?.isSidechain === true;
  const content = record?.message?.content;
  const events = [];
  if (record?.type === "user" && record.isMeta !== true) {
    if (typeof content === "string") {
      if (isPrompt(content))
        events.push({ kind: "prompt", at, text: clip(content), sidechain });
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === "tool_result")
          events.push({
            kind: "tool_result",
            at,
            toolUseId: part.tool_use_id,
            isError: part.is_error === true,
            text: clip(blockText(part.content), MAX_RESULT_TEXT),
            sidechain,
          });
        else if (part?.type === "text" && isPrompt(part.text))
          events.push({ kind: "prompt", at, text: clip(part.text), sidechain });
      }
    }
  } else if (record?.type === "assistant" && Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "thinking" && part.thinking)
        events.push({
          kind: "reasoning",
          at,
          text: clip(part.thinking),
          sidechain,
        });
      else if (part?.type === "text" && part.text?.trim())
        events.push({ kind: "reply", at, text: clip(part.text), sidechain });
      else if (part?.type === "tool_use") {
        const rea = REA_TOOL.exec(part.name ?? "");
        events.push({
          kind: "tool_use",
          at,
          toolUseId: part.id,
          tool: rea ? rea[1] : part.name,
          rea: rea !== null,
          args: rea ? (part.input ?? {}) : undefined,
          sidechain,
        });
      }
    }
  }
  return events;
}

/** Where Claude Code keeps transcripts (CLAUDE_CONFIG_DIR, else ~/.claude). */
const claudeProjects = (env) =>
  join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");

/**
 * One project's conversation store: <dir>/<session>.jsonl holds events,
 * <session>.json the session's agent, transcript and cursor.
 */
export function createConversationStore(directory) {
  const ready = mkdir(directory, { recursive: true, mode: 0o700 });
  const metaPath = (session) => join(directory, `${session}.json`);
  const eventsPath = (session) => join(directory, `${session}.jsonl`);

  async function writeMeta(meta) {
    await ready;
    await writeFile(`${metaPath(meta.session)}.tmp`, JSON.stringify(meta), {
      mode: 0o600,
    });
    await rename(`${metaPath(meta.session)}.tmp`, metaPath(meta.session));
  }

  return {
    writeMeta,
    async meta(session) {
      if (!SESSION.test(session)) return undefined;
      return readFile(metaPath(session), "utf8").then(
        JSON.parse,
        () => undefined,
      );
    },
    async sessions() {
      await ready;
      const names = (await readdir(directory)).filter((name) =>
        name.endsWith(".json"),
      );
      const metas = await Promise.all(
        names.map((name) =>
          readFile(join(directory, name), "utf8").then(
            JSON.parse,
            () => undefined,
          ),
        ),
      );
      return metas.filter(Boolean).sort((a, b) => a.startedAt - b.startedAt);
    },
    async append(session, events) {
      if (events.length === 0) return;
      await ready;
      const handle = await open(eventsPath(session), "a", 0o600);
      try {
        await handle.write(
          events.map((event) => `${JSON.stringify(event)}\n`).join(""),
        );
      } finally {
        await handle.close();
      }
    },
    async events(session) {
      if (!SESSION.test(session)) return [];
      const text = await readFile(eventsPath(session), "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
    },
  };
}

/**
 * The folder where Claude Code keeps the transcripts of conversations run in
 * `cwd`: its path with every character other than a letter or digit turned
 * into "-" (/home/a/my.repo -> -home-a-my-repo).
 */
export const claudeTranscriptFolder = (env, cwd) =>
  join(claudeProjects(env), cwd.replace(/[^A-Za-z0-9]/g, "-"));

const TRANSCRIPT = /^([\w-]{1,120})\.jsonl$/;
// Read in slices, so a long transcript (tens of MB) never sits in one buffer.
const READ_SLICE = 8 * 1024 * 1024;

/** Reads of one transcript run one at a time, whichever follower asks. */
const ingesting = new Map();

/**
 * Copies what a transcript gained since its cursor into the store. Reads only
 * complete lines; a partial last line waits for the next read. The cursor is
 * read again inside the per-transcript queue, so two followers never copy the
 * same lines. Returns the number of events added.
 */
function ingestTranscript(store, id) {
  const previous = ingesting.get(id) ?? Promise.resolve(0);
  const next = previous
    .catch(() => 0)
    .then(async () => {
      const meta = await store.meta(id);
      return meta?.transcript ? ingestFrom(store, meta) : 0;
    });
  ingesting.set(id, next);
  void next.finally(() => {
    if (ingesting.get(id) === next) ingesting.delete(id);
  });
  return next;
}

async function ingestFrom(store, meta) {
  let handle;
  try {
    handle = await open(meta.transcript, "r");
  } catch {
    return 0;
  }
  let added = 0;
  try {
    const { size } = await handle.stat();
    let offset = meta.offset ?? 0;
    while (offset < size) {
      const length = Math.min(READ_SLICE, size - offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      const end = buffer.lastIndexOf(0x0a);
      // A single line longer than a slice: wait until a newline arrives.
      if (end === -1) break;
      const events = [];
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        try {
          events.push(...eventsFromRecord(JSON.parse(line)));
        } catch {
          // A line that isn't JSON carries nothing we keep.
        }
      }
      await store.append(meta.session, events);
      offset += end + 1;
      added += events.length;
      await store.writeMeta({ ...meta, offset });
    }
  } finally {
    await handle.close();
  }
  return added;
}

/**
 * Follows every Claude Code transcript in a project's transcript folder that
 * changed at or after `since`, until stopped. Each transcript is one
 * conversation, stored under its own id with its own cursor, so a resumed
 * conversation, a /clear or a new conversation in the same agent session are
 * all kept. Calls onEvents after new events land.
 */
export function followTranscriptFolder({
  store,
  folder,
  since,
  agent,
  onEvents,
}) {
  let stopped = false;
  let reading = Promise.resolve();
  const readOnce = () =>
    (reading = reading
      .then(async () => {
        let names;
        try {
          names = await readdir(folder);
        } catch {
          return;
        }
        let added = 0;
        for (const name of names) {
          const id = TRANSCRIPT.exec(name)?.[1];
          if (!id) continue;
          const transcript = join(folder, name);
          const known = await store.meta(id);
          if (!known) {
            const info = await stat(transcript).catch(() => undefined);
            if (!info || info.mtimeMs < since) continue;
          }
          const meta = known ?? {
            session: id,
            conversationId: id,
            agent,
            transcript,
            startedAt: Date.now(),
            offset: 0,
          };
          if (!known) await store.writeMeta(meta);
          added += await ingestTranscript(store, id);
        }
        if (added) onEvents?.();
      })
      .catch((cause) =>
        process.stderr.write(
          `Could not read a conversation: ${cause.message}\n`,
        ),
      ));
  const timer = setInterval(() => {
    if (!stopped) void readOnce();
  }, FOLLOW_MS);
  timer.unref();
  void readOnce();
  return {
    /** Stops following after one last read, so the end of a conversation is kept. */
    async stop() {
      stopped = true;
      clearInterval(timer);
      await readOnce();
    },
  };
}

// A recorded call starts when its request reaches the relay: just after the
// transcript's tool_use, give or take clock and queueing delays.
const LINK_BEFORE_MS = 10_000;
const LINK_AFTER_MS = 5 * 60_000;

/**
 * Splits a transcript's events into turns (a prompt and what followed it)
 * and ties each rea tool use to the call the relay recorded, by its
 * timestamp: the same tool with identical arguments, started within
 * LINK_BEFORE_MS before to LINK_AFTER_MS after the tool use, the closest one
 * not already taken. A transcript can span several workbench sessions (a
 * resumed conversation), so the workbench session id isn't part of the match.
 */
export function conversationTurns(meta, events, history) {
  const recorded = history.filter((entry) => entry.source === "agent");
  const used = new Set();
  const callFor = (event) => {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) return undefined;
    const key = canonical(event.args);
    let best;
    for (const entry of recorded) {
      if (used.has(entry.id) || entry.name !== event.tool) continue;
      const gap = entry.startedAt - at;
      if (gap < -LINK_BEFORE_MS || gap > LINK_AFTER_MS) continue;
      if (canonical(entry.args) !== key) continue;
      if (!best || Math.abs(gap) < Math.abs(best.startedAt - at)) best = entry;
    }
    if (best) used.add(best.id);
    return best;
  };
  const turns = [];
  let turn;
  for (const event of events) {
    if (event.sidechain) continue;
    if (event.kind === "prompt" || !turn) {
      turn = {
        session: meta.session,
        agent: meta.agent,
        index: turns.length,
        at: event.at,
        prompt: event.kind === "prompt" ? event.text : null,
        events: [],
      };
      turns.push(turn);
      if (event.kind === "prompt") continue;
    }
    const kept = { ...event };
    if (event.kind === "tool_use" && event.rea)
      kept.historyId = callFor(event)?.id ?? null;
    turn.events.push(kept);
  }
  return turns;
}

/**
 * The audit trail of one recorded call, from the turns of its session:
 * the request, the reasoning and replies before the call, the result the
 * agent saw, and what it said and did after, up to its next rene call.
 */
export function auditFor(historyId, turns) {
  for (const turn of turns) {
    const index = turn.events.findIndex(
      (event) => event.historyId === historyId,
    );
    if (index === -1) continue;
    const use = turn.events[index];
    const before = [];
    for (
      let i = index - 1;
      i >= 0 && turn.events[i].kind !== "tool_result";
      i--
    )
      if (
        turn.events[i].kind === "reasoning" ||
        turn.events[i].kind === "reply"
      )
        before.unshift(turn.events[i]);
    const result = turn.events.find(
      (event, i) =>
        i > index &&
        event.kind === "tool_result" &&
        event.toolUseId === use.toolUseId,
    );
    // What followed, up to the next rene call: reasoning, replies and the
    // other tools the agent used (files, shell, ...), by name.
    const after = [];
    const resultIndex = result ? turn.events.indexOf(result) : index;
    for (let i = resultIndex + 1; i < turn.events.length; i++) {
      const event = turn.events[i];
      if (event.kind === "tool_use" && event.rea) break;
      if (event.kind === "reasoning" || event.kind === "reply")
        after.push(event);
      else if (event.kind === "tool_use")
        after.push({ kind: "action", at: event.at, tool: event.tool });
    }
    return {
      session: turn.session,
      agent: turn.agent,
      turn: turn.index,
      request: turn.prompt,
      why: before,
      produced: result ? { isError: result.isError, text: result.text } : null,
      outcome: after,
      matchedBy:
        "the same agent session, the same tool and identical arguments, in order",
    };
  }
  return undefined;
}
