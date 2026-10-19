#!/usr/bin/env node
// MCP relay for agent sessions.
//
// An agent started from the workbench runs this instead of `rea mcp`:
//
//   node relay.mjs --report <file> -- <rea command> mcp
//
// It starts REA and passes every byte between the agent and REA unchanged,
// in both directions. Alongside, it reads the newline-delimited JSON-RPC
// messages (MCP's stdio framing) and reports each tools/call, when it starts
// and when it settles, to the workbench bridge, which records it in the
// project's history. <file> holds the bridge's URL and this session's
// reporting token (mode 0600, written by the bridge).
//
// Reporting never changes or delays the agent's traffic: a bridge that is
// down or refuses a report costs a line on stderr, and the agent carries on.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

// The bridge's history keeps results up to this size; larger ones are
// reported by size only, so a huge result never crosses the loopback twice.
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

const { values, positionals } = parseArgs({
  options: { report: { type: "string" } },
  allowPositionals: true,
});
if (!values.report || positionals.length === 0) {
  process.stderr.write(
    "Usage: relay.mjs --report <file> -- <command> [args...]\n",
  );
  process.exit(64);
}

let report;
try {
  report = JSON.parse(readFileSync(values.report, "utf8"));
} catch (cause) {
  process.stderr.write(
    `rene relay: can't read ${values.report} (${cause.message}); calls won't be recorded.\n`,
  );
}

const [command, ...args] = positionals;
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (cause) => {
  process.stderr.write(
    `rene relay: couldn't start ${command}: ${cause.message}\n`,
  );
  process.exit(69);
});

// Reports go out one at a time, so the bridge sees "started" before "settled".
let reports = Promise.resolve();
let warned = false;
function send(event) {
  if (!report) return;
  reports = reports.then(async () => {
    try {
      const response = await fetch(report.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-rea-relay-token": report.token,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`the bridge answered ${response.status}`);
    } catch (cause) {
      if (!warned)
        process.stderr.write(
          `rene relay: couldn't record a call in the workbench (${cause.message}); the agent is unaffected.\n`,
        );
      warned = true;
    }
  });
}

/** tools/call requests sent by the agent and not answered yet, by JSON-RPC id. */
const pending = new Map();
const keyOf = (id) => JSON.stringify(id);

function fromAgent(message) {
  if (message?.method === "tools/call" && message.id !== undefined) {
    const call = {
      ref: `${process.pid}:${keyOf(message.id)}:${Date.now()}`,
      name: String(message.params?.name ?? ""),
      args: message.params?.arguments ?? {},
      startedAt: Date.now(),
    };
    pending.set(keyOf(message.id), call);
    send({ type: "started", ...call });
  } else if (message?.method === "notifications/cancelled") {
    const call = pending.get(keyOf(message.params?.requestId));
    if (call) call.cancelled = true;
  }
}

function fromRea(message) {
  if (message?.id === undefined || message.method !== undefined) return;
  const call = pending.get(keyOf(message.id));
  if (!call) return;
  pending.delete(keyOf(message.id));
  const elapsedMs = Date.now() - call.startedAt;
  send(
    message.error
      ? {
          type: "settled",
          ref: call.ref,
          outcome: "error",
          cancelled: call.cancelled === true,
          failure: String(message.error.message ?? "JSON-RPC error"),
          code: message.error.code,
          elapsedMs,
        }
      : {
          type: "settled",
          ref: call.ref,
          outcome: message.result?.isError ? "error" : "ok",
          ...resultFields(message.result),
          elapsedMs,
        },
  );
}

function resultFields(result) {
  const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
  return bytes <= MAX_RESULT_BYTES
    ? { result }
    : {
        resultOmitted: true,
        resultBytes: bytes,
        untrusted: result?._meta?.provenance?.untrusted_content === true,
      };
}

/** Splits a byte stream into JSON-RPC messages; unparseable lines are skipped. */
function reader(onMessage) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const handle = (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed])
      onMessage(message);
  };
  return (chunk) => {
    buffer += decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      handle(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  };
}

const readAgent = reader(fromAgent);
const readRea = reader(fromRea);

process.stdin.on("data", (chunk) => {
  child.stdin.write(chunk);
  readAgent(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  readRea(chunk);
});
// An agent that closes our stdout first has gone; REA's writes just stop.
process.stdout.on("error", () => {});
child.stdin.on("error", () => {});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => child.kill(signal));

child.on("exit", (code, signal) => {
  // Calls REA never answered settle as failed, so history has no dangling runs.
  for (const call of pending.values())
    send({
      type: "settled",
      ref: call.ref,
      outcome: "error",
      cancelled: call.cancelled === true,
      failure: "REA exited before answering.",
      elapsedMs: Date.now() - call.startedAt,
    });
  pending.clear();
  const done = () => process.exit(code ?? (signal ? 128 : 1));
  // Outstanding reports get a moment to land; the agent doesn't wait on them.
  Promise.race([
    reports,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]).then(done, done);
});
