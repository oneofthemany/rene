#!/usr/bin/env node
// Local web bridge for REA's MCP server.
//
// The bridge owns one `rea mcp` child over stdio and exposes a loopback-only
// HTTP API to the browser UI in ./public. It forwards MCP requests unchanged:
// REA keeps ownership of validation, sessions, Evidence, and cleanup.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(here, "public");

const { values: options } = parseArgs({
  options: {
    port: { type: "string", default: "4417" },
    rea: { type: "string", default: resolve(here, "../scripts/rea.mjs") },
    "timeout-ms": { type: "string", default: String(10 * 60_000) },
    "max-concurrent": { type: "string", default: "4" },
    open: { type: "boolean", default: false },
  },
});

const port = Number.parseInt(options.port, 10);
const requestTimeoutMs = Number.parseInt(options["timeout-ms"], 10);
const maxConcurrent = Number.parseInt(options["max-concurrent"], 10);
if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
  throw new Error("--max-concurrent must be a positive integer.");
}
const token = randomBytes(24).toString("base64url");
const tokenBytes = Buffer.from(token);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;

const MODULES = [
  "api.js",
  "app.js",
  "calls.js",
  "catalog.js",
  "form.js",
  "markdown.js",
  "render.js",
  "results.js",
  "workflows.js",
];
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ...MODULES.map((file) => [
    `/${file}`,
    { file, type: "text/javascript; charset=utf-8" },
  ]),
]);

// ---------------------------------------------------------------------------
// MCP connection owner

/** @type {{ state: "starting" | "ready" | "failed" | "stopped", client?: Client, transport?: StdioClientTransport, tools: any[], prompts: any[], serverVersion?: unknown, failure?: string, stderr: Buffer, startedAt?: number }} */
let mcp = { state: "stopped", tools: [], prompts: [], stderr: Buffer.alloc(0) };
/** In-flight tool calls keyed by bridge call id. */
const calls = new Map();
let nextCallId = 1;

// Bounds concurrent tools/call requests to REA; later calls wait in order.
let runningCalls = 0;
/** @type {{ id: number, resolve(): void, onQueued(position: number): void }[]} */
const waiting = [];

/** Waits for a call slot. Rejects if the call is cancelled while queued. */
function acquireSlot(id, signal, onQueued) {
  if (runningCalls < maxConcurrent) {
    runningCalls++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { id, resolve, onQueued };
    waiting.push(waiter);
    onQueued(waiting.length);
    signal.addEventListener(
      "abort",
      () => {
        const index = waiting.indexOf(waiter);
        if (index === -1) return;
        waiting.splice(index, 1);
        announcePositions();
        reject(new Error("Cancelled while queued."));
      },
      { once: true },
    );
  });
}

/** Hands the slot to the next waiter, or frees it. */
function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    next.resolve();
    announcePositions();
  } else {
    runningCalls--;
  }
}

function announcePositions() {
  waiting.forEach((waiter, index) => waiter.onQueued(index + 1));
}
let starting;

async function startMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [options.rea, "mcp"],
    // REA reads provider configuration (REA_*, GHIDRA_*, PATH, ...) from its
    // environment, so the child gets the bridge's environment as launched.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-frontend", version: "0.1.0" });
  const record = {
    state: "starting",
    client,
    transport,
    tools: [],
    prompts: [],
    stderr: Buffer.alloc(0),
    startedAt: Date.now(),
  };
  mcp = record;
  transport.stderr?.on("data", (chunk) => {
    const combined = Buffer.concat([record.stderr, chunk]);
    record.stderr = combined.subarray(
      Math.max(0, combined.length - STDERR_TAIL_BYTES),
    );
  });
  transport.onclose = () => {
    if (record.state === "ready" || record.state === "starting") {
      record.state = "failed";
      record.failure = "The REA MCP server exited.";
    }
  };
  try {
    await client.connect(transport, { timeout: 60_000 });
    const [{ tools }, prompts] = await Promise.all([
      client.listTools(undefined, { timeout: 60_000 }),
      client.getServerCapabilities()?.prompts
        ? client
            .listPrompts(undefined, { timeout: 60_000 })
            .then((listing) => listing.prompts)
        : [],
    ]);
    record.tools = tools;
    record.prompts = prompts;
    record.serverVersion = client.getServerVersion();
    record.state = "ready";
  } catch (cause) {
    record.state = "failed";
    record.failure = describeError(cause);
  }
}

