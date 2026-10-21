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
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

import {
  createReportSender,
  readReportTarget,
  REPORT_DRAIN_MS,
  resultFields,
} from "../dist/toolbox/HistoryReport.js";

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

const target = readReportTarget(values.report);
if (!target.ok)
  process.stderr.write(
    `rene relay: ${target.reason}; calls won't be recorded.\n`,
  );
const reports = target.ok
  ? createReportSender(
      target.target,
      (text) => process.stderr.write(text),
      "rene relay",
    )
  : undefined;
const send = (event) => reports?.send(event);

const [command, ...args] = positionals;
const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (cause) => {
  process.stderr.write(
    `rene relay: couldn't start ${command}: ${cause.message}\n`,
  );
  process.exit(69);
});

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
  (reports?.drain(REPORT_DRAIN_MS) ?? Promise.resolve()).then(done, done);
});
