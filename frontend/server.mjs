#!/usr/bin/env node
// Local web bridge for REA's MCP server.
//
// The bridge owns one `rea mcp` child over stdio and exposes a loopback-only
// HTTP API to the browser UI in ./public. It forwards MCP requests unchanged:
// REA keeps ownership of validation, sessions, Evidence, and cleanup.

import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WebSocketServer } from "ws";
import { CHOICES, checkOwner, ENGINES } from "./choices.mjs";
import {
  ASSESSMENT_FILE,
  earlierCalls,
  latestCodeMap,
  MAP_TOOL,
  findLinks,
  latestSurvey,
  SURVEY_TOOL,
  issuedEvidence,
  readAssessment,
  summarize,
  writeAssessment,
} from "./assessment.mjs";
import {
  auditFor,
  conversationTurns,
  followConversations,
} from "./conversations.mjs";
import { createHistory } from "./history.mjs";
import { linkTasks, projectTasks } from "./tasks.mjs";
import { currentTopics, TOPIC_TOOL, topicTree } from "./topics.mjs";
import {
  createUsageLedger,
  readClaudePlan,
} from "../dist/toolbox/AgentAccountUsage.js";
import {
  accountUsage,
  budgetOf,
  freshContext,
  sessionUsage,
  statusReadings,
  taskProgress,
  topicActuals,
} from "./usage.mjs";
import {
  DIMENSIONS,
  MEASURES,
  parseUsageRequest,
  UsageQueryError,
  usageSlice,
  usageTurnRows,
  usageTurns,
} from "./usageView.mjs";
import {
  createProjects,
  defaultProjectsDir,
  ProjectError,
} from "./projects.mjs";
import { createInstaller, defaultProvidersDir } from "./providerInstall.mjs";
import { createSettings, SettingsError } from "./settings.mjs";
import {
  agentDirectory,
  agentInstructions,
  claudeStatusFile,
  claudeStatusHistory,
  createTerminal,
  TerminalError,
} from "./terminal.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = join(here, "public");

const { values: options } = parseArgs({
  options: {
    port: { type: "string", default: "4417" },
    rea: { type: "string", default: resolve(here, "../scripts/rea.mjs") },
    "timeout-ms": { type: "string", default: String(10 * 60_000) },
    "max-concurrent": { type: "string", default: "4" },
    open: { type: "boolean", default: false },
    // Written by start.sh before it execs this process; removed on clean exit.
    "pid-file": { type: "string" },
    "history-dir": {
      type: "string",
      default: join(here, ".workbench-history"),
    },
    "page-log": {
      type: "string",
      default: join(here, ".workbench-page.log"),
    },
    settings: {
      type: "string",
      default: join(here, ".workbench-settings.json"),
    },
    "providers-dir": { type: "string", default: defaultProvidersDir() },
    // The agent session's files (settings, the `rene` shim, the report token
    // the agent's rene reports calls with). Per bridge, like the folders above:
    // a second bridge writing the same files would redirect a running
    // session's reports to itself.
    "agent-dir": { type: "string", default: agentDirectory(here) },
    "projects-dir": { type: "string", default: defaultProjectsDir() },
  },
});

// A launcher path is made absolute once, so every consumer (the MCP child,
// rea commands, agents started in other folders) runs the same file. A bare
// command name is left for PATH lookup.
if (/[\\/]/.test(options.rea)) options.rea = resolve(options.rea);

/**
 * How to run REA: a JavaScript entrypoint (the fork's scripts/rea.mjs) with
 * this Node, anything else (the container launcher) directly.
 */
const reaCommand = (args) =>
  /\.[cm]?js$/.test(options.rea)
    ? { command: process.execPath, args: [options.rea, ...args] }
    : { command: options.rea, args };

const port = Number.parseInt(options.port, 10);
const requestTimeoutMs = Number.parseInt(options["timeout-ms"], 10);
const maxConcurrent = Number.parseInt(options["max-concurrent"], 10);
if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
  throw new Error("--max-concurrent must be a positive integer.");
}
const token = randomBytes(24).toString("base64url");
const tokenBytes = Buffer.from(token);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// A relay report carries one result, which history keeps up to 8 MiB.
const MAX_RELAY_BODY_BYTES = 12 * 1024 * 1024;
const STDERR_TAIL_BYTES = 16 * 1024;
const settings = createSettings(options.settings);
await settings.load();
const installer = createInstaller({
  root: options["providers-dir"],
  settings,
});
// History keeps every call (history.mjs); only a result above this size is
// left out, with its size recorded.
const HISTORY_LIMITS = {
  maxEntryBytes: 8 * 1024 * 1024,
};
// The most summaries one GET /api/history page returns.
const MAX_HISTORY_PAGE = 1000;
const HISTORY_ID = /^\d{13}-[0-9a-f]{8}$/;
// Calls made with no project chosen.
const history = createHistory(options["history-dir"], HISTORY_LIMITS);
const projects = createProjects(options["projects-dir"], HISTORY_LIMITS);

// Every page module in public/, read once at start: a module missing from a
// hand-kept list failed its import and stopped the whole page.
const MODULES = readdirSync(publicRoot).filter((file) => file.endsWith(".js"));
// The page's terminal (xterm.js) comes from frontend/package.json.
const vendor = (path) => join(here, "node_modules", path);
const STATIC_FILES = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
  ...MODULES.map((file) => [
    `/${file}`,
    { file, type: "text/javascript; charset=utf-8" },
  ]),
  [
    "/vendor/xterm.mjs",
    {
      path: vendor("@xterm/xterm/lib/xterm.mjs"),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/vendor/addon-fit.mjs",
    {
      path: vendor("@xterm/addon-fit/lib/addon-fit.mjs"),
      type: "text/javascript; charset=utf-8",
    },
  ],
  [
    "/vendor/xterm.css",
    {
      path: vendor("@xterm/xterm/css/xterm.css"),
      type: "text/css; charset=utf-8",
    },
  ],
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
    ...reaCommand(["mcp"]),
    // REA reads provider configuration (REA_*, GHIDRA_*, PATH, ...) from its
    // environment: the bridge's environment as launched, plus saved paths.
    // REA_WORKBENCH_MCP marks this as the page's own client: the container
    // launcher serves MCP to nothing else, agents included.
    env: { ...settings.environment(process.env), REA_WORKBENCH_MCP: "page" },
    stderr: "pipe",
  });
  // REA advertises listChanged; the SDK refetches every page and hands back
  // the new list. catalogVersion tells pages to reload their catalog.
  const onChanged = (key) => (error, items) => {
    if (error || !items || mcp !== record) return;
    record[key] = items;
    record.catalogVersion++;
    broadcast({ type: "catalog", ...catalogStamp() });
  };
  const client = new Client(
    { name: "rea-frontend", version: "0.1.0" },
    {
      listChanged: {
        tools: { onChanged: onChanged("tools") },
        prompts: { onChanged: onChanged("prompts") },
      },
    },
  );
  const record = {
    catalogVersion: 0,
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
    broadcast({ type: "catalog", ...catalogStamp() });
  } catch (cause) {
    record.state = "failed";
    record.failure = describeError(cause);
  }
}

// Pages listening for catalog changes, as open NDJSON responses.
const listeners = new Set();

const catalogStamp = () => ({
  startedAt: mcp.startedAt,
  catalogVersion: mcp.catalogVersion,
});

function broadcast(event) {
  const line = `${JSON.stringify(event)}\n`;
  for (const listener of listeners) listener.write(line);
}

/** Streams catalog events until the page goes away; starts with the current stamp. */
function events(request, response) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  listeners.add(response);
  response.on("close", () => listeners.delete(response));
  response.write(`${JSON.stringify({ type: "catalog", ...catalogStamp() })}\n`);
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
// Short-lived rea commands

/**
 * Runs one short-lived rea command whose stdout is a JSON report. A failing
 * exit still resolves when the report parses: doctor reports unhealthy checks
 * that way.
 */
