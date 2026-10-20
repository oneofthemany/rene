// Tool call lifecycle. Each call is an independent entry; any number may be
// in flight. The bridge bounds how many run at once and queues the rest.

import { api, apiJson, ndjson } from "./api.js";

let nextKey = 0;

/**
 * Starts one tool call, recorded in `project`'s history (undefined: none).
 * onUpdate(entry) fires on every state change, and entry.done resolves once
 * the call has settled.
 * outcome: "queued" | "running" | "ok" | "error"
 */
export function startCall(name, args, project, onUpdate) {
  const entry = {
    key: ++nextKey,
    name,
    args,
    project,
    source: "workbench",
    startedAt: Date.now(),
    outcome: "queued",
    callId: undefined,
    position: undefined,
    progress: undefined,
    cancelRequested: false,
  };
  entry.done = follow(entry, onUpdate);
  return entry;
}

export const isLive = (entry) =>
  entry.outcome === "queued" || entry.outcome === "running";

/** Requests cancellation; REA receives notifications/cancelled. */
export async function cancelCall(entry) {
  if (!isLive(entry)) return;
  entry.cancelRequested = true;
  // Before the bridge assigns an id, the accepted handler sends the cancel.
  if (entry.callId === undefined) return;
  await apiJson(`/api/calls/${entry.callId}/cancel`, { method: "POST" }).catch(
    () => {},
  );
}

async function follow(entry, onUpdate) {
  try {
    const response = await api("/api/call", {
      method: "POST",
      body: JSON.stringify({
        name: entry.name,
        arguments: entry.args,
        project: entry.project,
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed with ${response.status}.`);
    }
    for await (const event of ndjson(response.body)) {
      apply(entry, event);
      onUpdate(entry);
    }
    if (isLive(entry)) {
      entry.outcome = "error";
      entry.failure = "The bridge closed the call without a result.";
    }
  } catch (cause) {
    entry.outcome = "error";
    entry.failure = cause.message;
  } finally {
    onUpdate(entry);
  }
}

function apply(entry, event) {
  switch (event.type) {
    case "accepted":
      entry.callId = event.id;
      entry.historyId = event.historyId;
      if (entry.cancelRequested) void cancelCall(entry);
      break;
    case "queued":
      entry.position = event.position;
      break;
    case "started":
      entry.outcome = "running";
      entry.position = undefined;
      break;
    case "progress":
      entry.progress = {
        value: event.progress,
        total: event.total,
        message: event.message,
      };
      break;
    case "result":
      entry.result = event.result;
      entry.elapsedMs = event.elapsedMs;
      entry.outcome = event.result.isError ? "error" : "ok";
      break;
    case "error":
      entry.failure = event.message;
      entry.cancelled = event.cancelled;
      entry.elapsedMs = event.elapsedMs;
      entry.outcome = "error";
      break;
  }
}

/** One-line description of a live call. */
export function liveStatus(entry) {
  if (entry.cancelRequested) return "Cancelling…";
  if (entry.outcome === "queued") {
    return entry.position
      ? `Queued, ${entry.position} ahead`
      : "Waiting for the bridge…";
  }
  const progress = entry.progress;
  if (!progress) return "Running…";
  return (
    progress.message ??
    `Progress ${progress.value}${progress.total ? ` of ${progress.total}` : ""}`
  );
}

const historyPath = (project, id = "") =>
  `/api/history${id ? `/${encodeURIComponent(id)}` : ""}${project ? `?project=${project}` : ""}`;

/**
 * A call the bridge reports (stored, or an agent's call in progress) as a
 * page entry. Its result is loaded when it is opened.
 */
export const fromBridge = (summary, project) => ({
  ...summary,
  key: ++nextKey,
  historyId: summary.id,
  project,
  stored: true,
});

/** Stored calls per History page. */
const HISTORY_PAGE = 200;

/**
 * One page of the project's history, newest first: stored calls (older than
 * the entry id `before` when given), agent calls in progress on the newest
 * page, and the conversation turns in the same span of time. `until` is the
 * start of the page already shown, so its turns aren't repeated. Returns the
 * entries, whether older calls remain, and where the next page starts.
 */
export async function loadStoredHistory(project, { before, until } = {}) {
  const query = new URLSearchParams({ limit: String(HISTORY_PAGE) });
  if (project) query.set("project", project);
  if (before) query.set("before", before);
  const [{ entries = [], live = [], more = false }, turns] = await Promise.all([
    apiJson(`/api/history?${query}`).catch(() => ({ entries: [] })),
    loadTurns(project),
  ]);
  // While older calls remain, the page spans its oldest call onwards; turns
  // before that come with the page that holds their calls.
  const from = more ? entries.at(-1).startedAt : -Infinity;
  const inSpan = (turn) =>
    turn.startedAt >= from && (until === undefined || turn.startedAt < until);
  return {
    entries: [
      ...[...live, ...entries].map((summary) => fromBridge(summary, project)),
      ...turns.filter(inSpan),
    ].sort((a, b) => b.startedAt - a.startedAt),
    more,
    next: more ? { before: entries.at(-1).id, until: from } : undefined,
  };
}

/**
 * The project's agent conversation turns as History entries: what was asked,
 * the rene calls that followed and what the agent concluded.
 */
export async function loadTurns(project) {
  if (!project) return [];
  const { turns = [] } = await apiJson(
    `/api/projects/${project}/conversations`,
  ).catch(() => ({}));
  return turns.map((turn) => ({
    kind: "turn",
    key: ++nextKey,
    historyId: `turn:${turn.session}:${turn.index}`,
    name: "conversation",
    startedAt: Date.parse(turn.at) || 0,
    outcome: "ok",
    source: "agent",
    agent: turn.agent,
    project,
    stored: true,
    turn,
  }));
}

/** The project's threads, topics and the turns and calls under them. */
export const loadTopics = (project) =>
  apiJson(`/api/projects/${project}/topics`);

/** One whole turn: every prompt, reasoning, reply, tool use and result. */
export const loadTurn = (entry) =>
  apiJson(
    `/api/projects/${entry.project}/conversations/${encodeURIComponent(entry.turn.session)}/${entry.turn.index}`,
  ).then(({ turn }) => turn);

/** Why an agent's call was made, what it produced, and what followed. */
export const loadAudit = (entry) =>
  apiJson(
    `/api/history/${encodeURIComponent(entry.historyId)}/audit?project=${entry.project}`,
  ).then(({ audit }) => audit);

/** Removes the project's stored calls for good. */
export const clearStoredHistory = (project) =>
  apiJson(historyPath(project), { method: "DELETE" });

/** Restored entries carry only a summary until one is opened. */
export async function loadStoredResult(entry) {
  if (!entry.stored || entry.result || entry.resultOmitted) return;
  if (entry.resultBytes === undefined) return;
  try {
    ({ result: entry.result } = await apiJson(
      historyPath(entry.project, entry.historyId),
    ));
  } catch (cause) {
    entry.failure = `The stored result could not be read: ${cause.message}`;
  }
}