async function stopMcp() {
  for (const call of calls.values()) call.controller.abort();
  const { client } = mcp;
  mcp.state = "stopped";
  // Closing the client closes stdio; REA owns its own provider cleanup.
  await client?.close().catch(() => {});
}

function ensureMcp() {
  if (mcp.state === "stopped" && starting === undefined) {
    starting = startMcp().finally(() => (starting = undefined));
  }
  return starting ?? Promise.resolve();
}

// ---------------------------------------------------------------------------
// HTTP boundary

const server = createServer((request, response) => {
  handle(request, response).catch((cause) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: describeError(cause) });
    } else {
      response.destroy();
    }
  });
});

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  // Reject DNS-rebinding requests whose Host is not our loopback listener.
  const allowedHosts = new Set([
    `127.0.0.1:${boundPort}`,
    `localhost:${boundPort}`,
  ]);
  if (!allowedHosts.has(request.headers.host ?? "")) {
    return sendJson(response, 421, { error: "Unexpected Host header." });
  }

  const staticFile = STATIC_FILES.get(url.pathname);
  if (request.method === "GET" && staticFile) {
    const body = await readFile(join(publicRoot, staticFile.file));
    response.writeHead(200, {
      "content-type": staticFile.type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    return response.end(body);
  }

  if (!url.pathname.startsWith("/api/")) {
    return sendJson(response, 404, { error: "Not found." });
  }
  const origin = request.headers.origin;
  if (
    origin !== undefined &&
    !allowedHosts.has(origin.replace(/^http:\/\//, ""))
  ) {
    return sendJson(response, 403, { error: "Cross-origin request rejected." });
  }
  if (!authorized(request)) {
    return sendJson(response, 401, { error: "Missing or invalid token." });
  }

  return routeApi(request, response, url);
}

/** Authorized API routes. */
async function routeApi(request, response, url) {
  const route = `${request.method} ${url.pathname}`;
  if (route === "GET /api/status") return sendJson(response, 200, status());
  if (route === "POST /api/restart") {
    await stopMcp();
    await ensureMcp();
    return sendJson(response, 200, status());
  }

  await ensureMcp();
  if (route === "GET /api/tools") {
    return sendJson(response, 200, {
      tools: mcp.tools.map(({ name, title, description, annotations }) => ({
        name,
        title,
        description,
        annotations,
      })),
    });
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/tools/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/tools/".length));
    const tool = mcp.tools.find((candidate) => candidate.name === name);
    if (!tool)
      return sendJson(response, 404, { error: `Unknown tool ${name}.` });
    const { outputSchema: _outputSchema, ...rest } = tool;
    return sendJson(response, 200, rest);
  }
  if (route === "GET /api/prompts") {
    return sendJson(response, 200, { prompts: mcp.prompts });
  }
  if (route === "POST /api/call") return callTool(request, response);
  if (route === "POST /api/prompts/get") return getPrompt(request, response);
  if (route === "POST /api/complete") return complete(request, response);
  const cancel = /^\/api\/calls\/(\d+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel) {
    const call = calls.get(Number(cancel[1]));
    call?.controller.abort();
    return sendJson(response, 200, { cancelled: call !== undefined });
  }
  return sendJson(response, 404, { error: "Not found." });
}

/** Streams one tools/call as NDJSON: started, progress*, then result or error. */
async function callTool(request, response) {
  const body = await readJsonBody(request);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.name !== "string" ||
    (body.arguments !== undefined &&
      (typeof body.arguments !== "object" ||
        body.arguments === null ||
        Array.isArray(body.arguments)))
  ) {
    return sendJson(response, 400, {
      error: "Expected { name: string, arguments?: object }.",
    });
  }
  if (mcp.state !== "ready" || !mcp.client) {
    return sendJson(response, 503, {
      error: mcp.failure ?? "The REA MCP server is not ready.",
    });
  }

  const id = nextCallId++;
  const controller = new AbortController();
  const call = {
    controller,
    name: body.name,
    acceptedAt: Date.now(),
    state: "queued",
  };
  calls.set(id, call);
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const write = (event) => response.write(`${JSON.stringify(event)}\n`);
  // A closed browser request cancels its call; REA receives notifications/cancelled.
  response.on("close", () => {
    if (!response.writableFinished) controller.abort();
  });

  write({ type: "accepted", id });
  let acquired = false;
  let startedAt = Date.now();
  try {
    await acquireSlot(id, controller.signal, (position) =>
      write({ type: "queued", position }),
    );
    acquired = true;
    call.state = "running";
    startedAt = Date.now();
    write({ type: "started" });
    const result = await mcp.client.callTool(
      { name: body.name, arguments: body.arguments ?? {} },
      {
        signal: controller.signal,
        timeout: requestTimeoutMs,
        resetTimeoutOnProgress: true,
        onprogress: (progress) => write({ type: "progress", ...progress }),
      },
    );
    write({ type: "result", result, elapsedMs: Date.now() - startedAt });
  } catch (cause) {
    write({
      type: "error",
      cancelled: controller.signal.aborted,
      code: cause instanceof ProtocolError ? cause.code : undefined,
      message: describeError(cause),
      elapsedMs: Date.now() - startedAt,
    });
  } finally {
    if (acquired) releaseSlot();
    calls.delete(id);
    response.end();
  }
}

/** prompts/get: REA renders the workflow brief from caller-selected arguments. */
async function getPrompt(request, response) {
  const body = await readJsonBody(request);
  if (
    typeof body?.name !== "string" ||
    (body.arguments !== undefined && !isStringRecord(body.arguments))
  ) {
    return sendJson(response, 400, {
      error: "Expected { name: string, arguments?: Record<string, string> }.",
    });
  }
  return forward(response, (client) =>
    client.getPrompt(
      { name: body.name, arguments: body.arguments ?? {} },
      { timeout: 60_000 },
    ),
  );
}

/** completion/complete for one prompt argument, with the other filled arguments as context. */
async function complete(request, response) {
  const body = await readJsonBody(request);
  if (
    typeof body?.prompt !== "string" ||
    typeof body.argument?.name !== "string" ||
    typeof body.argument?.value !== "string" ||
    (body.context !== undefined && !isStringRecord(body.context))
  ) {
    return sendJson(response, 400, {
      error:
        "Expected { prompt: string, argument: { name, value }, context?: Record<string, string> }.",
    });
  }
  if (!mcp.client?.getServerCapabilities()?.completions) {
    return sendJson(response, 200, { completion: { values: [] } });
  }
  return forward(response, (client) =>
    client.complete(
      {
        ref: { type: "ref/prompt", name: body.prompt },
        argument: { name: body.argument.name, value: body.argument.value },
        ...(body.context ? { context: { arguments: body.context } } : {}),
      },
      { timeout: 15_000 },
    ),
  );
}

/** Runs one short MCP request and returns its result or a 502 with the reason. */
async function forward(response, request) {
  if (mcp.state !== "ready" || !mcp.client) {
    return sendJson(response, 503, {
      error: mcp.failure ?? "The REA MCP server is not ready.",
    });
  }
  try {
    return sendJson(response, 200, await request(mcp.client));
  } catch (cause) {
    return sendJson(response, 502, {
      error: describeError(cause),
      code: cause instanceof ProtocolError ? cause.code : undefined,
    });
  }
}

function isStringRecord(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function status() {
  return {
    state: mcp.state,
    failure: mcp.failure,
    serverVersion: mcp.serverVersion,
    toolCount: mcp.tools.length,
    promptCount: mcp.prompts.length,
    startedAt: mcp.startedAt,
    maxConcurrent,
    activeCalls: [...calls.entries()].map(([id, call]) => ({
      id,
      name: call.name,
      state: call.state,
      acceptedAt: call.acceptedAt,
    })),
    stderrTail: mcp.stderr.toString("utf8"),
  };
}

function authorized(request) {
  const supplied = Buffer.from(String(request.headers["x-rea-token"] ?? ""));
  return (
    supplied.length === tokenBytes.length &&
    timingSafeEqual(supplied, tokenBytes)
  );
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function describeError(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Process lifetime

/** Opens the UI in the default browser; the printed URL remains the fallback. */
function openBrowser(url) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () =>
    process.stdout.write("Could not open a browser; open the URL above.\n"),
  );
  child.unref();
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await stopMcp();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  const url = `http://127.0.0.1:${boundPort}/#token=${token}`;
  process.stdout.write(`REA frontend: ${url}\n`);
  if (options.open) openBrowser(url);
  void ensureMcp().then(() => {
    process.stdout.write(
      mcp.state === "ready"
        ? `REA MCP server ready with ${mcp.tools.length} tools.\n`
        : `REA MCP server failed: ${mcp.failure}\n`,
    );
  });
});
