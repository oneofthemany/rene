// Tool call lifecycle. Each call is an independent entry; any number may be
// in flight. The bridge bounds how many run at once and queues the rest.

import { api, apiJson, ndjson } from "./api.js";

let nextKey = 0;

/**
 * Starts one tool call. onUpdate(entry) fires on every state change, and
 * entry.done resolves once the call has settled.
 * outcome: "queued" | "running" | "ok" | "error"
 */
export function startCall(name, args, onUpdate) {
  const entry = {
    key: ++nextKey,
    name,
    args,
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
      body: JSON.stringify({ name: entry.name, arguments: entry.args }),
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

/** Calls the bridge stored before this page loaded, newest first. */
export async function loadStoredHistory() {
  const { entries } = await apiJson("/api/history").catch(() => ({
    entries: [],
  }));
  return entries.map((stored) => ({
    ...stored,
    key: ++nextKey,
    historyId: stored.id,
    stored: true,
  }));
}

/** Restored entries carry only a summary until one is opened. */
export async function loadStoredResult(entry) {
  if (!entry.stored || entry.result || entry.resultOmitted) return;
  if (entry.resultBytes === undefined) return;
  try {
    ({ result: entry.result } = await apiJson(
      `/api/history/${encodeURIComponent(entry.historyId)}`,
    ));
  } catch (cause) {
    entry.failure = `The stored result could not be read: ${cause.message}`;
  }
}
