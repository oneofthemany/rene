// How a workbench agent reaches rene's tools: its toolkit.
//
//   cli  `rea call <tool> '<json>'` in the agent's shell (the default). The
//        session gets a `rea` command on its PATH and one `rea daemon`, so
//        every call shares a session (a target opened by one call stays open
//        for the next), named to `rea call` by REA_DAEMON_SOCKET.
//   mcp  rene as an MCP server through the relay (relay.mjs).
//
// REA_AGENT_TOOLKIT=mcp in the workbench's environment selects MCP; MCP stays
// available until the move to the command line is complete.
//
// The daemon is an owned process (src/process supervision) started through
// the same rea command as everything else, so it runs in the container when
// rea does. It is started with --exit-with-stdin and its stdin held open:
// closing that pipe ends it on either side of the container boundary, where a
// signal to the host-side `podman exec` might not reach it.

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { cleanupOwnedProcessGroup } from "../dist/process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../dist/process/ProviderProcess.js";

/** How long a daemon may take to open its socket; the container adds startup time. */
const DAEMON_START_MS = 60_000;
/** How long a daemon may take to close its session once its stdin ends. */
const DAEMON_CLOSE_MS = 10_000;
const MAX_STDERR_BYTES = 8 * 1024;
// sun_path holds 108 bytes on Linux, 104 on macOS.
const MAX_SOCKET_PATH = 100;

/** The session's toolkit from the workbench's environment. */
export const agentToolkit = (env) =>
  env.REA_AGENT_TOOLKIT === "mcp" ? "mcp" : "cli";

const shellQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;

/**
 * Writes `<directory>/bin/rea`, which runs the workbench's rea command, so
 * the agent's shell has `rea` whether or not it is installed.
 */
async function writeReaShim(directory, rea) {
  const bin = join(directory, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const path = join(bin, "rea");
  const temporary = `${path}.${process.pid}.tmp`;
  const command = [rea.command, ...rea.args].map(shellQuote).join(" ");
  await writeFile(temporary, `#!/bin/sh\nexec ${command} "$@"\n`, {
    mode: 0o700,
  });
  await rename(temporary, path);
  return bin;
}

/**
 * Stops an owned daemon: its stdin closes, then the supervisor confirms the
 * stop. A daemon that had to be killed leaves its socket file, removed here.
 */
async function stopDaemon({ child, supervisor, socket }) {
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end();
    await supervisor.waitForExit(DAEMON_CLOSE_MS);
  }
  const result = await supervisor.stop();
  if (result.status === "incomplete")
    throw new Error(
      `The session's rea daemon could not be stopped: ${result.reason}`,
    );
  supervisor.dispose();
  await rm(socket, { force: true });
}

/** Resolves once `socket` exists; rejects if the daemon exits or takes too long. */
function daemonReady(child, socket, stderr) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (existsSync(socket)) {
        clearInterval(timer);
        child.off("exit", exited);
        resolve();
      } else if (Date.now() - started > DAEMON_START_MS) {
        clearInterval(timer);
        child.off("exit", exited);
        reject(
          new Error(
            `rea daemon didn't open ${socket} within ${DAEMON_START_MS / 1000} s.${stderr()}`,
          ),
        );
      }
    }, 100);
    const exited = (code, signal) => {
      clearInterval(timer);
      reject(
        new Error(
          `rea daemon exited (${signal ?? `status ${code}`}) before opening its socket.${stderr()}`,
        ),
      );
    };
    child.once("exit", exited);
  });
}

/**
 * Prepares the cli toolkit for one agent session: the `rea` shim and the
 * session's daemon. Returns the environment the agent needs and the stop
 * that ends the daemon.
 * @param {{ rea: { command: string, args: string[] }, directory: string, env: NodeJS.ProcessEnv }} options
 */
export async function startCliToolkit({ rea, directory, env }) {
  const bin = await writeReaShim(directory, rea);
  const socket = join(directory, `r-${randomBytes(4).toString("hex")}.sock`);
  if (socket.length > MAX_SOCKET_PATH)
    throw new Error(
      `The agent folder's path is too long for a socket (${socket.length} > ${MAX_SOCKET_PATH} bytes); start the workbench with a shorter --agent-dir.`,
    );
  const spawned = await spawnOwnedProviderProcess({
    command: rea.command,
    arguments: [...rea.args, "daemon", "--socket", socket, "--exit-with-stdin"],
    runId: randomUUID(),
    // The command may be a launch script (the container's rea), not rea itself.
    expectedCommand: null,
    stdin: "pipe",
    hostEnvironment: env,
  });
  const child = spawned.process;
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    { captureStdout: false, maxDiagnosticBytes: MAX_STDERR_BYTES },
  );
  const daemon = { child, supervisor, socket };
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
  });
  child.stdin?.on("error", () => {});
  try {
    await daemonReady(child, socket, () =>
      stderr.trim() ? ` It said: ${stderr.trim()}` : "",
    );
  } catch (cause) {
    await stopDaemon(daemon).catch(() => {});
    throw cause;
  }
  let stopping;
  return {
    env: {
      PATH: [bin, env.PATH].filter(Boolean).join(delimiter),
      REA_DAEMON_SOCKET: socket,
    },
    stop: () => (stopping ??= stopDaemon(daemon)),
  };
}