function runReaJson(args, timeout) {
  const command = args[0];
  return new Promise((resolvePromise, reject) => {
    execFile(
      reaCommand(args).command,
      reaCommand(args).args,
      {
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        // Doctor checks the same settings REA runs with.
        env: settings.environment(process.env),
      },
      (error, stdout, stderr) => {
        let report;
        try {
          report = JSON.parse(stdout);
        } catch {
          return reject(
            new Error(
              `rea ${command} did not return JSON${error ? `: ${error.message}` : ""}. ${stderr.slice(-2000)}`.trim(),
            ),
          );
        }
        resolvePromise(report);
      },
    ).stdin?.end();
  });
}

// ---------------------------------------------------------------------------
// Provider readiness
//
// `rea doctor` owns the checks and their remediation. It runs in this
// bridge's environment, which the MCP child inherits, so its answer is about
// the REA the workbench is using. Concurrent requests share one run.

const DOCTOR_TIMEOUT_MS = 120_000;
let doctorRun;

async function doctor(response) {
  doctorRun ??= runReaJson(["doctor", "--format", "json"], DOCTOR_TIMEOUT_MS)
    .then((report) => ({ report, checkedAt: Date.now() }))
    .finally(() => (doctorRun = undefined));
  try {
    const { report, checkedAt } = await doctorRun;
    // Checks for providers and tools the user turned off aren't "to fix".
    const use = settings.use();
    const unused = [
      ...(report.checks ?? []),
      ...(report.informational_checks ?? []),
    ]
      .filter((check) => {
        const owner = checkOwner(check.name);
        return owner !== undefined && !use[owner.id];
      })
      .map((check) => check.name);
    const unusedChoices = Object.keys(use).filter((id) => !use[id]);
    return sendJson(response, 200, {
      report,
      checkedAt,
      unused,
      unusedChoices,
    });
  } catch (cause) {
    return sendJson(response, 502, { error: describeError(cause) });
  }
}

// ---------------------------------------------------------------------------
// Agent terminal (Claude Code, Copilot CLI, agy, Codex, ...)

const terminal = createTerminal({
  directory: options["agent-dir"],
  // Saved provider paths reach REA through the agent's environment.
  // REA_WORKBENCH_SETTINGS names this bridge's settings file to the session's
  // rene, which applies it as a hand-run rene does the checkout's own.
  environment: () => ({
    ...settings.environment(process.env),
    REA_WORKBENCH_SETTINGS: options.settings,
  }),
  // The transcript gets one last read when the agent exits.
  onExit: (session) => void stopFollowing(session),
});

/** Runs a terminal action, mapping its expected refusals to 400. */
async function terminalAction(response, work) {
  try {
    return sendJson(response, 200, (await work()) ?? terminal.describe());
  } catch (cause) {
    if (cause instanceof TerminalError)
      return sendJson(response, 400, { error: cause.message });
    throw cause;
  }
}

const TERMINAL_ROUTES = {
  "GET /api/terminal": (_request, response) =>
    sendJson(response, 200, {
      ...terminal.describe(),
      agents: terminal.agents(),
      home: homedir(),
    }),
  "GET /api/terminal/stream": (_request, response) => terminal.stream(response),
  "POST /api/terminal/start": async (request, response) => {
    const body = (await readJsonBody(request)) ?? {};
    return terminalAction(response, async () => {
      const link = await agentSession(body.cwd, body.agent ?? "claude");
      try {
        const started = await terminal.start(body, link);
        link.relay.agent = started.label;
        await startFollowing(link);
        return started;
      } catch (cause) {
        relaySessions.delete(link.relayToken);
        throw cause;
      }
    });
  },
  "POST /api/terminal/stop": (_request, response) =>
    terminalAction(response, () => ({ stopped: terminal.stop() })),
  "GET /api/terminal/usage": async (_request, response) =>
    sendJson(response, 200, await terminalUsage()),
  // Types Claude Code's own /limit-reset into its prompt, which then shows
  // the resets the account has and asks before using one. Only this command,
  // and only for a running Claude Code session.
  "POST /api/terminal/limit-reset": (_request, response) =>
    terminalAction(response, () => {
      const described = terminal.describe();
      if (!described.running || described.agent !== "claude")
        throw new TerminalError("Claude Code isn't running here.");
      terminal.input("/limit-reset\r");
      return { sent: true };
    }),
};

// ---------------------------------------------------------------------------
// Agent Terminal usage (usage.mjs owns the analysis)

/** session id -> { size, events }: a conversation's events, read again when they grow. */
const usageEvents = new Map();
/** project id -> { stamp, topics }: topics, read again when a declaration lands. */
const usageTopics = new Map();

async function cachedEvents(store, session) {
  const size = await store.size(session);
  const cached = usageEvents.get(session);
  if (cached?.size === size) return cached.events;
  const events = await store.events(session);
  usageEvents.set(session, { size, events });
  return events;
}

/** Every stored conversation of a project, with its events. */
async function projectConversations(project) {
  const all = [];
  for (const meta of await project.conversations.sessions())
    all.push({
      meta,
      events: await cachedEvents(project.conversations, meta.session),
    });
  return all;
}

async function cachedTopics(project) {
  const declarations = await project.history.list({
    name: TOPIC_TOOL,
    outcome: "ok",
  });
  const stamp = `${declarations.length}:${declarations.at(-1)?.id ?? ""}`;
  const cached = usageTopics.get(project.manifest.id);
  if (cached?.stamp === stamp) return cached.declared;
  const declared = { ...(await currentTopics(project.history)), stamp };
  usageTopics.set(project.manifest.id, { stamp, declared });
  return declared;
}

// This machine's agent transcripts over the last month and a bit, followed
// by offset (AgentAccountUsage.ts), and read again at most this often.
const ACCOUNT_HORIZON_MS = 35 * 24 * 60 * 60_000;
const ACCOUNT_REFRESH_MS = 20_000;
const usageLedger = createUsageLedger(
  settings.environment(process.env),
  ACCOUNT_HORIZON_MS,
);
let ledgerReadAt = 0;

