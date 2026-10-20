import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { CodeGraphInstall } from "../../../src/codegraph/CodeGraphConfiguration.js";
import { CodeGraphSessions } from "../../../src/codegraph/CodeGraphSessions.js";

// A stand-in for `codegraph serve --mcp`: newline-delimited JSON-RPC on
// stdio. Tools: pid (its process id), slow (never answers), exit (exits
// without answering) and fail (an MCP error result).
const FAKE_SERVER = `
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.method === "initialize")
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-codegraph", version: "1" },
      });
    else if (message.method === "tools/call") {
      const name = message.params.name;
      if (name === "pid")
        reply(message.id, { content: [{ type: "text", text: String(process.pid) }] });
      else if (name === "fail")
        reply(message.id, { content: [{ type: "text", text: "bad" }], isError: true });
      else if (name === "exit") process.exit(0);
      // slow: no answer.
    } else if (message.id !== undefined) reply(message.id, {});
  }
});
process.stdin.on("end", () => process.exit(0));
`;

let folder: string;
let install: CodeGraphInstall;
let sessions: CodeGraphSessions;
const open: CodeGraphSessions[] = [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidOf = async (session: CodeGraphSessions, root = folder) =>
  Number(
    (await session.call(install, root, "pid", {}, { timeoutMs: 10_000 })).text,
  );

const make = (idleMs?: number) => {
  const created = new CodeGraphSessions(process.env, undefined, idleMs);
  open.push(created);
  return created;
};

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rea-codegraph-sessions-"));
  const cli = join(folder, "fake-codegraph.cjs");
  await writeFile(cli, FAKE_SERVER);
  install = { home: folder, cli, library: cli, version: "test" };
  sessions = make();
});

afterEach(async () => {
  await Promise.allSettled(open.splice(0).map((session) => session.close()));
  await rm(folder, { recursive: true, force: true });
});

it("keeps one server per project across calls and stops it on closeProject", async () => {
  const first = await pidOf(sessions);
  expect(await pidOf(sessions)).toBe(first);
  await sessions.closeProject(folder);
  expect(alive(first)).toBe(false);
  const next = await pidOf(sessions);
  expect(next).not.toBe(first);
});

it("replaces a warm server when another process rebuilt the index database", async () => {
  const database = join(folder, ".codegraph", "codegraph.db");
  await mkdir(join(folder, ".codegraph"));
  await writeFile(database, "first");
  const first = await pidOf(sessions);
  // A sync writes into the same file: the warm server keeps serving.
  await writeFile(database, "synced");
  expect(await pidOf(sessions)).toBe(first);
  // A build replaces the file (a new inode): the old server would read the
  // deleted index, so the next call gets a fresh one.
  await rm(database);
  await writeFile(database, "rebuilt");
  const next = await pidOf(sessions);
  expect(next).not.toBe(first);
  expect(alive(first)).toBe(false);
});

it("stops the server when a call is cancelled, and starts a fresh one for the next call", async () => {
  const first = await pidOf(sessions);
  const controller = new AbortController();
  const pending = sessions.call(
    install,
    folder,
    "slow",
    {},
    { signal: controller.signal, timeoutMs: 10_000 },
  );
  await delay(50);
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow();
  // The owned close completes before the next call starts a new server.
  const next = await pidOf(sessions);
  expect(next).not.toBe(first);
  expect(alive(first)).toBe(false);
});

it("replaces a server that exits in the middle of a call", async () => {
  const first = await pidOf(sessions);
  await expect(
    sessions.call(install, folder, "exit", {}, { timeoutMs: 10_000 }),
  ).rejects.toThrow();
  const next = await pidOf(sessions);
  expect(next).not.toBe(first);
});

it("stops an idle server after the idle time", async () => {
  const idle = make(50);
  const first = await pidOf(idle);
  await delay(400);
  expect(alive(first)).toBe(false);
  expect(await pidOf(idle)).not.toBe(first);
});

it("passes a failure reply through as an error result", async () => {
  const reply = await sessions.call(
    install,
    folder,
    "fail",
    {},
    { timeoutMs: 10_000 },
  );
  expect(reply).toEqual({ text: "bad", isError: true });
  // The server stays usable after a failure reply.
  expect(await pidOf(sessions)).toBeGreaterThan(0);
});

it("stops every server on close", async () => {
  const other = await mkdtemp(join(tmpdir(), "rea-codegraph-sessions-"));
  try {
    const first = await pidOf(sessions);
    const second = await pidOf(sessions, other);
    expect(second).not.toBe(first);
    await sessions.close();
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(false);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});