async function accountSummary() {
  const environment = settings.environment(process.env);
  if (Date.now() - ledgerReadAt > ACCOUNT_REFRESH_MS) {
    await usageLedger.refresh();
    ledgerReadAt = Date.now();
  }
  // The live limits a Claude Code session's status line last recorded.
  const live = await readFile(claudeStatusFile(options["agent-dir"]), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  return accountUsage({
    plan: await readClaudePlan(environment).catch(() => null),
    live,
    ledger: usageLedger,
    now: Date.now(),
  });
}

/** The Agent Terminal session's usage: tokens, time, waste and progress, and the accounts'. */
async function terminalUsage() {
  const account = await accountSummary();
  const described = terminal.describe();
  if (!described.session || !described.project)
    return { available: false, account };
  const project = await projects.get(described.project).catch(() => undefined);
  if (!project) return { available: false, account };
  const now = described.endedAt ?? Date.now();
  const all = await projectConversations(project);
  const active = [];
  for (const conversation of all) {
    // The terminal session's conversations: written since it started. A
    // resumed one counts from its own start, by its id, across restarts.
    const info = await stat(conversation.meta.transcript).catch(
      () => undefined,
    );
    if (info && info.mtimeMs >= described.startedAt) active.push(conversation);
  }
  const firsts = active
    .map(({ events }) => Date.parse(events.find((event) => event.at)?.at ?? ""))
    .filter(Number.isFinite);
  const since = Math.min(described.startedAt, ...firsts);
  const { topics, declaredBy, filed, ...declared } =
    await cachedTopics(project);
  // The ledger is the usage store's (cachedActuals), not the page's.
  const { topicTime, topicCalls, ledger, ...usage } = sessionUsage({
    conversations: active,
    since,
    now,
    topics,
    declaredBy,
    filed,
    actuals: cachedActuals(project, all, now, {
      declaredBy,
      filed,
      stamp: declared.stamp,
    }),
  });
  // Each change in the live limits the status line recorded, for the pace.
  const readings = statusReadings(
    await readFile(claudeStatusHistory(options["agent-dir"]), "utf8").catch(
      () => "",
    ),
  );
  return {
    available: true,
    account,
    agent: described.label,
    agentRunning: described.running,
    ...usage,
    budget: budgetOf({
      account,
      readings,
      ledger: usageLedger,
      progress: usage.progress,
      tasks: linkTasks(
        (await projectTasks(project.manifest.path)).tasks,
        topics.values(),
      ),
      context: usage.tokens.context,
      fresh: freshContext(all),
      now: Date.now(),
    }),
  };
}

/**
 * project id -> { stamp, actuals }: every topic's use, again when a
 * conversation grows or a declaration is made (it can name earlier turns).
 */
const usageActuals = new Map();

function cachedActuals(project, conversations, now, declared) {
  const stamp = [
    declared.stamp,
    ...conversations.map(
      ({ meta, events }) => `${meta.session}:${events.length}`,
    ),
  ].join(",");
  const cached = usageActuals.get(project.manifest.id);
  if (cached?.stamp === stamp) return cached.actuals;
  const { ledger, ...actuals } = topicActuals({
    conversations,
    now,
    declaredBy: declared.declaredBy,
    filed: declared.filed,
  });
  usageActuals.set(project.manifest.id, { stamp, actuals });
  sealUsage(project, ledger);
  return actuals;
}

// The usage store is sealed again at most this often while use grows, so an
// active session isn't rewriting it on every poll.
const USAGE_SEAL_MS = 2 * 60_000;
/** project id -> when its usage store was last sealed, and the ledger waiting. */
const usageSeals = new Map();

/**
 * Seals a project's ledger into its usage store (usageStore.mjs): now, or
 * once USAGE_SEAL_MS has passed since the last seal, with the newest ledger.
 */
function sealUsage(project, ledger) {
  const id = project.manifest.id;
  const state = usageSeals.get(id) ?? { at: 0, ledger: null, timer: null };
  usageSeals.set(id, state);
  state.ledger = ledger;
  if (state.timer) return;
  const wait = state.at + USAGE_SEAL_MS - Date.now();
  if (wait <= 0) sealNow(project, state);
  else {
    state.timer = setTimeout(() => sealNow(project, state), wait);
    state.timer.unref();
  }
}

function sealNow(project, state) {
  clearTimeout(state.timer);
  state.timer = null;
  state.at = Date.now();
  const sealed = project.usage.write({
    project: project.manifest.path,
    ledger: state.ledger,
  });
  state.ledger = null;
  if (!sealed.ok)
    console.warn(
      `usage store for ${project.manifest.id} not sealed: ${sealed.reason}`,
    );
}

/**
 * A project's usage store and tasks, current: its use worked out again if
 * a conversation grew or a declaration was made, and a seal still waiting
 * on USAGE_SEAL_MS written now, for the usage view to read.
 */
async function currentUsage(project) {
  const now = Date.now();
  const { topics, declaredBy, filed, stamp } = await cachedTopics(project);
  const actuals = cachedActuals(
    project,
    await projectConversations(project),
    now,
    { declaredBy, filed, stamp },
  );
  const state = usageSeals.get(project.manifest.id);
  if (state?.timer) sealNow(project, state);
  return { topics, actuals, now };
}

// Keystrokes, mouse reports and resizes reach the agent over one WebSocket
// per page (output stays on /api/terminal/stream). A TUI with mouse tracking
// reports every mouse move, and a request apiece flooded the bridge and the
// page's network log. Messages: {"type":"input","data"} and
// {"type":"resize","cols","rows"}; a failure is answered {"type":"error"}.
const TERMINAL_SOCKET_PATH = "/api/terminal/socket";
// The page names this protocol and offers its token as the other one:
// browsers can't set headers on a WebSocket, and a URL would log the token.
const TERMINAL_PROTOCOL = "rea-terminal";
const terminalSockets = new WebSocketServer({
  noServer: true,
  // An input message is at most MAX_INPUT_CHARS characters, and JSON
  // escaping can make each control character six bytes.
  maxPayload: 6 * 64 * 1024 + 1024,
  handleProtocols: (protocols) =>
    protocols.has(TERMINAL_PROTOCOL) ? TERMINAL_PROTOCOL : false,
});

terminalSockets.on("connection", (socket) => {
  // A protocol error (an oversized frame, say) closes the socket; unhandled,
  // the event would end the bridge.
  socket.on("error", () => {});
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      message = undefined;
    }
    try {
      if (message?.type === "input") terminal.input(message.data);
      else if (message?.type === "resize")
        terminal.resize(message.cols, message.rows);
      else
        throw new TerminalError(
          'Expected {"type":"input","data"} or {"type":"resize","cols","rows"}.',
        );
    } catch (cause) {
      socket.send(
        JSON.stringify({ type: "error", error: describeError(cause) }),
      );
    }
  });
});

/** Refuses an upgrade before any WebSocket exists. */
function refuseUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
}

/**
 * Upgrades /api/terminal/socket for the page: our loopback Host, our own
 * Origin (a WebSocket isn't bound by CORS, so this keeps other sites out) and
 * the page token offered as a subprotocol.
 */
function upgradeTerminalSocket(request, socket, head) {
  // A page that goes away mid-handshake resets the connection.
  socket.on("error", () => {});
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const hosts = loopbackHosts();
  if (url.pathname !== TERMINAL_SOCKET_PATH)
    return refuseUpgrade(socket, 404, "Not Found");
  if (!hosts.has(request.headers.host ?? ""))
    return refuseUpgrade(socket, 421, "Misdirected Request");
  const origin = String(request.headers.origin ?? "");
  if (!hosts.has(origin.replace(/^http:\/\//, "")))
    return refuseUpgrade(socket, 403, "Forbidden");
  const offered = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  if (
    !offered.includes(TERMINAL_PROTOCOL) ||
    !offered.some((protocol) => isPageToken(protocol))
  )
    return refuseUpgrade(socket, 401, "Unauthorized");
  terminalSockets.handleUpgrade(request, socket, head, (ws) =>
    terminalSockets.emit("connection", ws, request),
  );
}

// Readiness and provider paths work while the MCP child is down.
// ---------------------------------------------------------------------------
// Agent skill
//
// `rene skill` owns the reverse-engineer-anything skill: where each agent
// reads skills, what is installed and whether it is current, and the atomic
// install with backups. The bridge runs it as a short-lived child, one
// install at a time, and never writes an agent's skill folder itself.

const SKILL_TIMEOUT_MS = 60_000;
const SKILL_FOLDER = /^[a-z][a-z0-9_]{0,40}$/;
let skillInstalling = false;

async function skillStatus(response) {
  try {
    return sendJson(
      response,
      200,
      await runReaJson(["skill", "status"], SKILL_TIMEOUT_MS),
    );
  } catch (cause) {
    return sendJson(response, 502, { error: describeError(cause) });
  }
}

/** Installs or updates the skill, adding the folders named in { clients }. */
async function skillInstall(request, response) {
  const clients = (await readJsonBody(request))?.clients ?? [];
  if (
    !Array.isArray(clients) ||
    clients.length > 40 ||
    !clients.every(
      (client) => typeof client === "string" && SKILL_FOLDER.test(client),
    )
  )
    return sendJson(response, 400, {
      error: "Expected { clients: string[] } of skill folder ids.",
    });
  if (skillInstalling)
    return sendJson(response, 409, {
      error: "The skill is already being installed.",
    });
  skillInstalling = true;
  try {
    const args = clients.flatMap((client) => ["--client", client]);
    return sendJson(
      response,
      200,
      await runReaJson(["skill", "install", ...args], SKILL_TIMEOUT_MS),
    );
  } catch (cause) {
    return sendJson(response, 502, { error: describeError(cause) });
  } finally {
    skillInstalling = false;
  }
}

const PROVIDER_ROUTES = {
  "GET /api/doctor": (_request, response) => doctor(response),
  "GET /api/skill": (_request, response) => skillStatus(response),
  "POST /api/skill/install": skillInstall,

  ...TERMINAL_ROUTES,
  "GET /api/choices": (_request, response) =>
    sendJson(response, 200, describeChoices()),
  "POST /api/choices": saveChoices,
  "GET /api/settings": (_request, response) =>
    sendJson(response, 200, settings.describe(process.env)),
  "POST /api/settings": saveSettings,
  "GET /api/install": async (_request, response) =>
    sendJson(response, 200, {
      ...(await installer.plan()),
      // Package installs on rpm-ostree systems need a layer and a reboot.
      imageBased: existsSync("/run/ostree-booted"),
    }),
  "POST /api/install": installProviders,
  "GET /api/install/updates": async (_request, response) =>
    sendJson(response, 200, await availableUpdates()),
  "POST /api/install/update": updateProviders,
  "GET /api/container": async (_request, response) =>
    sendJson(response, 200, await containerStatus()),
  "POST /api/install/cancel": (_request, response) =>
    sendJson(response, 200, { cancelled: installer.cancel() }),
};

/** The REA container's image and container state, from container.sh. */
async function containerStatus() {
  const script = join(here, "container", "container.sh");
  const ask = (command) =>
    new Promise((resolvePromise) =>
      execFile(script, [command], { timeout: 30_000 }, (error, stdout) =>
        resolvePromise(error ? "unknown" : stdout.trim()),
      ),
    );
  const status = await ask("status");
  return {
    image: await ask("image-state"),
    container: /container \S+: (\S+)/.exec(status)?.[1] ?? "unknown",
  };
}

/**
 * Downloads the chosen providers, saves their paths and restarts REA, as
 * NDJSON progress. Closing the page doesn't stop the install; cancel does.
 */
async function installProviders(request, response) {
  const ids = await readIds(request, response);
  if (ids)
    await streamInstall(response, (onEvent) =>
      installer.install(ids, { onEvent }),
    );
}

/** Updates for providers this workbench installed and REA uses. */
async function availableUpdates() {
  const { components } = await installer.plan();
  const ours = new Set(
    components.filter((c) => c.state === "ready" && c.used).map((c) => c.id),
  );
  const { updates, unchecked } = await installer.checkUpdates();
  return {
    updates: updates.filter((update) => ours.has(update.id)),
    unchecked,
  };
}

/**
 * Installs chosen updates. The release details come from a fresh check here,
 * never from the request, so the page can only pick which updates to take.
 */
async function updateProviders(request, response) {
  const ids = await readIds(request, response);
  if (!ids) return;
  const { updates } = await availableUpdates();
  const chosen = updates.filter((update) => ids.includes(update.id));
  if (chosen.length === 0)
    return sendJson(response, 409, {
      error: "Those updates are no longer available. Check again.",
    });
  await streamInstall(response, (onEvent) =>
    installer.applyUpdates(chosen, { onEvent }),
  );
}

async function readIds(request, response) {
  const ids = (await readJsonBody(request))?.ids;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !ids.every((id) => typeof id === "string")
  ) {
    sendJson(response, 400, { error: "Expected { ids: string[] }." });
    return undefined;
  }
  if (installer.running) {
    sendJson(response, 409, { error: "An install is already running." });
    return undefined;
  }
  return ids;
}

/** Streams an install as NDJSON, then restarts REA if any path changed. */
async function streamInstall(response, start) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
  });
  const write = (event) => {
    if (!response.destroyed) response.write(`${JSON.stringify(event)}\n`);
  };
  try {
    const result = await start(write);
    if (result.changed) {
      write({ type: "restarting" });
      await stopMcp();
      await ensureMcp();
    }
  } catch (cause) {
    write({ type: "error", error: describeError(cause) });
  }
  response.end();
}

const ENGINE_SETTING = "REA_ANALYSIS_PROVIDER";

function describeChoices() {
  const engine = settings
    .describe(process.env)
    .settings.find((setting) => setting.name === ENGINE_SETTING);
  return {
    choices: CHOICES.map(({ id, group, label, purpose, engine: isEngine }) => ({
      id,
      group,
      label,
      purpose,
      engine: Boolean(isEngine),
    })),
    use: settings.use(),
    engine: engine.effective || "auto",
    engineSource: engine.saved ? "saved" : engine.shell ? "shell" : "default",
  };
}

/**
 * Saves the "What you use" switches and the default engine. The engine is
 * part of REA's environment, so changing it restarts REA.
 */
async function saveChoices(request, response) {
  const body = await readJsonBody(request);
  const use = { ...settings.use(), ...body?.use };
  const engine = body?.engine;
  if (typeof engine !== "string" || !ENGINES.includes(engine))
    return sendJson(response, 400, {
      error: `Choose a default engine: ${ENGINES.join(", ")}.`,
    });
  if (engine !== "auto" && use[engine] !== true)
    return sendJson(response, 400, {
      error: `Turn ${engine} on before making it the default engine.`,
    });
  await settings.saveUse(body?.use ?? {});
  const restart = await settings.save({ [ENGINE_SETTING]: engine });
  if (restart) {
    await stopMcp();
    await ensureMcp();
  }
  return sendJson(response, 200, { restarted: restart, ...describeChoices() });
}

/** Saves provider paths, then restarts REA so it runs with them. */
async function saveSettings(request, response) {
  const body = await readJsonBody(request);
  let changed;
  try {
    changed = await settings.save(body?.values);
  } catch (cause) {
    if (cause instanceof SettingsError)
      return sendJson(response, 400, { error: cause.message });
    throw cause;
  }
  if (changed) {
    await stopMcp();
    await ensureMcp();
  }
  return sendJson(response, 200, {
    changed,
    ...settings.describe(process.env),
  });
}

// ---------------------------------------------------------------------------
// Path picker
//
// A browser file input never reveals a real path, and REA needs absolute
// host paths, so the page asks the bridge for directory listings. Only names
// and entry types leave this process; file contents are never read.

const MAX_ENTRIES = 5000;

async function entryType(directory, entry) {
  if (entry.isDirectory()) return { type: "dir", link: false };
  if (entry.isFile()) return { type: "file", link: false };
  if (entry.isSymbolicLink()) {
    try {
      const target = await stat(join(directory, entry.name));
      return {
        type: target.isDirectory() ? "dir" : target.isFile() ? "file" : "other",
        link: true,
      };
    } catch {
      return { type: "broken", link: true };
    }
  }
  return { type: "other", link: false };
}

/** Lists one directory: { path, parent, home, entries, truncated }. */
async function listDirectory(request, response) {
  const body = await readJsonBody(request);
  const requested = body?.path;
  if (
    requested !== undefined &&
    (typeof requested !== "string" || !isAbsolute(requested))
  )
    return sendJson(response, 400, {
      error: "Expected { path?: absolute path }.",
    });
  let path;
  try {
    path = await realpath(requested || homedir());
    // A file path opens the folder that holds it.
    if (!(await stat(path)).isDirectory()) path = dirname(path);
  } catch (cause) {
    return sendJson(response, 404, {
      error: `Cannot open ${requested}: ${describeError(cause)}`,
    });
  }
  let dirents;
  try {
    dirents = await readdir(path, { withFileTypes: true });
  } catch (cause) {
    return sendJson(response, 403, {
      error: `Cannot list ${path}: ${describeError(cause)}`,
    });
  }
  const shown = dirents.slice(0, MAX_ENTRIES);
  const entries = await Promise.all(
    shown.map(async (entry) => ({
      name: entry.name,
      ...(await entryType(path, entry)),
    })),
  );
  entries.sort(
    (a, b) =>
      Number(b.type === "dir") - Number(a.type === "dir") ||
      a.name.localeCompare(b.name),
  );
  const parent = dirname(path);
  return sendJson(response, 200, {
    path,
    parent: parent === path ? null : parent,
    home: homedir(),
    entries,
    truncated: dirents.length > shown.length,
  });
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
server.on("upgrade", upgradeTerminalSocket);

/** The Host values of our loopback listener; anything else is DNS rebinding. */
function loopbackHosts() {
  const address = server.address();
  const boundPort =
    typeof address === "object" && address ? address.port : port;
  return new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
}

async function handle(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  // Reject DNS-rebinding requests whose Host is not our loopback listener.
  const allowedHosts = loopbackHosts();
  if (!allowedHosts.has(request.headers.host ?? "")) {
    return sendJson(response, 421, { error: "Unexpected Host header." });
  }

  const staticFile = STATIC_FILES.get(url.pathname);
  if (request.method === "GET" && staticFile) {
    const body = await readFile(
      staticFile.path ?? join(publicRoot, staticFile.file),
    ).catch(() => undefined);
    if (body === undefined)
      return sendJson(response, 404, {
        error:
          "Not found. Run npm install in frontend/ (start.sh does) for the terminal's files.",
      });
    response.writeHead(200, {
      "content-type": staticFile.type,
      "cache-control": "no-store",
      "content-security-policy":
        // Inline styles are allowed for the xterm.js terminal, which sets
        // them on its own elements; scripts stay limited to this origin.
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
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
  // Agent relays authenticate with their session's own token.
  if (request.method === "POST" && url.pathname === "/api/relay")
    return relayReport(request, response);
  if (!authorized(request)) {
    return sendJson(response, 401, { error: "Missing or invalid token." });
  }

  return routeApi(request, response, url);
}

// Page lifecycle log: why the page loaded (first load, reload, restored
// after the browser discarded it) and periodic heartbeats with its memory, so
// a page that goes blank leaves a trail. One JSON line per report, rotated to
// <file>.1 past PAGE_LOG_BYTES.
const PAGE_LOG_BYTES = 2 * 1024 * 1024;
const PAGE_LOG_FIELDS = new Set([
  "event",
  "navigation",
  "wasDiscarded",
  "previous",
  "heap",
  "heapLimit",
  "nodes",
  "history",
  "visibility",
  "view",
  "uptimeMs",
  "message",
]);
let pageLogWrites = Promise.resolve();

async function pageLog(request, response) {
  const body = await readJsonBody(request);
  if (
    typeof body !== "object" ||
    body === null ||
    typeof body.event !== "string"
  )
    return sendJson(response, 400, {
      error: "Expected { event: string, ... }.",
    });
  const entry = { at: new Date().toISOString() };
  for (const [key, value] of Object.entries(body))
    if (PAGE_LOG_FIELDS.has(key)) entry[key] = value;
  const line = `${JSON.stringify(entry).slice(0, 4096)}\n`;
  const path = options["page-log"];
  pageLogWrites = pageLogWrites
    .then(async () => {
      const size = await stat(path).then(
        (info) => info.size,
        () => 0,
      );
      if (size > PAGE_LOG_BYTES) await rename(path, `${path}.1`);
      await appendFile(path, line, { mode: 0o600 });
    })
    .catch((cause) =>
      process.stderr.write(
        `Could not write the page log: ${describeError(cause)}\n`,
      ),
    );
  return sendJson(response, 200, { logged: true });
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
  // Registration doesn't need the MCP child, so it works while that is down.
  if (route === "POST /api/fs/list") return listDirectory(request, response);
  if (route === "POST /api/page-log") return pageLog(request, response);
  if (Object.hasOwn(PROVIDER_ROUTES, route))
    return PROVIDER_ROUTES[route](request, response);
  if (route === "GET /api/events") return events(request, response);
  if (url.pathname.startsWith("/api/history"))
    return routeHistory(request, response, url);
  if (url.pathname.startsWith("/api/projects"))
    return routeProjects(request, response, url);
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

/**
 * Stored call history of one project (?project=<id>), or of calls made with
 * no project: summaries, one stored result, or clearing it all.
 */
/**
 * A page of history summaries, newest first: `limit` of them (all when
 * absent), older than the entry id `before` when given. Reports whether older
 * entries remain, or the error a malformed parameter makes.
 */
async function historyPage(store, params) {
  const limitText = params.get("limit");
  const before = params.get("before");
  const limit = limitText === null ? undefined : Number(limitText);
  const limitOk =
    limit === undefined ||
    (Number.isInteger(limit) && limit >= 1 && limit <= MAX_HISTORY_PAGE);
  if (!limitOk || (before !== null && !HISTORY_ID.test(before)))
    return {
      error: `limit must be 1–${MAX_HISTORY_PAGE} and before an entry id.`,
    };
  const filter = {};
  if (limit !== undefined) filter.limit = limit + 1;
  if (before !== null) filter.beforeId = before;
  const entries = await store.list(filter);
  if (limit === undefined) return { entries, more: false, newest: !before };
  return {
    entries: entries.slice(0, limit),
    more: entries.length > limit,
    newest: before === null,
  };
}

async function routeHistory(request, response, url) {
  const route = `${request.method} ${url.pathname}`;
  const project = url.searchParams.get("project");
  const store = project ? (await projects.get(project))?.history : history;
  if (!store) return sendJson(response, 404, { error: "Unknown project." });
  if (route === "GET /api/history") {
    const page = await historyPage(store, url.searchParams);
    if (page.error) return sendJson(response, 400, { error: page.error });
    return sendJson(response, 200, {
      entries: page.entries,
      more: page.more,
      // Agent calls still running, which history only has once they settle;
      // they belong to the newest page.
      live: project && page.newest ? liveAgentCalls(project) : [],
    });
  }
  if (route === "DELETE /api/history") {
    await store.clear();
    return sendJson(response, 200, { cleared: true });
  }
  // Before the entry-id route below, which the word would also match.
  if (route === "GET /api/history/usage")
    return sendJson(response, 200, { usage: await store.usage() });
  const audit = /^\/api\/history\/([\w-]+)\/audit$/.exec(url.pathname);
  if (request.method === "GET" && audit) {
    const entry = project ? await projects.get(project) : undefined;
    const trail = entry
      ? auditFor(audit[1], await projectTurns(entry))
      : undefined;
    return sendJson(response, 200, { audit: trail ?? null });
  }
  const stored = /^\/api\/history\/([\w-]+)$/.exec(url.pathname);
  if (request.method === "GET" && stored) {
    const result = await store.result(stored[1]);
    return result === undefined
      ? sendJson(response, 404, { error: "No stored result for this call." })
      : sendJson(response, 200, { result });
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
  const project =
    body.project === undefined || body.project === null
      ? undefined
      : await projects.get(body.project);
  if (body.project != null && !project)
    return sendJson(response, 400, { error: "Unknown project." });
  if (mcp.state !== "ready" || !mcp.client) {
    return sendJson(response, 503, {
      error: mcp.failure ?? "The REA MCP server is not ready.",
    });
  }

  const id = nextCallId++;
  const acceptedAt = Date.now();
  const historyId = history.newId(acceptedAt);
  const controller = new AbortController();
  const call = {
    controller,
    name: body.name,
    acceptedAt,
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

  write({ type: "accepted", id, historyId });
  let acquired = false;
  let startedAt = Date.now();
  let settled;
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
    const elapsedMs = Date.now() - startedAt;
    write({ type: "result", result, elapsedMs });
    settled = { outcome: result.isError ? "error" : "ok", elapsedMs, result };
  } catch (cause) {
    const event = {
      type: "error",
      cancelled: controller.signal.aborted,
      code: cause instanceof ProtocolError ? cause.code : undefined,
      message: describeError(cause),
      elapsedMs: Date.now() - startedAt,
    };
    write(event);
    settled = {
      outcome: "error",
      elapsedMs: event.elapsedMs,
      cancelled: event.cancelled,
      failure: event.message,
    };
  } finally {
    if (acquired) releaseSlot();
    calls.delete(id);
    response.end();
  }
  // Recorded after the response ends, so storage never delays the result.
  await recordCall(project, {
    id: historyId,
    name: body.name,
    args: body.arguments ?? {},
    startedAt: acceptedAt,
    source: "workbench",
    session: "workbench",
    ...settled,
  });
}

// ---------------------------------------------------------------------------
// Projects
//
// projects.mjs owns each project's identity and history; assessment.mjs owns
// Evidence links and the assessment file. The bridge records calls into them from
// the page and from agent relays, and tells pages through /api/events.

/** Records one settled call, with its confirmed links, then refreshes the assessment. */
async function recordCall(project, entry) {
  const store = project?.history ?? history;
  const evidence = issuedEvidence(entry.result, entry.args);
  if (evidence.length) entry.evidence = evidence;
  try {
    const links = findLinks(
      entry.args,
      await earlierCalls(store, entry.startedAt, entry.args),
    );
    if (links.length) entry.links = links;
  } catch (cause) {
    process.stderr.write(
      `Could not resolve Evidence links: ${describeError(cause)}\n`,
    );
  }
  let summary;
  try {
    // Pages get exactly what history holds, resultBytes included, so they
    // can load the stored result; a copy of the entry would lack it.
    summary = await store.record(entry);
  } catch (cause) {
    process.stderr.write(
      `Could not store call history: ${describeError(cause)}\n`,
    );
    return;
  }
  broadcast({
    type: "history",
    project: project?.manifest.id ?? null,
    entry: summary,
  });
  if (project) {
    scheduleAssessment(project);
    // The bridge's own survey and map records don't call for another survey.
    if (entry.name !== SURVEY_TOOL && entry.name !== MAP_TOOL)
      scheduleSurvey(project);
    // A new or synced index gets a fresh map.
    if (entry.name === "index_source_graph" && entry.outcome === "ok")
      backgroundCodeMap(project);
  }
}

// The project survey: rene's survey_project_directory, run by the bridge
// through its own MCP connection and recorded in the project's history like
// any other call, so the assessment always rests on a recorded tool result.
// It runs when a folder is opened (if the last survey is missing or older
// than SURVEY_FRESH_MS), when the user asks, and in the background after calls
// settle (a minute after the last one, at most every SURVEY_MIN_GAP_MS),
// because tools such as extract_artifact change what the folder holds.
const SURVEY_FRESH_MS = 10 * 60_000;
const SURVEY_QUIET_MS = 60_000;
const SURVEY_MIN_GAP_MS = 5 * 60_000;
const surveying = new Map();
const surveyTimers = new Map();
const lastSurveyAt = new Map();

/**
 * Runs one rene tool for a project through the bridge's MCP connection and
 * records it in the project's history as a workbench call. `argsFor` gets
 * the project's verified folder. Concurrent runs of the same tool for the
 * same project share one call (`running` holds them). Resolves to the outcome.
 */
function runWorkbenchCall(project, name, argsFor, running) {
  const id = project.manifest.id;
  const current = running.get(id);
  if (current) return current;
  const run = (async () => {
    const folder = await projects.verify(project);
    if (mcp.state !== "ready" || !mcp.client)
      throw new Error(mcp.failure ?? "The REA MCP server is not ready.");
    const startedAt = Date.now();
    const args = argsFor(folder);
    let settled;
    try {
      const result = await mcp.client.callTool(
        { name, arguments: args },
        { timeout: requestTimeoutMs, resetTimeoutOnProgress: true },
      );
      settled = { outcome: result.isError ? "error" : "ok", result };
    } catch (cause) {
      settled = { outcome: "error", failure: describeError(cause) };
    }
    await recordCall(project, {
      id: history.newId(startedAt),
      name,
      args,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      source: "workbench",
      session: "workbench",
      ...settled,
    });
    return settled.outcome;
  })().finally(() => running.delete(id));
  running.set(id, run);
  return run;
}

/** Runs the survey for a project now; concurrent requests share one run. */
const runSurvey = (project) =>
  runWorkbenchCall(
    project,
    SURVEY_TOOL,
    (folder) => ({ path: folder }),
    surveying,
  ).finally(() => lastSurveyAt.set(project.manifest.id, Date.now()));

const backgroundSurvey = (project) =>
  void runSurvey(project).catch((cause) =>
    process.stderr.write(
      `Could not survey ${project.manifest.path}: ${describeError(cause)}\n`,
    ),
  );

/** Surveys a project in the background after its calls go quiet. */
function scheduleSurvey(project) {
  const id = project.manifest.id;
  clearTimeout(surveyTimers.get(id));
  const wait = Math.max(
    SURVEY_QUIET_MS,
    (lastSurveyAt.get(id) ?? 0) + SURVEY_MIN_GAP_MS - Date.now(),
  );
  surveyTimers.set(
    id,
    setTimeout(() => {
      surveyTimers.delete(id);
      backgroundSurvey(project);
    }, wait).unref(),
  );
}

/** Surveys a project that was just opened unless its last survey is recent. */
async function surveyIfStale(project) {
  void codeMapIfStale(project);
  const latest = await latestSurvey(project.history).catch(() => undefined);
  if (latest && Date.now() - latest.entry.startedAt < SURVEY_FRESH_MS) return;
  backgroundSurvey(project);
}

// The code map: rene's map_source_graph over the project's CodeGraph index,
// run by the bridge and recorded like the survey, for the assessment's Code
// map section. It never builds an index (that is index_source_graph, which
// is heavy and the agent's or user's call): it runs when a project with an
// index is opened and its last map is older than CODE_MAP_FRESH_MS, and
// right after an index_source_graph call succeeds.
const CODE_MAP_FRESH_MS = 60 * 60_000;
const mapping = new Map();

const backgroundCodeMap = (project) =>
  void runWorkbenchCall(
    project,
    MAP_TOOL,
    (folder) => ({ project_path: folder }),
    mapping,
  ).catch((cause) =>
    process.stderr.write(
      `Could not map ${project.manifest.path}: ${describeError(cause)}\n`,
    ),
  );

/** Maps an opened project's index unless it has none or its map is recent. */
async function codeMapIfStale(project) {
  if (!existsSync(join(project.manifest.path, ".codegraph"))) return;
  const latest = await latestCodeMap(project.history).catch(() => undefined);
  if (latest && Date.now() - latest.entry.startedAt < CODE_MAP_FRESH_MS) return;
  backgroundCodeMap(project);
}

const ASSESSMENT_DELAY_MS = 1500;
const assessmentTimers = new Map();

/** Rewrites the project's assessment shortly after its calls stop settling. */
function scheduleAssessment(project) {
  if (project.manifest.assessment !== "enabled") return;
  const id = project.manifest.id;
  clearTimeout(assessmentTimers.get(id));
  assessmentTimers.set(
    id,
    setTimeout(() => {
      assessmentTimers.delete(id);
      void refreshAssessment(project).catch((cause) =>
        process.stderr.write(
          `Could not update ${ASSESSMENT_FILE} for ${project.manifest.path}: ${describeError(cause)}\n`,
        ),
      );
    }, ASSESSMENT_DELAY_MS),
  );
}

async function refreshAssessment(project) {
  const folder = await projects.verify(project);
  const outcome = await writeAssessment(folder, project.manifest.name, {
    summary: summarize(await project.history.list()),
    survey: await latestSurvey(project.history),
    codeMap: await latestCodeMap(project.history),
    turns: (await projectTurns(project)).map(turnSummary),
    topics: await projectTopics(project),
  });
  // Pages reread the file only when it changed.
  if (outcome === "created" || outcome === "updated")
    broadcast({ type: "assessment", project: project.manifest.id, outcome });
  return outcome;
}

/** What the page shows about a project's assessment. */
async function assessmentState(project) {
  let folder;
  try {
    folder = await projects.verify(project);
  } catch (cause) {
    return { choice: project.manifest.assessment, error: cause.message };
  }
  return {
    choice: project.manifest.assessment,
    file: join(folder, ASSESSMENT_FILE),
    text: await readAssessment(folder),
  };
}

async function routeProjects(request, response, url) {
  const route = `${request.method} ${url.pathname}`;
  try {
    if (route === "GET /api/projects")
      return sendJson(response, 200, { projects: await projects.list() });
    if (route === "POST /api/projects/open") {
      const body = await readJsonBody(request);
      const manifest = await projects.openPath(body?.path);
      // The file may predate history it hasn't seen (a restart, an earlier
      // version): opening rebuilds it from the stored calls.
      const project = await projects.get(manifest.id);
      void catchUpConversations(project)
        .catch(() => {})
        .finally(() => scheduleAssessment(project));
      void surveyIfStale(project);
      return sendJson(response, 200, manifest);
    }
    const usageRoute =
      /^\/api\/projects\/([0-9a-f]{16}|all)\/usage(?:\/(turns|turn))?$/.exec(
        url.pathname,
      );
    if (usageRoute && request.method === "GET")
      return await routeUsage(response, url, usageRoute[1], usageRoute[2]);
    const topicsRoute = /^\/api\/projects\/([0-9a-f]{16})\/topics$/.exec(
      url.pathname,
    );
    if (topicsRoute && request.method === "GET") {
      const project = await projects.get(topicsRoute[1]);
      if (!project)
        return sendJson(response, 404, { error: "Unknown project." });
      return sendJson(response, 200, await projectTopics(project));
    }
    const conversations =
      /^\/api\/projects\/([0-9a-f]{16})\/conversations(?:\/([\w-]+)\/(\d+))?$/.exec(
        url.pathname,
      );
    if (conversations && request.method === "GET") {
      const project = await projects.get(conversations[1]);
      if (!project)
        return sendJson(response, 404, { error: "Unknown project." });
      const turns = await projectTurns(project);
      if (conversations[2] === undefined)
        return sendJson(response, 200, { turns: turns.map(turnSummary) });
      const turn = turns.find(
        (candidate) =>
          candidate.session === conversations[2] &&
          candidate.index === Number(conversations[3]),
      );
      return turn
        ? sendJson(response, 200, { turn })
        : sendJson(response, 404, { error: "No such conversation turn." });
    }
    // The user asks for a fresh assessment: survey now, then rebuild.
    const run = /^\/api\/projects\/([0-9a-f]{16})\/assessment\/run$/.exec(
      url.pathname,
    );
    if (run && request.method === "POST") {
      const project = await projects.get(run[1]);
      if (!project)
        return sendJson(response, 404, { error: "Unknown project." });
      try {
        await runSurvey(project);
        if (project.manifest.assessment === "enabled")
          await refreshAssessment(project);
      } catch (cause) {
        return sendJson(response, 502, {
          ...(await assessmentState(project)),
          error: `The survey didn't run: ${describeError(cause)}`,
        });
      }
      return sendJson(response, 200, await assessmentState(project));
    }
    const match = /^\/api\/projects\/([0-9a-f]{16})\/assessment$/.exec(
      url.pathname,
    );
    const project = match && (await projects.get(match[1]));
    if (match && !project)
      return sendJson(response, 404, { error: "Unknown project." });
    if (project && request.method === "GET")
      return sendJson(response, 200, await assessmentState(project));
    if (project && request.method === "POST") {
      // The page asks once per project; only "enabled" writes into the folder.
      const body = await readJsonBody(request);
      if (typeof body?.enabled !== "boolean")
        return sendJson(response, 400, {
          error: "Expected { enabled: boolean }.",
        });
      await projects.update(project.manifest.id, {
        assessment: body.enabled ? "enabled" : "declined",
      });
      if (body.enabled) await refreshAssessment(project);
      return sendJson(response, 200, await assessmentState(project));
    }
  } catch (cause) {
    if (cause instanceof ProjectError)
      return sendJson(response, 400, { error: cause.message });
    throw cause;
  }
  return sendJson(response, 404, { error: "Not found." });
}

// ---------------------------------------------------------------------------
// Agent sessions and their reports
//
// Each agent session gets its own reporting token, written to a private file
// `rene call` reads (REA_HISTORY_REPORT). A report is accepted only with a
// token the bridge issued, and is recorded in that session's project; the
// page's token isn't needed or given to the agent.

/** token -> { project, session, agent, live: Map<ref, entry> } */
const relaySessions = new Map();

/** Opens the folder's project and prepares the reporting an agent session uses. */
async function agentSession(cwd, agentId) {
  let project;
  try {
    const manifest = await projects.openPath(cwd);
    project = await projects.get(manifest.id);
    scheduleAssessment(project);
    void surveyIfStale(project);
  } catch (cause) {
    if (cause instanceof ProjectError) throw new TerminalError(cause.message);
    throw cause;
  }
  const session = `agent-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const relayToken = randomBytes(24).toString("base64url");
  const directory = options["agent-dir"];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = join(directory, "relay-report.json");
  const address = server.address();
  await writeFile(
    `${report}.tmp`,
    JSON.stringify({
      url: `http://127.0.0.1:${address.port}/api/relay`,
      token: relayToken,
    }),
    { mode: 0o600 },
  );
  await rename(`${report}.tmp`, report);
  const relay = { project: project.manifest.id, session, live: new Map() };
  relaySessions.set(relayToken, relay);
  return {
    relay,
    relayToken,
    // The command `rene` runs in the agent's shell.
    rea: reaCommand([]),
    project: project.manifest.id,
    session,
    // Claude Code gets a fresh session id; its transcripts are followed by
    // folder (startFollowing), which also catches a resumed conversation.
    // Other agents' conversations aren't captured yet.
    conversationId: agentId === "claude" ? randomUUID() : undefined,
    // `rene call` in the agent's shell reports through this file.
    report,
    instructions: agentInstructions(
      project.manifest.assessment === "enabled" ? ASSESSMENT_FILE : undefined,
    ),
  };
}

// ---------------------------------------------------------------------------
// Agent conversations (conversations.mjs owns parsing, storage and linking)

/** workbench session -> { follower, project } while an agent runs. */
const following = new Map();

/**
 * Follows the conversations agents run in the project folder while an agent
 * runs: the one it starts, one the user resumes or begins with /clear, and
 * Copilot CLI sessions alike.
 */
async function startFollowing(link) {
  if (!link.project) return;
  const project = await projects.get(link.project);
  following.set(link.session, {
    project,
    follower: followConversations({
      store: project.conversations,
      environment: settings.environment(process.env),
      folder: project.manifest.path,
      // A second's slack: the agent may write before this call returns.
      since: Date.now() - 1000,
      onEvents: () => conversationChanged(project, link.session),
    }),
  });
}

async function stopFollowing(session) {
  const followed = following.get(session);
  if (!followed) return;
  following.delete(session);
  await followed.follower.stop();
}

function conversationChanged(project, session) {
  broadcast({ type: "conversation", project: project.manifest.id, session });
  scheduleAssessment(project);
}

/**
 * Reads what the folder's transcripts gained while nothing followed them
 * (the bridge was down, or a conversation ran past a restart): every
 * transcript changed since the project was first opened.
 */
async function catchUpConversations(project) {
  await followConversations({
    store: project.conversations,
    environment: settings.environment(process.env),
    folder: project.manifest.path,
    since: project.manifest.createdAt,
    onEvents: () => conversationChanged(project, null),
  }).stop();
}

/** Every conversation turn in a project, oldest first, tied to recorded calls. */
async function projectTurns(project) {
  const history = await project.history.list();
  const turns = [];
  for (const meta of await project.conversations.sessions())
    turns.push(
      ...conversationTurns(
        meta,
        await project.conversations.events(meta.session),
        history,
      ),
    );
  return turns;
}

/** The project's thread > topic > turn > call tree (topics.mjs). */
async function projectTopics(project) {
  const history = await project.history.list();
  return topicTree(
    await currentTopics(project.history),
    await projectTurns(project),
    history,
  );
}

/** A conversation's name in the usage view: its first request, agent and day. */
function conversationLabel({ meta, events }) {
  const first = events.find((event) => event.kind === "prompt");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim();
  const about = [meta.agent, first?.at?.slice(0, 10)].filter(Boolean);
  return `${text.length > 70 ? `${text.slice(0, 70)}…` : text || meta.session}${about.length ? ` (${about.join(", ")})` : ""}`;
}

/**
 * The usage view (usageView.mjs owns the queries): a slice of one project's
 * calls, or every project's ("all"), with each task's estimate against
 * actual; the turns the filtered calls were made in; or one turn's rows.
 */
async function routeUsage(response, url, which, part) {
  const chosen =
    which === "all"
      ? await Promise.all(
          (await projects.list()).map((manifest) => projects.get(manifest.id)),
        )
      : [await projects.get(which)];
  if (chosen.some((project) => !project))
    return sendJson(response, 404, { error: "Unknown project." });
  let request;
  try {
    request = parseUsageRequest(url.searchParams);
  } catch (cause) {
    if (cause instanceof UsageQueryError)
      return sendJson(response, 400, { error: cause.message });
    throw cause;
  }
  const current = [];
  for (const project of chosen.filter(Boolean))
    current.push({ project, ...(await currentUsage(project)) });
  const stores = current.map(({ project }) => ({
    project: project.manifest.path,
    store: project.usage,
  }));
  if (part === "turn") {
    const [status, body] = usageTurnAnswer(current, url.searchParams);
    return sendJson(response, status, body);
  }
  return sendJson(
    response,
    200,
    part === "turns"
      ? await usageTurnsAnswer(current, stores, request)
      : await usageSliceAnswer(current, stores, request),
  );
}

/** One turn's rows, from its own project's store: [status, body]. */
function usageTurnAnswer(current, params) {
  const conversation = params.get("conversation");
  const turnText = params.get("turn");
  const turnAt = turnText ? Number(turnText) : null;
  if (!conversation || (turnAt !== null && !Number.isSafeInteger(turnAt)))
    return [400, { error: "Expected ?conversation=<id>&turn=<ms>." }];
  if (current.length !== 1)
    return [400, { error: "A turn is read from its own project, not all." }];
  try {
    return [
      200,
      usageTurnRows(current[0].project.usage, { conversation, turnAt }),
    ];
  } catch (cause) {
    return [502, { error: describeError(cause) }];
  }
}

/** The turns the filtered calls were in, each with its request and its place in History. */
async function usageTurnsAnswer(current, stores, request) {
  const found = usageTurns(stores, request);
  // session -> its turns (conversations.mjs's) by request time, the store's turn_at.
  const known = new Map();
  for (const { project } of current)
    for (const turn of await projectTurns(project)) {
      if (!known.has(turn.session)) known.set(turn.session, new Map());
      known.get(turn.session).set(Date.parse(turn.at), {
        project: project.manifest.id,
        index: turn.index,
        prompt: turn.prompt,
      });
    }
  return {
    ...found,
    turns: found.turns.map((turn) => {
      const named = known.get(turn.conversation)?.get(turn.turnAt);
      return {
        ...turn,
        projectId: named?.project ?? null,
        index: named?.index ?? null,
        prompt: named?.prompt ?? null,
      };
    }),
  };
}

/** The slice, named, with each task's estimate against actual. */
async function usageSliceAnswer(current, stores, request) {
  const titles = new Map();
  const conversations = new Map();
  for (const { project, topics } of current) {
    for (const [id, topic] of topics ?? []) titles.set(id, topic.title);
    for (const conversation of await projectConversations(project))
      conversations.set(
        conversation.meta.session,
        conversationLabel(conversation),
      );
  }
  const slice = usageSlice(stores, request, {
    label: (dimension, value) =>
      dimension === "topic"
        ? titles.get(value)
        : dimension === "conversation"
          ? conversations.get(value)
          : undefined,
  });
  // Estimate against actual, for the tasks the filters leave in.
  const topicFilter = request.filters.topic;
  const tasks = current
    .flatMap(({ project, topics, actuals, now }) =>
      taskProgress(topics, actuals, now).map((task) => ({
        ...task,
        project: project.manifest.path,
      })),
    )
    .filter(
      (task) =>
        task.accuracy && (topicFilter === undefined || task.id === topicFilter),
    )
    .sort((a, b) => b.startedAt - a.startedAt);
  return {
    ...slice,
    projects: current.map(({ project }) => ({
      id: project.manifest.id,
      path: project.manifest.path,
    })),
    tasks,
    titles: Object.fromEntries(titles),
    dimensions: Object.fromEntries(
      Object.entries(DIMENSIONS).map(([name, { label }]) => [name, label]),
    ),
    measures: Object.fromEntries(
      Object.entries(MEASURES).map(([name, { label, wasted }]) => [
        name,
        { label, wasted },
      ]),
    ),
    asOf: Date.now(),
  };
}

/** A turn as the History list shows it: request, calls and conclusion. */
const turnSummary = (turn) => ({
  session: turn.session,
  agent: turn.agent,
  index: turn.index,
  at: turn.at,
  prompt: turn.prompt,
  calls: turn.events
    .filter((event) => event.kind === "tool_use" && event.rea)
    .map((event) => ({ tool: event.tool, historyId: event.historyId })),
  conclusion:
    turn.events.findLast((event) => event.kind === "reply")?.text ?? null,
});

/** Agent calls of a project that have started and not settled. */
const liveAgentCalls = (project) =>
  [...relaySessions.values()]
    .filter((relay) => relay.project === project)
    .flatMap((relay) => [...relay.live.values()]);

function relaySessionFor(request) {
  const supplied = String(request.headers["x-rea-relay-token"] ?? "");
  for (const [token, relay] of relaySessions) {
    const expected = Buffer.from(token);
    const given = Buffer.from(supplied);
    if (given.length === expected.length && timingSafeEqual(given, expected))
      return relay;
  }
  return undefined;
}

/** One report from an agent's relay: a call started or settled. */
async function relayReport(request, response) {
  const relay = relaySessionFor(request);
  if (!relay) return sendJson(response, 401, { error: "Unknown relay." });
  const event = await readJsonBody(request, MAX_RELAY_BODY_BYTES);
  if (typeof event?.ref !== "string" || event.ref.length > 200)
    return sendJson(response, 400, { error: "Expected a call report." });
  if (event.type === "started" && typeof event.name === "string") {
    const startedAt = Number.isFinite(event.startedAt)
      ? event.startedAt
      : Date.now();
    const entry = {
      id: history.newId(startedAt),
      name: event.name,
      args:
        event.args &&
        typeof event.args === "object" &&
        !Array.isArray(event.args)
          ? event.args
          : {},
      startedAt,
      outcome: "running",
      source: "agent",
      session: relay.session,
      agent: relay.agent,
    };
    relay.live.set(event.ref, entry);
    broadcast({ type: "history", project: relay.project, entry });
    return sendJson(response, 200, { id: entry.id });
  }
  const started = relay.live.get(event.ref);
  if (event.type === "settled" && started) {
    relay.live.delete(event.ref);
    const settled = {
      ...started,
      outcome: event.outcome === "ok" ? "ok" : "error",
      elapsedMs: Number.isFinite(event.elapsedMs) ? event.elapsedMs : undefined,
    };
    if (event.result !== undefined) settled.result = event.result;
    if (event.resultOmitted === true) {
      settled.resultOmitted = true;
      settled.resultBytes = event.resultBytes;
      settled.untrusted = event.untrusted === true;
    }
    if (event.cancelled === true) settled.cancelled = true;
    if (typeof event.failure === "string") settled.failure = event.failure;
    sendJson(response, 200, { id: settled.id });
    await recordCall(await projects.get(relay.project), settled);
    return;
  }
  return sendJson(response, 400, { error: "Unknown or unmatched report." });
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
    catalogVersion: mcp.catalogVersion,
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

/** Whether `value` is this bridge's page token, compared in constant time. */
function isPageToken(value) {
  const supplied = Buffer.from(String(value ?? ""));
  return (
    supplied.length === tokenBytes.length &&
    timingSafeEqual(supplied, tokenBytes)
  );
}

function authorized(request) {
  return isPageToken(request.headers["x-rea-token"]);
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body is too large.");
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

/** Removes the pid file only while it still records this process. */
async function releasePidFile() {
  const path = options["pid-file"];
  if (!path) return;
  try {
    const [recorded] = (await readFile(path, "utf8")).split("\n");
    if (recorded === String(process.pid)) await unlink(path);
  } catch {
    // Missing or unreadable: nothing of ours to remove.
  }
}

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const listener of listeners) listener.end();
  for (const socket of terminalSockets.clients) socket.terminate();
  terminalSockets.close();
  // The last of each followed transcript is kept before the bridge goes.
  await Promise.allSettled([...following.keys()].map(stopFollowing));
  terminal.close();
  server.close();
  await stopMcp();
  // History stores close their databases once nothing more will be recorded.
  await Promise.allSettled([history.close(), projects.close()]);
  await releasePidFile();
  process.exit(exitCode);
}
process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

server.on("error", (cause) => {
  process.stderr.write(
    cause.code === "EADDRINUSE"
      ? `Port ${port} is already in use. Stop the program using it, or pass --port.\n`
      : `The bridge could not listen: ${describeError(cause)}\n`,
  );
  void shutdown(1);
});

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
